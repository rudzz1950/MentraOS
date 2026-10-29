/**
 * @fileoverview The two storage ports the memory service needs, and nothing more.
 *
 * `session.storage` (SimpleStorage) and `session.blob` (BlobModule) from
 * @mentra/miniapp satisfy these structurally, so the adapter is a cast, not a
 * wrapper. Keeping the ports this narrow is what makes the SQLite move cheap:
 * the native module implements `MemoryStore` (one level up) and these two
 * disappear entirely.
 */

/** Subset of @mentra/miniapp's SimpleStorage. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

/** Subset of @mentra/miniapp's BlobModule. */
export interface BlobStore {
  /** Returns null when the key is absent. */
  bytes(key: string): Promise<Uint8Array | null>
  set(key: string, data: Uint8Array, opts?: {mimeType?: string}): Promise<unknown>
  delete(key: string): Promise<void>
}

/** An in-memory KeyValueStore. Used by tests and as the fallback when storage is unavailable. */
export class MemoryKeyValueStore implements KeyValueStore {
  constructor(private readonly map = new Map<string, string>()) {}
  async get(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  async set(key: string, value: string) {
    this.map.set(key, value)
  }
  async delete(key: string) {
    this.map.delete(key)
  }
  async keys() {
    return [...this.map.keys()]
  }
}

/** An in-memory BlobStore. */
export class MemoryBlobStore implements BlobStore {
  private readonly map = new Map<string, Uint8Array>()
  async bytes(key: string) {
    const v = this.map.get(key)
    return v ? v.slice() : null
  }
  async set(key: string, data: Uint8Array) {
    this.map.set(key, data.slice())
    return {key, bytes: data.length}
  }
  async delete(key: string) {
    this.map.delete(key)
  }
  /** Test hook: corrupt or truncate the stored bytes. */
  __overwrite(key: string, data: Uint8Array) {
    this.map.set(key, data.slice())
  }
}
