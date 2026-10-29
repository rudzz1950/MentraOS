/**
 * @fileoverview The memory service.
 *
 * One class, one interface, and a storage layout that is an implementation
 * detail. Callers see `add`, `search`, `list`, `get`, `update`, `delete`,
 * `exportAll` and `importAll` — nothing about key-value stores, blobs or
 * vector slots. That is deliberate: when memory moves to a native SQLite
 * module, this file is replaced and no caller changes.
 *
 * Why brute force is enough: a thousand memories at 384 dimensions is under
 * half a million multiply-adds, which is sub-millisecond. An approximate
 * index would be complexity bought for a problem nobody has at personal scale.
 *
 * Retrieval is hybrid on purpose. Embeddings find "deck for the investors"
 * when you ask about "the pitch", and they are hopeless at names, dates and
 * numbers. The exact-match term is what keeps "Tanu" and "₹13 lakh" findable.
 */

import {FakeEmbeddingProvider, type EmbeddingProvider, normalize, tokenize} from "./embeddings"
import {EmbeddingUnavailableError} from "./embeddings"
import {MemoryBlobStore, MemoryKeyValueStore, type BlobStore, type KeyValueStore} from "./ports"
import {combine, exactScore, keywordScore, memoryTokens, recencyScore} from "./scoring"
import {detectSensitive, SensitiveInferenceError} from "./sensitive"
import {
  ALWAYS_LOADED_CLASSES,
  type Memory,
  type MemoryClass,
  type MemoryExport,
  type MemoryInput,
  type MemoryPatch,
  type SearchOptions,
  type SearchResult,
} from "./types"
import {unpackVectors, VectorSet, type VectorLoadStatus} from "./vectors"

const KEY_PREFIX = "mem:"
const KEY_INDEX = "mem:index"
const BLOB_VECTORS = "mem:vectors"

/** Persisted alongside the rows so a reload knows which slot held which memory. */
interface IndexRecord {
  version: 1
  /** Memory ids in slot order. A memory with no vector is absent from this list. */
  slots: string[]
  /** Every memory id, including unembedded ones. */
  ids: string[]
}

export interface MemoryServiceOptions {
  storage?: KeyValueStore
  blobs?: BlobStore
  provider?: EmbeddingProvider
  /**
   * Consent. False keeps every memory local and search falls back to keywords.
   * The provider is never called while this is false.
   */
  embeddingsEnabled?: boolean
  /** Injected so tests are deterministic. */
  now?: () => number
  idgen?: () => string
}

export interface MemoryStats {
  total: number
  embedded: number
  queued: number
  vectorStatus: VectorLoadStatus | "unloaded"
  embeddingsEnabled: boolean
}

/**
 * The seam. A native SQLite module implements this and the class below is
 * deleted; callers are written against this type, never against the class.
 */
export interface MemoryStore {
  add(input: MemoryInput): Promise<Memory>
  get(id: string): Promise<Memory | null>
  list(opts?: {classes?: MemoryClass[]; includeExpired?: boolean}): Promise<Memory[]>
  search(query: string, k?: number, opts?: SearchOptions): Promise<SearchResult[]>
  update(id: string, patch: MemoryPatch): Promise<Memory | null>
  delete(id: string): Promise<boolean>
  exportAll(): Promise<MemoryExport>
  importAll(dump: MemoryExport): Promise<number>
}

export class MemoryService implements MemoryStore {
  private readonly storage: KeyValueStore
  private readonly blobs: BlobStore
  private readonly provider: EmbeddingProvider
  private readonly now: () => number
  private readonly idgen: () => string

  private embeddingsEnabled: boolean
  private rows = new Map<string, Memory>()
  private slotOf = new Map<string, number>()
  private vectors: VectorSet
  private vectorStatus: VectorLoadStatus | "unloaded" = "unloaded"
  private loaded = false
  private dirtyVectors = false

  constructor(opts: MemoryServiceOptions = {}) {
    this.storage = opts.storage ?? new MemoryKeyValueStore()
    this.blobs = opts.blobs ?? new MemoryBlobStore()
    this.provider = opts.provider ?? new FakeEmbeddingProvider()
    this.embeddingsEnabled = opts.embeddingsEnabled ?? true
    this.now = opts.now ?? (() => Date.now())
    let n = 0
    this.idgen = opts.idgen ?? (() => `m${(++n).toString(36)}${this.now().toString(36)}`)
    this.vectors = new VectorSet(this.provider.dimensions)
  }

