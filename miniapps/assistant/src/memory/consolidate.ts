/**
 * @fileoverview Keeping the memory store from turning into a junk drawer.
 *
 * A personalised agent that only ever appends gets worse over time, not
 * better. The same fact said three times becomes three rows that all match the
 * same query and crowd out everything else; a preference the wearer changed
 * last month still sits alongside its replacement; and anything with a
 * retention promise keeps sitting in storage long after the promise expired.
 *
 * Three jobs, deliberately separated by how dangerous they are:
 *
 *   collect()   deletes what has expired. Safe, and currently NOT happening —
 *               expiry was honoured in reads but nothing ever removed a row.
 *   plan()      read-only analysis. Writes nothing, ever.
 *   applyDedupe() merges duplicates, from a plan the caller has seen.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE, both of which come from ADR-002:
 *
 *   1. Memories from DIFFERENT consent scopes never merge. Merging them would
 *      file one person's words under another person's scope, and the revocation
 *      guarantee — delete everything in this scope — would then be false while
 *      still looking complete. This is the single worst thing consolidation
 *      could do, and it is the kind of bug that is invisible until someone
 *      exercises their rights.
 *   2. A captured memory never merges with a self-reported one, for the same
 *      reason in the other direction: the merged row would lose its scope or
 *      gain one it should not have.
 *
 * AND ONE ABOUT INFERENCE. Promoting "said three times" into a stable
 * preference is a guess about the wearer, and the store already refuses to
 * hold an unapproved `inferred_preference`. Auto-promoting would route around
 * that rule through the back door, so promotions are returned as PROPOSALS and
 * never written. The wearer approves them or they do not happen.
 */

import {memoryTokens} from "./scoring"
import type {Memory, MemoryClass} from "./types"

/** Jaccard overlap of two token sets. Cheap, and good enough for near-dupes. */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

/** Above this, two memories of the same class are treated as the same fact. */
export const DUPLICATE_THRESHOLD = 0.8

/**
 * Above this, two memories are about the same subject even if they disagree.
 *
 * Deliberately much lower than DUPLICATE_THRESHOLD, and that is the point. A
 * change of mind has LOWER textual overlap than a duplicate, not higher:
 * "keep answers short" and "keep answers long" differ by one token out of
 * three, which scores 0.5. Detecting contradictions behind the duplicate
 * threshold therefore missed almost all of them — which was the first version
 * of this file, and the case that matters most for a personalised agent.
 */
export const CONTRADICTION_THRESHOLD = 0.4

/** How many separate statements before a promotion is worth proposing. */
export const PROMOTION_THRESHOLD = 3

export interface DuplicateGroup {
  /** The row that survives: the oldest, so first-stated provenance is kept. */
  keep: Memory
  /** Rows folded into it. */
  merge: Memory[]
  similarity: number
}

export interface Contradiction {
  /** The older statement, which the newer one replaces. */
  superseded: Memory
  by: Memory
  reason: string
}

export interface Promotion {
  /** The memory that would be promoted. */
  memory: Memory
  toClass: MemoryClass
  /** How many separate times the wearer stated it. */
  timesStated: number
  /**
   * Always true. A promotion is an inference about the wearer, and the store
   * refuses unapproved inferences, so this can only ever be a proposal.
   */
  needsApproval: true
}

export interface ConsolidationPlan {
  duplicates: DuplicateGroup[]
  contradictions: Contradiction[]
  promotions: Promotion[]
}

/**
 * True when two memories may be considered the same fact at all.
 *
 * Checked before similarity, because no amount of textual similarity makes it
 * safe to merge across a consent boundary.
 */
export function mergeable(a: Memory, b: Memory): boolean {
  if (a.id === b.id) return false
  if (a.class !== b.class) return false

  const pa = a.source.provenance ?? "self_reported"
  const pb = b.source.provenance ?? "self_reported"
  if (pa !== pb) return false
  // The rule that matters: same scope, or neither has one.
  if (a.source.scopeId !== b.source.scopeId) return false

  return true
}

/** Classes where a later statement replaces an earlier one. */
const SUPERSEDING_CLASSES: readonly MemoryClass[] = [
  "stable_preference",
  "profile_fact",
  "inferred_preference",
]

/**
 * Words that flip a statement's meaning. Two preferences that overlap heavily
 * but differ on one of these are a change of mind, not a duplicate.
 */
const POLARITY = [
  ["short", "long"],
  ["brief", "detailed"],
  ["less", "more"],
  ["never", "always"],
  ["off", "on"],
  ["disable", "enable"],
  ["quiet", "loud"],
]

