/**
 * @fileoverview The vector side of the store: one packed Float32Array of
 * unit-length embeddings, held in RAM and persisted as a single blob.
 *
 * Why brute force: at personal scale the whole set is tiny. 1,000 memories at
 * 384 dimensions is 1.5 MB of float and ~384k multiply-adds per query, which is
 * well under a millisecond in JS. An ANN index would add a build step, a
 * rebuild-on-delete problem and a recall cliff, and buy nothing until roughly
 * 10^5 memories — far past the point where this moves to SQLite anyway.
 *
 * Slot discipline: `slots[id] = n` means the vector lives at
 * `data[n*dim .. (n+1)*dim)`. Deletion moves the last slot into the hole and
 * truncates, so the array stays dense and no tombstones accumulate.
 */

export interface VectorBlobHeader {
  /** Bumped when the on-disk layout changes. */
  version: number
  dim: number
  modelId: string
  count: number
}

/** What a load found, so the service can report and repair. */
export type VectorLoadStatus =
  | "ok"
  | "absent"
  /** Fewer bytes than the header claims: an interrupted write. */
  | "truncated"
  /** Header unreadable or layout version unknown. */
  | "corrupt"
  /** Written by a different embedding model, so the vectors mean nothing now. */
  | "model_changed"
  /** Header fine, but it does not line up with the index the store holds. */
  | "mismatched"

export const VECTOR_BLOB_VERSION = 1
const MAGIC = 0x4d454d56 // "MEMV"
const HEADER_BYTES = 64

/**
 * Serialize vectors: a fixed 64-byte header then the packed floats.
 * Little-endian, which every phone we target is.
 */
export function packVectors(header: Omit<VectorBlobHeader, "version">, data: Float32Array): Uint8Array {
  const modelBytes = new TextEncoder().encode(header.modelId).slice(0, 32)
  const out = new Uint8Array(HEADER_BYTES + data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, VECTOR_BLOB_VERSION, true)
  view.setUint32(8, header.dim, true)
  view.setUint32(12, header.count, true)
  view.setUint32(16, modelBytes.length, true)
  out.set(modelBytes, 20)
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), HEADER_BYTES)
  return out
}

export interface UnpackResult {
  status: VectorLoadStatus
  header?: VectorBlobHeader
  data?: Float32Array
}

export function unpackVectors(bytes: Uint8Array | null, expectModelId: string): UnpackResult {
  if (!bytes || bytes.length === 0) return {status: "absent"}
  if (bytes.length < HEADER_BYTES) return {status: "corrupt"}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== MAGIC) return {status: "corrupt"}
  const version = view.getUint32(4, true)
  if (version !== VECTOR_BLOB_VERSION) return {status: "corrupt"}
  const dim = view.getUint32(8, true)
  const count = view.getUint32(12, true)
  const modelLen = view.getUint32(16, true)
  if (dim === 0 || dim > 8192 || modelLen > 32) return {status: "corrupt"}
  const modelId = new TextDecoder().decode(bytes.subarray(20, 20 + modelLen))
  const header: VectorBlobHeader = {version, dim, count, modelId}
  if (modelId !== expectModelId) return {status: "model_changed", header}

  const need = count * dim * 4
  const have = bytes.length - HEADER_BYTES
  if (have < need) {
    // Keep whatever whole vectors did land: a truncated write loses the tail,
    // not the file, and the missing ones just go back on the embed queue.
    const whole = Math.floor(have / (dim * 4))
    const salvaged = new Float32Array(whole * dim)
    copyInto(salvaged, bytes, whole * dim)
    return {status: "truncated", header: {...header, count: whole}, data: salvaged}
  }
  const data = new Float32Array(count * dim)
  copyInto(data, bytes, count * dim)
  return {status: "ok", header, data}
}

function copyInto(target: Float32Array, bytes: Uint8Array, floats: number) {
  // The blob's byteOffset is not guaranteed to be 4-aligned, so copy via DataView
  // rather than constructing a Float32Array over the same buffer.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < floats; i++) target[i] = view.getFloat32(HEADER_BYTES + i * 4, true)
}

/** Dot product of two unit-length vectors, i.e. cosine similarity. */
export function cosine(a: Float32Array, aOffset: number, b: Float32Array, dim: number): number {
  let sum = 0
  for (let i = 0; i < dim; i++) sum += a[aOffset + i] * b[i]
  return sum
}

/**
 * The packed vector set. Dense, append-only except for the swap-delete.
 * Pure data structure: it knows nothing about storage or memories.
 */
export class VectorSet {
  private data: Float32Array
  private count = 0
  /** slot -> memory id, the inverse of the store's id -> slot map. */
  private owners: string[] = []

  constructor(
    readonly dim: number,
    capacity = 64,
  ) {
    this.data = new Float32Array(dim * Math.max(1, capacity))
  }

  get size() {
    return this.count
  }

  /** Rebuild from a loaded blob. `owners` must be in slot order. */
  static fromPacked(dim: number, data: Float32Array, owners: string[]): VectorSet {
    const set = new VectorSet(dim, Math.max(1, owners.length))
    const usable = Math.min(owners.length, Math.floor(data.length / dim))
    set.data.set(data.subarray(0, usable * dim))
    set.count = usable
    set.owners = owners.slice(0, usable)
    return set
  }

  /** Append a vector, returning its slot. */
  push(id: string, vector: Float32Array): number {
    if (vector.length !== this.dim) throw new Error(`vector has ${vector.length} dimensions, expected ${this.dim}`)
    if ((this.count + 1) * this.dim > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, (this.count + 1) * this.dim))
      grown.set(this.data)
      this.data = grown
    }
    this.data.set(vector, this.count * this.dim)
    this.owners.push(id)
    return this.count++
  }

  replace(slot: number, vector: Float32Array) {
    if (slot < 0 || slot >= this.count) throw new Error(`slot ${slot} out of range`)
    this.data.set(vector, slot * this.dim)
  }

  /**
   * Remove a slot by moving the last one into it.
   * Returns the id that moved and its new slot, so the caller can fix its map.
   */
  removeSlot(slot: number): {movedId: string; newSlot: number} | null {
    if (slot < 0 || slot >= this.count) return null
    const last = this.count - 1
    if (slot !== last) {
      this.data.copyWithin(slot * this.dim, last * this.dim, (last + 1) * this.dim)
      this.owners[slot] = this.owners[last]
    }
    this.owners.pop()
    this.count--
    return slot !== last ? {movedId: this.owners[slot], newSlot: slot} : null
  }

  /** Cosine of `query` against every slot, in slot order. */
  scoreAll(query: Float32Array): Float32Array {
    const out = new Float32Array(this.count)
    for (let s = 0; s < this.count; s++) out[s] = cosine(this.data, s * this.dim, query, this.dim)
    return out
  }

  score(slot: number, query: Float32Array): number {
    return cosine(this.data, slot * this.dim, query, this.dim)
  }

  ownerOf(slot: number): string | undefined {
    return this.owners[slot]
  }

  /** The packed bytes to persist. */
  pack(modelId: string): Uint8Array {
    return packVectors({dim: this.dim, modelId, count: this.count}, this.data.subarray(0, this.count * this.dim))
  }

  ownerList(): string[] {
    return this.owners.slice()
  }
}
