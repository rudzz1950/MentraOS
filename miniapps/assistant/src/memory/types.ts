/**
 * @fileoverview Memory types.
 *
 * The shapes here are deliberately row-like: flat, serializable, with an
 * explicit `id` and timestamps, so the SQLite-backed implementation can map
 * them onto a table without changing a single caller. Nothing in this file
 * mentions key-value storage, blobs or vectors.
 */

/**
 * Memory classes from the architecture. The class decides retention, whether
 * the memory is always loaded, and whether it needs explicit approval.
 */
export type MemoryClass =
  /** "Keep answers to two lines." Small, always loaded, survives until changed. */
  | "stable_preference"
  /** Role, city, languages. Stated by the user, not guessed. */
  | "profile_fact"
  /** "Met Tanu at the Agara Lake walk on 1 Oct." A thing that happened. */
  | "episodic"
  /** "Send the deck after the call." Open until done, then kept 7 days. */
  | "active_task"
  /** Notes and decisions scoped to one project. */
  | "project_context"
  /** Agent's guess. Never stored without `approved: true`. */
  | "inferred_preference"

export const MEMORY_CLASSES: readonly MemoryClass[] = [
  "stable_preference",
  "profile_fact",
  "episodic",
  "active_task",
  "project_context",
  "inferred_preference",
]

/** Classes small and stable enough to load into every prompt. */
export const ALWAYS_LOADED_CLASSES: readonly MemoryClass[] = ["stable_preference"]

/**
 * How a memory came to exist. This is not bookkeeping — it decides whether the
 * memory may be stored at all.
 *
 * ADR-002 (Project-K, consent ledger) sets the rule: anything derived from a
 * CAPTURE carries a consent scope, and a write without one is rejected. The
 * reason is that completeness of deletion cannot be proven by searching for
 * leftovers; it is only provable if an untagged write was structurally
 * impossible. This store accepted anything, which made it exactly the
 * "general memory store" that ADR forbids.
 *
 * The distinction that matters: a wearer dictating a note about their own
 * work is not a capture of anybody. A summary of what someone else said in
 * the room is. Scoping the first would be over-applying the rule; failing to
 * scope the second is the leak.
 */
export type MemoryProvenance =
  /** The wearer said it about themselves or their own work. No scope needed. */
  | "self_reported"
  /**
   * Derived from sensor capture — audio of other people, images, anything the
   * glasses observed rather than the wearer dictated. MUST carry a scopeId.
   */
  | "captured"

/** Where a memory came from. Every memory records this, for the "why did you say that?" view. */
export interface MemorySource {
  /** Id of the conversation turn that produced it. Required: no anonymous memories. */
  turnId: string
  /** Epoch ms of that turn. */
  turnAt: number
  /** Verbatim user utterance, when the memory was stated rather than derived. */
  utterance?: string
  /** The device the turn happened on (ANI-203), so provenance can say where a fact came from. */
  deviceId?: string
  /**
   * Defaults to "self_reported" when absent, because every memory this store
   * held before this field existed came from the wearer's own dictation. A
   * default of "captured" would have retro-tagged all of them as needing a
   * scope they never had.
   */
  provenance?: MemoryProvenance
  /**
   * The consent scope this memory belongs to. Required when provenance is
   * "captured"; rejected otherwise, so a scope cannot be attached to a
   * self-reported note and give a false impression of coverage.
   */
  scopeId?: string
}

export interface Memory {
  id: string
  class: MemoryClass
  /** The memory itself, in the user's words where possible. */
  text: string
  /** Free-form tags: project name, person, place. Used by the keyword term. */
  tags: string[]
  source: MemorySource
  createdAt: number
  updatedAt: number
  /** Pinned memories are boosted and never auto-expire. */
  pinned: boolean
  /**
   * Only meaningful for `inferred_preference`. False means the user has not
   * approved it, and `add` refuses to store it at all.
   */
  approved: boolean
  /** 0..1 for inferred memories; undefined for stated ones. */
  confidence?: number
  /** Epoch ms after which this memory should be dropped. Undefined = no expiry. */
  expiresAt?: number
  /**
   * Only meaningful for `active_task`: when the wearer said it was done.
   *
   * Completion is recorded, never inferred. Guessing it from `createdAt` would
   * delete an open task on a timer, and an open task the assistant forgot is
   * a promise the wearer made to someone else, silently dropped.
   */
  completedAt?: number
  /** False while the embedding is still queued (offline, or consent off). */
  embedded: boolean
}

/**
 * How long each class is kept, applied when a memory is written and when a
 * task is completed — not only when someone reads it.
 *
 * `afterCreateMs` sets an expiry at write time for classes that are only
 * useful for a while. `afterCompleteMs` starts the clock when a task is marked
 * done. A class with no entry keeps its memories until they are deleted.
 */
export type RetentionPolicy = Partial<Record<MemoryClass, {afterCreateMs?: number; afterCompleteMs?: number}>>

const DAY_MS = 86_400_000

/**
 * The defaults the architecture states and nothing more: an active task is
 * "open until done, then kept 7 days". Other classes get no default expiry,
 * because inventing a retention period nobody decided is worse than having
 * none — the host passes its own policy when one is agreed.
 */
export const DEFAULT_RETENTION: RetentionPolicy = {
  active_task: {afterCompleteMs: 7 * DAY_MS},
}

/** What a caller supplies to `add`. The service fills in ids, timestamps and embedding state. */
export interface MemoryInput {
  class: MemoryClass
  text: string
  tags?: string[]
  source: MemorySource
  pinned?: boolean
  approved?: boolean
  confidence?: number
  expiresAt?: number
}

/** Fields a caller may change after the fact. */
export interface MemoryPatch {
  text?: string
  tags?: string[]
  pinned?: boolean
  approved?: boolean
  class?: MemoryClass
  expiresAt?: number
}

/** A page of `list`. `nextCursor` is absent on the last page. */
export interface MemoryPage {
  items: Memory[]
  nextCursor?: string
}

export interface PageOptions {
  classes?: MemoryClass[]
  includeExpired?: boolean
  /** Rows per page. Clamped to 1..MAX_PAGE_SIZE. */
  limit?: number
  /** From the previous page's `nextCursor`. */
  cursor?: string
}

/** What `importAll` took, and what it refused and why. */
export interface ImportReport {
  imported: number
  /** Rows a live store would never have accepted: an unscoped capture, an unapproved inference. */
  rejected: {id: string; reason: string}[]
  /** Rows whose consent scope has been revoked here. Restoring a backup must not undo a revocation. */
  revoked: string[]
  /** Rows whose retention had already run out. */
  expired: string[]
}

export interface SearchOptions {
  /** Restrict to these classes. */
  classes?: MemoryClass[]
  /** Restrict to memories carrying all of these tags. */
  tags?: string[]
  /** Include memories whose embedding is still queued. Default true (they match on keywords). */
  includeUnembedded?: boolean
  /** Treat `now` as this epoch ms. Tests pass it; callers normally do not. */
  now?: number
}

export interface SearchResult {
  memory: Memory
  /** Final hybrid score. Only comparable within one result set. */
  score: number
  /** The parts that produced `score`, for debugging and for the "why" view. */
  breakdown: {
    semantic: number
    keyword: number
    exact: number
    recency: number
    pin: number
  }
}

/** A portable dump. `vectors` are omitted on purpose: they are a cache, not data. */
export interface MemoryExport {
  version: 1
  exportedAt: number
  memories: Memory[]
}