  /**
   * Read the rows and the vector blob. Safe to call repeatedly. The blob is a
   * cache: absent, corrupt, truncated or written by a different model all end
   * the same way — the affected memories go back on the embed queue.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    const raw = await this.storage.get(KEY_INDEX)
    const index: IndexRecord = raw ? JSON.parse(raw) : {version: 1, slots: [], ids: []}

    for (const id of index.ids) {
      const row = await this.storage.get(KEY_PREFIX + id)
      if (row) this.rows.set(id, JSON.parse(row) as Memory)
    }

    const unpacked = unpackVectors(await this.blobs.bytes(BLOB_VECTORS), this.provider.modelId)
    this.vectorStatus = unpacked.status
    // The model id is the first guard, but it is a string someone can keep while
    // changing the vector length. Treating a dimension mismatch as anything other
    // than a cache miss would read every vector at the wrong offset.
    if (unpacked.header && unpacked.header.dim !== this.provider.dimensions) {
      this.vectorStatus = "model_changed"
    }
    if (this.vectorStatus !== "model_changed" &&
        (unpacked.status === "ok" || unpacked.status === "truncated") && unpacked.data) {
      const owners = index.slots.slice(0, unpacked.header?.count ?? 0)
      this.vectors = VectorSet.fromPacked(this.provider.dimensions, unpacked.data, owners)
      owners.forEach((id, slot) => this.slotOf.set(id, slot))
    } else {
      this.vectors = new VectorSet(this.provider.dimensions)
    }

    // Any row that lost its vector is queued again rather than silently unsearchable.
    for (const m of this.rows.values()) {
      if (m.embedded && !this.slotOf.has(m.id)) {
        m.embedded = false
        await this.persistRow(m)
      }
    }
    this.loaded = true
  }

  setEmbeddingsEnabled(on: boolean) {
    this.embeddingsEnabled = on
  }

  async add(input: MemoryInput): Promise<Memory> {
    await this.load()

    // An inferred memory is a guess. It is never stored unapproved, and never
    // at all if it reads as a sensitive attribute the user did not state.
    if (input.class === "inferred_preference") {
      if (!input.approved) {
        throw new Error("An inferred preference needs explicit approval before it can be stored.")
      }
      const category = detectSensitive(input.text)
      if (category) throw new SensitiveInferenceError(category)
    }

    const t = this.now()
    const memory: Memory = {
      id: this.idgen(),
      class: input.class,
      text: input.text,
      tags: input.tags ?? [],
      source: input.source,
      createdAt: t,
      updatedAt: t,
      pinned: input.pinned ?? false,
      approved: input.approved ?? true,
      confidence: input.confidence,
      expiresAt: input.expiresAt,
      embedded: false,
    }
    this.rows.set(memory.id, memory)
    await this.persistRow(memory)
    await this.embedOne(memory)
    await this.persistIndex()
    return memory
  }

  async get(id: string): Promise<Memory | null> {
    await this.load()
    return this.rows.get(id) ?? null
  }

  async list(opts: {classes?: MemoryClass[]; includeExpired?: boolean} = {}): Promise<Memory[]> {
    await this.load()
    const now = this.now()
    return [...this.rows.values()]
      .filter(m => !opts.classes || opts.classes.includes(m.class))
      .filter(m => opts.includeExpired || !m.expiresAt || m.expiresAt > now)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Memories small and stable enough to ride in every prompt. */
  async alwaysLoaded(): Promise<Memory[]> {
    return this.list({classes: [...ALWAYS_LOADED_CLASSES]})
  }

  async search(query: string, k = 5, opts: SearchOptions = {}): Promise<SearchResult[]> {
    await this.load()
    const now = opts.now ?? this.now()
    const queryTokens = tokenize(query)

    let semantic: Float32Array | null = null
    if (this.embeddingsEnabled && this.vectors.size > 0) {
      try {
        const [q] = await this.provider.embed([query])
        semantic = this.vectors.scoreAll(normalize(q))
      } catch (err) {
        // Offline is not an error here: keyword and exact still rank sensibly.
        if (!(err instanceof EmbeddingUnavailableError)) throw err
      }
    }

    const results: SearchResult[] = []
    for (const m of this.rows.values()) {
      if (opts.classes && !opts.classes.includes(m.class)) continue
      if (opts.tags && !opts.tags.every(t => m.tags.includes(t))) continue
      if (m.expiresAt && m.expiresAt <= now) continue
      if (opts.includeUnembedded === false && !m.embedded) continue

      const tokens = memoryTokens(m)
      const slot = this.slotOf.get(m.id)
      const parts = {
        semantic: semantic && slot !== undefined ? Math.max(0, semantic[slot]) : 0,
        keyword: keywordScore(queryTokens, tokens),
        exact: exactScore(queryTokens, m, tokens),
        recency: recencyScore(m, now),
        pin: m.pinned ? 1 : 0,
      }
      const score = combine(parts)
      if (score > 0) results.push({memory: m, score, breakdown: parts})
    }
    results.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
    return results.slice(0, k)
  }

