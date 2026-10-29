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

/** Where a memory came from. Every memory records this, for the "why did you say that?" view. */
export interface MemorySource {
  /** Id of the conversation turn that produced it. Required: no anonymous memories. */
  turnId: string
  /** Epoch ms of that turn. */
  turnAt: number
  /** Verbatim user utterance, when the memory was stated rather than derived. */
  utterance?: string
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
  /** False while the embedding is still queued (offline, or consent off). */
  embedded: boolean
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
