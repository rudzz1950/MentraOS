/**
 * @fileoverview The memory service, as the context engine sees it. ANI-203.
 *
 * No second store. This sits on the existing MemoryStore — its hybrid
 * semantic + exact retrieval, its write-path rules, its revocation — and adds
 * what the context engine needs on top:
 *
 *   - Retrieval by intent: a task question looks at tasks, a project
 *     question at that project, before falling back to everything.
 *   - Provenance on every result: the turn, the time, the device, and the
 *     wearer's own words when the memory was stated. Nothing is returned
 *     without a source, and no source is made up.
 *   - Three kinds kept apart: what the wearer said ("user_stated"), what was
 *     captured ("observed", always under a consent scope) and approved guesses
 *     ("hypothesis"). An answer can then say which it is relying on.
 *   - A read-time consent check. The memory store already refuses writes to a
 *     revoked scope and purges it; this also drops any captured memory whose
 *     scope no longer has a live grant for answering, so an expired consent
 *     stops a memory being used even before collection runs.
 *   - Corrections that update the one canonical record, so every device sees
 *     the corrected version next time.
 */

import type {MemoryService} from "../memory/memory"
import type {Memory, MemoryClass} from "../memory/types"
import type {PolicyEngine} from "./policy"

export type MemoryKind = "user_stated" | "observed" | "hypothesis"
export type Intent = "task" | "project" | "preference" | "general"

export interface ContextMemory {
  id: string
  text: string
  kind: MemoryKind
  class: MemoryClass
  pinned: boolean
  score: number
  source: {turnId: string; turnAt: number; deviceId?: string; utterance?: string}
  corrected: boolean
}

const INTENT_CLASSES: Record<Intent, MemoryClass[] | undefined> = {
  task: ["active_task"],
  project: ["project_context", "active_task"],
  preference: ["stable_preference", "inferred_preference"],
  general: undefined,
}

export function kindOf(m: Memory): MemoryKind {
  if (m.class === "inferred_preference") return "hypothesis"
  return (m.source.provenance ?? "self_reported") === "captured" ? "observed" : "user_stated"
}

export class MemoryContext {
  constructor(private readonly deps: {memory: MemoryService; policy: PolicyEngine; now: () => number}) {}

  async retrieve(query: string, opts: {intent?: Intent; project?: string; k?: number} = {}): Promise<ContextMemory[]> {
    const k = opts.k ?? 5
    const classes = INTENT_CLASSES[opts.intent ?? "general"]
    const tags = opts.project ? [opts.project] : undefined
    let hits = await this.deps.memory.search(query, k * 2, {classes, tags})
    // Too narrow: the intent was a guess about where the answer lives.
    if (hits.length < k && (classes || tags)) {
      const more = await this.deps.memory.search(query, k * 2)
      const seen = new Set(hits.map(h => h.memory.id))
      hits = [...hits, ...more.filter(h => !seen.has(h.memory.id))]
    }
    return hits
      .filter(h => this.readable(h.memory))
      .slice(0, k)
      .map(h => this.view(h.memory, h.score))
  }

  /** Something the wearer said about themselves, on whichever device they said it. */
  async rememberStated(text: string, opts: {class?: MemoryClass; turnId: string; deviceId: string; utterance?: string; tags?: string[]}): Promise<ContextMemory> {
    const m = await this.deps.memory.add({
      class: opts.class ?? "profile_fact",
      text,
      tags: opts.tags,
      source: {turnId: opts.turnId, turnAt: this.deps.now(), deviceId: opts.deviceId, utterance: opts.utterance},
    })
    return this.view(m, 0)
  }

  /** A guess about the wearer. Stored only with their explicit approval, which the store enforces too. */
  async rememberApprovedHypothesis(text: string, opts: {turnId: string; deviceId: string; approvedByUser: boolean; confidence: number}): Promise<ContextMemory> {
    if (!opts.approvedByUser) throw new Error("An inferred preference needs the wearer's explicit approval")
    const m = await this.deps.memory.add({
      class: "inferred_preference",
      text,
      approved: true,
      confidence: opts.confidence,
      source: {turnId: opts.turnId, turnAt: this.deps.now(), deviceId: opts.deviceId},
    })
    return this.view(m, 0)
  }

  /**
   * The wearer corrected a memory. The canonical record changes, so the next
   * retrieval on any device sees the correction; the original source is
   * kept, and the record is marked corrected.
   */
  async correct(id: string, text: string, by: {deviceId: string}): Promise<ContextMemory | null> {
    const m = await this.deps.memory.get(id)
    if (!m) return null
    const tags = [...new Set([...m.tags, "corrected", `corrected_on:${by.deviceId}`])]
    const updated = await this.deps.memory.update(id, {text, tags})
    return updated ? this.view(updated, 0) : null
  }

  pin(id: string, pinned: boolean) {
    return this.deps.memory.update(id, {pinned})
  }

  delete(id: string) {
    return this.deps.memory.delete(id)
  }

  export() {
    return this.deps.memory.exportAll()
  }

  private readable(m: Memory): boolean {
    if (kindOf(m) !== "observed") return true
    const scope = m.source.scopeId
    return !!scope && this.deps.policy.reach(scope) !== null
  }

  private view(m: Memory, score: number): ContextMemory {
    return {
      id: m.id,
      text: m.text,
      kind: kindOf(m),
      class: m.class,
      pinned: m.pinned,
      score,
      source: {turnId: m.source.turnId, turnAt: m.source.turnAt, deviceId: m.source.deviceId, utterance: m.source.utterance},
      corrected: m.tags.includes("corrected"),
    }
  }
}
