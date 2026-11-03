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
import {
  type ConsolidationPlan,
  type DuplicateGroup,
  mergeable,
  mergeInto,
  planConsolidation,
} from "./consolidate"
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

/**
 * A captured memory arrived for a consent scope that has been revoked.
 *
 * The usual way this happens is innocent: a write queued while offline lands
 * after the person withdrew consent. It is refused all the same, because a
 * revocation that a late write can undo was never complete.
 */
export class RevokedScopeError extends Error {
  constructor(readonly scopeId: string) {
    super(`Consent scope ${scopeId} has been revoked; nothing more may be stored under it.`)
    this.name = "RevokedScopeError"
  }
}

/** Largest page `listPage` returns, whatever the caller asks for. */
export const MAX_PAGE_SIZE = 200

/** Texts per embedding request when draining the queue. */
export const FLUSH_BATCH_SIZE = 32
import {
  ALWAYS_LOADED_CLASSES,
  DEFAULT_RETENTION,
  type ImportReport,
  type Memory,
  type MemoryPage,
  type PageOptions,
  type RetentionPolicy,
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
/**
 * Scopes revoked on this device. Kept after their rows are gone, so a restore,
 * an import or a late queued write cannot bring them back. Holds scope ids
 * only — an opaque reference to a ledger entry, nothing about the person.
 */
const KEY_REVOKED = "mem:revoked"

/** Pinned memories never expire, in reads as well as in collection. */
function isLive(m: Memory, now: number): boolean {
  return m.pinned || m.expiresAt === undefined || m.expiresAt > now
}

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
  /** How long each class is kept. Defaults to DEFAULT_RETENTION. */
  retention?: RetentionPolicy
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
  /** `list`, bounded: at most MAX_PAGE_SIZE rows per call. */
  listPage(opts?: PageOptions): Promise<MemoryPage>
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
  private readonly retention: RetentionPolicy

  private embeddingsEnabled: boolean
  private consentAsked: boolean
  private rows = new Map<string, Memory>()
  private slotOf = new Map<string, number>()
  private vectors: VectorSet
  private vectorStatus: VectorLoadStatus | "unloaded" = "unloaded"
  private loaded = false
  private dirtyVectors = false
  private revoked = new Set<string>()

  constructor(opts: MemoryServiceOptions = {}) {
    this.storage = opts.storage ?? new MemoryKeyValueStore()
    this.blobs = opts.blobs ?? new MemoryBlobStore()
    this.provider = opts.provider ?? new FakeEmbeddingProvider()
    // Off until someone says otherwise. See MemoryServiceOptions.
    this.embeddingsEnabled = opts.embeddingsEnabled ?? false
    this.consentAsked = opts.embeddingsEnabled !== undefined
    this.now = opts.now ?? (() => Date.now())
    this.retention = opts.retention ?? DEFAULT_RETENTION
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

    const revoked = await this.storage.get(KEY_REVOKED)
    if (revoked) for (const id of JSON.parse(revoked) as string[]) this.revoked.add(id)

    for (const id of index.ids) {
      const row = await this.storage.get(KEY_PREFIX + id)
      if (!row) continue
      const m = JSON.parse(row) as Memory
      // A revocation whose row deletes were interrupted finishes here, rather
      // than leaving the rows to reappear on the next launch.
      if (m.source.scopeId && this.revoked.has(m.source.scopeId)) {
        await this.storage.delete(KEY_PREFIX + id)
        continue
      }
      this.rows.set(id, m)
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

    const provenance = input.source.provenance ?? "self_reported"
    this.assertWritable({
      class: input.class,
      text: input.text,
      // Absent approval is no approval for a guess; for a stated memory the
      // field means nothing and defaults to true, as the row always has.
      approved: input.approved ?? input.class !== "inferred_preference",
      source: {...input.source, provenance},
    })

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
      // Retention is applied when the row is written, so a memory never exists
      // without the expiry its class promises. An explicit expiry wins.
      expiresAt: input.expiresAt ?? this.expiryAtCreate(input.class, t),
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
      .filter(m => opts.includeExpired || isLive(m, now))
      .sort(newestFirst)
  }

  /**
   * One page of `list`, newest first.
   *
   * The cursor names the last row returned rather than an offset, so a write
   * between two pages neither repeats a row nor skips one.
   */
  async listPage(opts: PageOptions = {}): Promise<MemoryPage> {
    const all = await this.list(opts)
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.limit ?? 50)))
    let start = 0
    if (opts.cursor) {
      const after = decodeCursor(opts.cursor)
      start = all.findIndex(m => newestFirst(m, after) > 0)
      if (start < 0) start = all.length
    }
    const items = all.slice(start, start + limit)
    const last = items[items.length - 1]
    return start + limit < all.length && last ? {items, nextCursor: encodeCursor(last)} : {items}
  }

  /**
   * Mark an active task done, and start its retention clock.
   *
   * The only way a task becomes complete. Idempotent: completing it again keeps
   * the first completion time, so a repeated "done" cannot extend retention.
   */
  async complete(id: string): Promise<Memory | null> {
    await this.load()
    const m = this.rows.get(id)
    if (!m) return null
    if (m.class !== "active_task") throw new Error(`Only an active_task can be completed, not ${m.class}.`)
    if (m.completedAt !== undefined) return m
    const t = this.now()
    m.completedAt = t
    const after = this.retention.active_task?.afterCompleteMs
    if (after !== undefined) m.expiresAt = t + after
    m.updatedAt = t
    await this.persistRow(m)
    return m
  }

  /** Undo a completion: the task is open again and its retention clock stops. */
  async reopen(id: string): Promise<Memory | null> {
    await this.load()
    const m = this.rows.get(id)
    if (!m || m.completedAt === undefined) return m ?? null
    const after = this.retention.active_task?.afterCompleteMs
    if (after !== undefined && m.expiresAt === m.completedAt + after) m.expiresAt = undefined
    m.completedAt = undefined
    m.updatedAt = this.now()
    await this.persistRow(m)
    return m
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
      if (!isLive(m, now)) continue
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
    const next = {...m, ...patch}
    // The same rules as add. Without this, a patch could turn a stated memory
    // into an unapproved inference, or give an inference sensitive text, and
    // store what add would have refused.
    this.assertWritable(next)
    const textChanged = patch.text !== undefined && patch.text !== m.text
    Object.assign(m, patch, {updatedAt: this.now()})
    // Completion belongs to tasks; a memory that stops being one loses it.
    if (m.class !== "active_task") m.completedAt = undefined
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

    // Recorded first: if the app dies halfway through the deletes, the next
    // load finishes the job instead of resurrecting the remainder.
    if (!this.revoked.has(scopeId)) {
      this.revoked.add(scopeId)
      await this.storage.set(KEY_REVOKED, JSON.stringify([...this.revoked].sort()))
    }
    for (const id of ids) {
      this.rows.delete(id)
      this.dropVector(id)
      await this.storage.delete(KEY_PREFIX + id)
    }
    if (ids.length) await this.persistIndex()
    return {scopeId, deleted: ids.length, ids}
  }

  /**
   * Delete everything that has expired, and say what went.
   *
   * Expiry was honoured on the read path — expired rows were filtered out of
   * `list` and `search` — but nothing ever removed them, so they sat in
   * storage indefinitely. A retention promise enforced only at read time is
   * not a retention promise: the data is still there, still in a backup, and
   * still answerable to a subject-access request.
   *
   * Pinned memories never expire and are never collected, which is what
   * pinning means.
   */
  async collect(): Promise<{deleted: number; ids: string[]}> {
    await this.load()
    const now = this.now()
    const ids = [...this.rows.values()]
      .filter(m => !isLive(m, now))
      .map(m => m.id)

    for (const id of ids) {
      this.rows.delete(id)
      this.dropVector(id)
      await this.storage.delete(KEY_PREFIX + id)
    }
    if (ids.length) await this.persistIndex()
    return {deleted: ids.length, ids}
  }

  /**
   * Analyse the store for duplicates, changes of mind and promotable facts.
   * Read-only: this writes nothing, so a caller can show it before acting.
   */
  async consolidationPlan(): Promise<ConsolidationPlan> {
    const live = await this.list()
    return planConsolidation(live)
  }

  /**
   * Apply the duplicate merges from a plan.
   *
   * Only the merges. Contradictions and promotions are left alone: a
   * contradiction needs the wearer to say which answer stands, and a promotion
   * is an inference this store refuses to hold without approval.
   */
  async applyDedupe(groups: DuplicateGroup[]): Promise<{merged: number; removed: number}> {
    await this.load()
    let merged = 0
    let removed = 0

    for (const group of groups) {
      // Re-check: the plan may have been built before another write landed,
      // and merging across a consent scope must be impossible even by
      // accident.
      if (!group.merge.every(m => mergeable(group.keep, m))) continue
      if (!this.rows.has(group.keep.id)) continue

      // The survivor's text may have changed, so its vector is stale. It goes
      // back on the queue: leaving `embedded` true with no vector made the
      // merged fact invisible to semantic search until the next restart.
      const survivor: Memory = {...mergeInto(group), embedded: false}
      this.dropVector(survivor.id)
      this.rows.set(survivor.id, survivor)
      await this.persistRow(survivor)
      merged++

      for (const victim of group.merge) {
        if (!this.rows.delete(victim.id)) continue
        this.dropVector(victim.id)
        await this.storage.delete(KEY_PREFIX + victim.id)
        removed++
      }
      await this.embedOne(survivor)
    }

    if (merged || removed) await this.persistIndex()
    return {merged, removed}
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
    return (await this.importChecked(dump)).imported
  }

  /**
   * `importAll`, with the receipt.
   *
   * A dump is held to the same rules as a live write. Importing used to be a
   * way round every one of them: an unscoped capture, an unapproved inference
   * or a revoked scope's rows from an old backup all went straight in. A
   * restore must not be the thing that undoes a deletion.
   */
  async importChecked(dump: MemoryExport): Promise<ImportReport> {
    await this.load()
    if (dump.version !== 1) throw new Error(`Unknown export version ${String(dump.version)}`)
    const now = this.now()
    const report: ImportReport = {imported: 0, rejected: [], revoked: [], expired: []}

    const accepted: Memory[] = []
    for (const m of dump.memories) {
      const provenance = m.source?.provenance ?? "self_reported"
      const copy: Memory = {...m, source: {...m.source, provenance}, embedded: false}
      if (copy.source.scopeId && this.revoked.has(copy.source.scopeId)) {
        report.revoked.push(copy.id)
        continue
      }
      if (!isLive(copy, now)) {
        report.expired.push(copy.id)
        continue
      }
      try {
        this.assertWritable(copy)
      } catch (err) {
        report.rejected.push({id: copy.id, reason: err instanceof Error ? err.message : String(err)})
        continue
      }
      accepted.push(copy)
    }

    for (const id of [...this.rows.keys()]) await this.storage.delete(KEY_PREFIX + id)
    this.rows.clear()
    this.slotOf.clear()
    this.vectors = new VectorSet(this.provider.dimensions)
    this.dirtyVectors = true
    for (const copy of accepted) {
      this.rows.set(copy.id, copy)
      await this.persistRow(copy)
    }
    await this.persistIndex()
    await this.flushQueue()
    report.imported = accepted.length
    return report
  }

  /**
   * Embed everything still queued. Called on reconnect. Returns how many landed.
   *
   * In batches, each committed as it lands. Sending the whole queue as one
   * request meant a connection that dropped partway lost every vector already
   * computed, and the retry started from zero — on a train, forever.
   */
  async flushQueue(opts: {batchSize?: number} = {}): Promise<number> {
    await this.load()
    if (!this.embeddingsEnabled) return 0
    const batchSize = Math.max(1, opts.batchSize ?? FLUSH_BATCH_SIZE)
    const pending = [...this.rows.values()].filter(m => !m.embedded)
    let done = 0
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize)
      let vecs: Float32Array[]
      try {
        vecs = await this.provider.embed(batch.map(m => m.text))
      } catch (err) {
        if (!(err instanceof EmbeddingUnavailableError)) throw err
        break
      }
      for (let j = 0; j < batch.length; j++) {
        // The row may have been deleted or edited while the request was out.
        if (this.rows.get(batch[j].id) !== batch[j]) continue
        this.putVector(batch[j].id, normalize(vecs[j]))
        batch[j].embedded = true
        await this.persistRow(batch[j])
        done++
      }
      await this.persistIndex()
    }
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

  /** Scopes revoked on this device, for the transparency view and for audit. */
  async revokedScopes(): Promise<string[]> {
    await this.load()
    return [...this.revoked].sort()
  }

  // ---- internals -------------------------------------------------------

  /**
   * The write-path rules, in one place so that add, update and import cannot
   * drift apart. ADR-002: enforcing this anywhere other than every write makes
   * it a convention rather than a guarantee.
   */
  private assertWritable(m: Pick<Memory, "class" | "text" | "approved" | "source">) {
    const provenance = m.source.provenance ?? "self_reported"
    // Completeness of deletion cannot be proven by searching for leftovers. It
    // is provable only if an untagged write was impossible.
    if (provenance === "captured" && !m.source.scopeId) throw new UnscopedCaptureError()
    if (provenance === "self_reported" && m.source.scopeId) {
      // Refused rather than ignored. A scope on a note nobody consented to
      // would make a later deletion look complete when it had covered
      // something it never needed to.
      throw new Error(
        "A self_reported memory must not carry a scopeId: it implies a consent scope that does not apply.",
      )
    }
    if (m.source.scopeId && this.revoked.has(m.source.scopeId)) throw new RevokedScopeError(m.source.scopeId)

    // An inferred memory is a guess. It is never stored unapproved, and never
    // at all if it reads as a sensitive attribute the user did not state.
    if (m.class === "inferred_preference") {
      if (!m.approved) throw new Error("An inferred preference needs explicit approval before it can be stored.")
      const category = detectSensitive(m.text)
      if (category) throw new SensitiveInferenceError(category)
    }
  }

  private expiryAtCreate(cls: MemoryClass, t: number): number | undefined {
    const after = this.retention[cls]?.afterCreateMs
    return after === undefined ? undefined : t + after
  }

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

function newestFirst(a: Pick<Memory, "updatedAt" | "id">, b: Pick<Memory, "updatedAt" | "id">): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function encodeCursor(m: Memory): string {
  return `${m.updatedAt}:${m.id}`
}

function decodeCursor(cursor: string): Pick<Memory, "updatedAt" | "id"> {
  const i = cursor.indexOf(":")
  const updatedAt = Number(cursor.slice(0, i))
  if (i < 0 || !Number.isFinite(updatedAt)) throw new Error("Malformed page cursor")
  return {updatedAt, id: cursor.slice(i + 1)}
}