  async update(id: string, patch: MemoryPatch): Promise<Memory | null> {
    await this.load()
    const m = this.rows.get(id)
    if (!m) return null
    const textChanged = patch.text !== undefined && patch.text !== m.text
    Object.assign(m, patch, {updatedAt: this.now()})
    if (textChanged) {
      m.embedded = false
      this.dropVector(id)
      await this.embedOne(m)
    }
    await this.persistRow(m)
    await this.persistIndex()
    return m
  }

  async delete(id: string): Promise<boolean> {
    await this.load()
    if (!this.rows.delete(id)) return false
    this.dropVector(id)
    await this.storage.delete(KEY_PREFIX + id)
    await this.persistIndex()
    return true
  }

  async exportAll(): Promise<MemoryExport> {
    await this.load()
    return {version: 1, exportedAt: this.now(), memories: [...this.rows.values()]}
  }

  /** Replaces everything. Vectors are recomputed, never trusted from a dump. */
  async importAll(dump: MemoryExport): Promise<number> {
    await this.load()
    for (const id of [...this.rows.keys()]) await this.storage.delete(KEY_PREFIX + id)
    this.rows.clear()
    this.slotOf.clear()
    this.vectors = new VectorSet(this.provider.dimensions)
    for (const m of dump.memories) {
      const copy: Memory = {...m, embedded: false}
      this.rows.set(copy.id, copy)
      await this.persistRow(copy)
      await this.embedOne(copy)
    }
    await this.persistIndex()
    return this.rows.size
  }

  /** Embed everything still queued. Called on reconnect. Returns how many landed. */
  async flushQueue(): Promise<number> {
    await this.load()
    if (!this.embeddingsEnabled) return 0
    const pending = [...this.rows.values()].filter(m => !m.embedded)
    if (pending.length === 0) return 0
    let done = 0
    try {
      const vecs = await this.provider.embed(pending.map(m => m.text))
      for (let i = 0; i < pending.length; i++) {
        this.putVector(pending[i].id, normalize(vecs[i]))
        pending[i].embedded = true
        await this.persistRow(pending[i])
        done++
      }
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err
    }
    if (done) await this.persistIndex()
    return done
  }

  async stats(): Promise<MemoryStats> {
    await this.load()
    const all = [...this.rows.values()]
    return {
      total: all.length,
      embedded: all.filter(m => m.embedded).length,
      queued: all.filter(m => !m.embedded).length,
      vectorStatus: this.vectorStatus,
      embeddingsEnabled: this.embeddingsEnabled,
    }
  }

  // ---- internals -------------------------------------------------------

  private async embedOne(m: Memory): Promise<void> {
    if (!this.embeddingsEnabled) return
    try {
      const [v] = await this.provider.embed([m.text])
      this.putVector(m.id, normalize(v))
      m.embedded = true
      await this.persistRow(m)
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err
      // Stays queued; flushQueue() picks it up when the network returns.
    }
  }

  private putVector(id: string, vector: Float32Array) {
    const existing = this.slotOf.get(id)
    if (existing !== undefined) this.vectors.replace(existing, vector)
    else this.slotOf.set(id, this.vectors.push(id, vector))
    this.dirtyVectors = true
  }

  private dropVector(id: string) {
    const slot = this.slotOf.get(id)
    if (slot === undefined) return
    const moved = this.vectors.removeSlot(slot)
    this.slotOf.delete(id)
    if (moved) this.slotOf.set(moved.movedId, moved.newSlot)
    this.dirtyVectors = true
  }

  private async persistRow(m: Memory) {
    await this.storage.set(KEY_PREFIX + m.id, JSON.stringify(m))
  }

  private async persistIndex() {
    const record: IndexRecord = {
      version: 1,
      slots: this.vectors.ownerList(),
      ids: [...this.rows.keys()],
    }
    await this.storage.set(KEY_INDEX, JSON.stringify(record))
    if (this.dirtyVectors) {
      await this.blobs.set(BLOB_VECTORS, this.vectors.pack(this.provider.modelId))
      this.dirtyVectors = false
    }
  }
}
