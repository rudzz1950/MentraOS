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

/**
 * A captured memory arrived with no consent scope.
 *
 * Thrown rather than dropped, and never downgraded to self_reported, because a
 * silent downgrade is how a record about someone else ends up outside every
 * scope and survives their revocation.
 */
export class UnscopedCaptureError extends Error {
  constructor() {
    super("A captured memory must carry a scopeId. See ADR-002: completeness of deletion depends on it.")
    this.name = "UnscopedCaptureError"
  }
}
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
   * Consent to send memory text to an embedding provider.
   *
   * Leave it undefined and it is OFF, and `embeddingConsent` reports "unasked"
   * so the host knows to put the question to the user. Do not default it on:
   * embedding is not necessary to provide the service, the provider is usually
   * outside India, and DPDP consent has to be a clear affirmative act rather
   * than a pre-set switch. Search still works meanwhile, on keywords.
   */
  embeddingsEnabled?: boolean
  /** Injected so tests are deterministic. */
  now?: () => number
  idgen?: () => string
}

/** Whether the user has been asked about embedding, and what they said. */
export type EmbeddingConsent = "unasked" | "granted" | "denied"

export interface MemoryStats {
  total: number
  embedded: number
  queued: number
  vectorStatus: VectorLoadStatus | "unloaded"
  embeddingsEnabled: boolean
  /** "unasked" means the host still owes the user the question. */
  embeddingConsent: EmbeddingConsent
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
  private consentAsked: boolean
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
    // Off until someone says otherwise. See MemoryServiceOptions.
    this.embeddingsEnabled = opts.embeddingsEnabled ?? false
    this.consentAsked = opts.embeddingsEnabled !== undefined
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

  /** Record the user's answer. Calling this at all counts as having asked. */
  setEmbeddingsEnabled(on: boolean) {
    this.embeddingsEnabled = on
    this.consentAsked = true
  }

  embeddingConsent(): EmbeddingConsent {
    if (!this.consentAsked) return "unasked"
    return this.embeddingsEnabled ? "granted" : "denied"
  }

  async add(input: MemoryInput): Promise<Memory> {
    await this.load()

    /*
     * The write-path rule from ADR-002, enforced here because enforcing it
     * anywhere else makes it a convention rather than a guarantee.
     *
     * Completeness of deletion cannot be proven by searching for leftovers —
     * that only proves nothing was found. It is provable only if an untagged
     * write was impossible, so a captured memory with no scope is refused and
     * there is no bypass for it.
     */
    const provenance = input.source.provenance ?? "self_reported"
    if (provenance === "captured" && !input.source.scopeId) {
      throw new UnscopedCaptureError()
    }
    if (provenance === "self_reported" && input.source.scopeId) {
      // Refused rather than ignored. A scope on a note nobody consented to
      // would make a later deletion look complete when it had covered
      // something it never needed to.
      throw new Error(
        "A self_reported memory must not carry a scopeId: it implies a consent scope that does not apply.",
      )
    }

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
      source: {...input.source, provenance},
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

  /**
   * Delete everything belonging to one consent scope, and say what was removed.
   *
   * This is the revocation path from ADR-002. The receipt is the point: a
   * deletion that reports nothing cannot be audited, and a count of zero where
   * one was expected is a finding rather than a success. Vectors are dropped
   * alongside the rows, because an embedding of what someone said is still
   * about them.
   */
  async deleteScope(scopeId: string): Promise<{scopeId: string; deleted: number; ids: string[]}> {
    await this.load()
    if (!scopeId) throw new Error("deleteScope needs a scopeId")

    const ids = [...this.rows.values()]
      .filter(m => m.source.scopeId === scopeId)
      .map(m => m.id)

    for (const id of ids) {
      this.rows.delete(id)
      this.dropVector(id)
      await this.storage.delete(KEY_PREFIX + id)
    }
    if (ids.length) await this.persistIndex()
    return {scopeId, deleted: ids.length, ids}
  }

  /** The scopes this store currently holds anything for. */
  async scopes(): Promise<string[]> {
    await this.load()
    const found = new Set<string>()
    for (const m of this.rows.values()) {
      if (m.source.scopeId) found.add(m.source.scopeId)
    }
    return [...found].sort()
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
      embeddingConsent: this.embeddingConsent(),
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