function polarityConflict(a: Set<string>, b: Set<string>): string | null {
  for (const [x, y] of POLARITY) {
    if (a.has(x) && b.has(y)) return `"${x}" became "${y}"`
    if (a.has(y) && b.has(x)) return `"${y}" became "${x}"`
  }
  return null
}

/**
 * Analyse a set of memories. Pure: no clock, no storage, no writes.
 *
 * @param memories every live memory, newest-first order not required.
 */
export function planConsolidation(memories: Memory[]): ConsolidationPlan {
  const tokens = new Map<string, Set<string>>()
  for (const m of memories) tokens.set(m.id, memoryTokens(m))

  const duplicates: DuplicateGroup[] = []
  const contradictions: Contradiction[] = []

  // Oldest first, so the survivor of a group is the earliest statement.
  const byAge = [...memories].sort((a, b) => a.createdAt - b.createdAt)

  /*
   * Contradictions first, in their own pass with their own threshold. Running
   * this inside the duplicate loop made it unreachable: a duplicate needs 0.8
   * overlap and a change of mind scores around 0.5, so the detector only ever
   * fired on pairs that were not contradictions.
   */
  const inConflict = new Set<string>()
  for (let i = 0; i < byAge.length; i++) {
    for (let j = i + 1; j < byAge.length; j++) {
      const a = byAge[i]
      const b = byAge[j]
      if (!mergeable(a, b)) continue
      if (!SUPERSEDING_CLASSES.includes(a.class)) continue
      const ta = tokens.get(a.id)!
      const tb = tokens.get(b.id)!
      if (tokenOverlap(ta, tb) < CONTRADICTION_THRESHOLD) continue
      const flip = polarityConflict(ta, tb)
      if (!flip) continue

      // byAge is sorted, so a is the older of the pair.
      contradictions.push({superseded: a, by: b, reason: flip})
      inConflict.add(a.id)
      inConflict.add(b.id)
    }
  }

  /** Rows already claimed by a group, so nothing is merged twice. */
  const claimed = new Set<string>(inConflict)

  for (const a of byAge) {
    if (claimed.has(a.id)) continue
    const ta = tokens.get(a.id)!
    const group: Memory[] = []
    let best = 0

    for (const b of byAge) {
      if (b.id === a.id || claimed.has(b.id)) continue
      if (!mergeable(a, b)) continue
      const tb = tokens.get(b.id)!
      const sim = tokenOverlap(ta, tb)
      if (sim < DUPLICATE_THRESHOLD) continue
      // Belt and braces: a conflicting pair is already excluded above, but
      // merging opposite statements would keep the wearer's old answer and
      // silently discard the new one, so it is checked again here.
      if (polarityConflict(ta, tb)) continue

      group.push(b)
      claimed.add(b.id)
      if (sim > best) best = sim
    }

    if (group.length) {
      claimed.add(a.id)
      duplicates.push({keep: a, merge: group, similarity: best})
    }
  }

  // Promotions: an episodic fact the wearer has stated several times is
  // probably a standing one. Proposal only.
  const promotions: Promotion[] = []
  for (const group of duplicates) {
    const times = group.merge.length + 1
    if (group.keep.class !== "episodic") continue
    if (times < PROMOTION_THRESHOLD) continue
    promotions.push({
      memory: group.keep,
      toClass: "inferred_preference",
      timesStated: times,
      needsApproval: true,
    })
  }

  return {duplicates, contradictions, promotions}
}

/** Fold a group into one row's worth of fields. The survivor keeps its id. */
export function mergeInto(group: DuplicateGroup): Memory {
  const all = [group.keep, ...group.merge]
  const tags = new Set<string>()
  for (const m of all) for (const t of m.tags) tags.add(t)

  return {
    ...group.keep,
    tags: [...tags].sort(),
    // Oldest creation, newest touch: the fact is as old as its first
    // statement and as fresh as its most recent.
    createdAt: Math.min(...all.map(m => m.createdAt)),
    updatedAt: Math.max(...all.map(m => m.updatedAt)),
    // Pinned by any statement means pinned.
    pinned: all.some(m => m.pinned),
    // The longest wording usually carries the most detail, and the wearer's
    // own words are what this store is supposed to keep.
    text: all.reduce((longest, m) => (m.text.length > longest.length ? m.text : longest), group.keep.text),
    // An expiry survives only if every statement had one; otherwise the fact
    // has been restated without a limit and keeping the old one would delete
    // something the wearer has since made permanent.
    expiresAt: all.every(m => m.expiresAt !== undefined)
      ? Math.max(...all.map(m => m.expiresAt!))
      : undefined,
  }
}
