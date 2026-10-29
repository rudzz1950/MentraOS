/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {
  DUPLICATE_THRESHOLD,
  mergeable,
  mergeInto,
  planConsolidation,
  tokenOverlap,
} from "../consolidate"
import type {Memory, MemoryClass, MemoryProvenance} from "../types"

let n = 0
function mem(over: Partial<Memory> & {text: string}): Memory {
  const id = over.id ?? `m${++n}`
  const t = over.createdAt ?? 1000
  return {
    id,
    class: "stable_preference" as MemoryClass,
    tags: [],
    source: {turnId: `t${id}`, turnAt: t},
    createdAt: t,
    updatedAt: over.updatedAt ?? t,
    pinned: false,
    approved: true,
    ...over,
  } as Memory
}

function captured(text: string, scopeId: string, over: Partial<Memory> = {}): Memory {
  return mem({
    text,
    class: "episodic",
    ...over,
    source: {
      turnId: "t1",
      turnAt: over.createdAt ?? 1000,
      provenance: "captured" as MemoryProvenance,
      scopeId,
    },
  })
}

describe("the consent boundary is checked before similarity", () => {
  test("two identical captured memories in DIFFERENT scopes never merge", () => {
    // The worst thing consolidation could do: file one person's words under
    // another person's scope, so a revocation looks complete while leaving
    // their data behind.
    const a = captured("the compressor was replaced in March", "scope-1", {createdAt: 1000})
    const b = captured("the compressor was replaced in March", "scope-2", {createdAt: 2000})
    expect(tokenOverlap(new Set(["compressor"]), new Set(["compressor"]))).toBe(1)
    expect(mergeable(a, b)).toBe(false)
    expect(planConsolidation([a, b]).duplicates).toEqual([])
  })

  test("identical captured memories in the SAME scope do merge", () => {
    const a = captured("the compressor was replaced in March", "scope-1", {createdAt: 1000})
    const b = captured("the compressor was replaced in March", "scope-1", {createdAt: 2000})
    expect(mergeable(a, b)).toBe(true)
    expect(planConsolidation([a, b]).duplicates.length).toBe(1)
  })

  test("a captured memory never merges with a self-reported one", () => {
    const a = captured("the lab quote was ninety thousand", "scope-1")
    const b = mem({text: "the lab quote was ninety thousand", class: "episodic"})
    expect(mergeable(a, b)).toBe(false)
  })

  test("and neither does a different class", () => {
    const a = mem({text: "keep answers short", class: "stable_preference"})
    const b = mem({text: "keep answers short", class: "profile_fact"})
    expect(mergeable(a, b)).toBe(false)
  })

  test("nor a memory with itself", () => {
    const a = mem({text: "keep answers short"})
    expect(mergeable(a, a)).toBe(false)
  })
})

describe("finding duplicates", () => {
  test("the same thing said twice is one group", () => {
    const a = mem({text: "keep answers short and direct", createdAt: 1000})
    const b = mem({text: "keep answers short and direct", createdAt: 2000})
    const plan = planConsolidation([a, b])
    expect(plan.duplicates.length).toBe(1)
    expect(plan.duplicates[0].keep.id).toBe(a.id)
    expect(plan.duplicates[0].merge.map(m => m.id)).toEqual([b.id])
  })

  test("the oldest survives, so first-stated provenance is kept", () => {
    const newer = mem({text: "keep answers short and direct", createdAt: 5000})
    const older = mem({text: "keep answers short and direct", createdAt: 1000})
    // Deliberately passed newest-first.
    const plan = planConsolidation([newer, older])
    expect(plan.duplicates[0].keep.id).toBe(older.id)
  })

  test("unrelated memories are not duplicates", () => {
    const a = mem({text: "keep answers short"})
    const b = mem({text: "the dev kit ships from Bengaluru"})
    expect(planConsolidation([a, b]).duplicates).toEqual([])
  })

  test("nothing is merged into two groups at once", () => {
    const a = mem({text: "keep answers short and direct", createdAt: 1000})
    const b = mem({text: "keep answers short and direct", createdAt: 2000})
    const c = mem({text: "keep answers short and direct", createdAt: 3000})
    const plan = planConsolidation([a, b, c])
    expect(plan.duplicates.length).toBe(1)
    expect(plan.duplicates[0].merge.length).toBe(2)
  })

  test("an empty store plans nothing", () => {
    expect(planConsolidation([])).toEqual({duplicates: [], contradictions: [], promotions: []})
  })
})

describe("a change of mind is not a duplicate", () => {
  test("opposite preferences are reported as a contradiction", () => {
    const older = mem({text: "keep answers short", createdAt: 1000})
    const newer = mem({text: "keep answers long", createdAt: 9000})
    const plan = planConsolidation([older, newer])
    // Merging these would keep the old answer and silently discard the new one.
    expect(plan.duplicates).toEqual([])
    expect(plan.contradictions.length).toBe(1)
    expect(plan.contradictions[0].superseded.id).toBe(older.id)
    expect(plan.contradictions[0].by.id).toBe(newer.id)
  })

  test("the newer one is always the survivor, whatever order they arrive in", () => {
    const older = mem({text: "notifications off while working", createdAt: 1000})
    const newer = mem({text: "notifications on while working", createdAt: 9000})
    for (const input of [[older, newer], [newer, older]]) {
      const plan = planConsolidation(input)
      expect(plan.contradictions[0].by.id).toBe(newer.id)
    }
  })

  test("it says what changed, so the wearer can be asked", () => {
    const plan = planConsolidation([
      mem({text: "always show the battery", createdAt: 1000}),
      mem({text: "never show the battery", createdAt: 9000}),
    ])
    expect(plan.contradictions[0].reason).toMatch(/always|never/)
  })

  test("two episodic events that differ are not a contradiction, just two events", () => {
    const a = mem({text: "met Ravi on the always line", class: "episodic", createdAt: 1000})
    const b = mem({text: "met Ravi on the never line", class: "episodic", createdAt: 9000})
    const plan = planConsolidation([a, b])
    expect(plan.contradictions).toEqual([])
  })
})

describe("promotion is a proposal and never a write", () => {
  test("a fact stated three times is proposed for promotion", () => {
    const rows = [1000, 2000, 3000].map(t =>
      mem({text: "the dev kit ships from Bengaluru", class: "episodic", createdAt: t}),
    )
    const plan = planConsolidation(rows)
    expect(plan.promotions.length).toBe(1)
    expect(plan.promotions[0].timesStated).toBe(3)
  })

  test("twice is not enough", () => {
    const rows = [1000, 2000].map(t =>
      mem({text: "the dev kit ships from Bengaluru", class: "episodic", createdAt: t}),
    )
    expect(planConsolidation(rows).promotions).toEqual([])
  })

  test("it always needs approval, because promoting is an inference", () => {
    // The store refuses an unapproved inferred_preference. Auto-promoting
    // would route around that rule through the back door.
    const rows = [1000, 2000, 3000].map(t =>
      mem({text: "prefers the metric figures first", class: "episodic", createdAt: t}),
    )
    const p = planConsolidation(rows).promotions[0]
    expect(p.needsApproval).toBe(true)
    expect(p.toClass).toBe("inferred_preference")
  })

  test("an already-stable preference is not promoted again", () => {
    const rows = [1000, 2000, 3000].map(t =>
      mem({text: "keep answers short and direct", class: "stable_preference", createdAt: t}),
    )
    expect(planConsolidation(rows).promotions).toEqual([])
  })
})

describe("merging fields", () => {
  const group = () => ({
    keep: mem({
      id: "keep",
      text: "keep answers short",
      tags: ["style"],
      createdAt: 1000,
      updatedAt: 1000,
    }),
    merge: [
      mem({
        id: "drop",
        text: "keep answers short and direct please",
        tags: ["format"],
        createdAt: 5000,
        updatedAt: 7000,
      }),
    ],
    similarity: 0.9,
  })

  test("the survivor keeps its id", () => {
    expect(mergeInto(group()).id).toBe("keep")
  })

  test("tags are unioned", () => {
    expect(mergeInto(group()).tags).toEqual(["format", "style"])
  })

  test("oldest creation, newest touch", () => {
    const m = mergeInto(group())
    expect(m.createdAt).toBe(1000)
    expect(m.updatedAt).toBe(7000)
  })

  test("the fullest wording wins, since it carries the most detail", () => {
    expect(mergeInto(group()).text).toBe("keep answers short and direct please")
  })

  test("pinned by any statement means pinned", () => {
    const g = group()
    g.merge[0].pinned = true
    expect(mergeInto(g).pinned).toBe(true)
  })

  test("an expiry survives only if every statement had one", () => {
    const g = group()
    g.keep.expiresAt = 9000
    // The newer statement had no expiry, so the fact has been restated without
    // a limit; keeping the old one would delete something made permanent.
    expect(mergeInto(g).expiresAt).toBeUndefined()

    const both = group()
    both.keep.expiresAt = 9000
    both.merge[0].expiresAt = 20_000
    expect(mergeInto(both).expiresAt).toBe(20_000)
  })
})

describe("overlap", () => {
  test("identical sets fully overlap", () => {
    expect(tokenOverlap(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1)
  })

  test("disjoint sets do not", () => {
    expect(tokenOverlap(new Set(["a"]), new Set(["b"]))).toBe(0)
  })

  test("an empty set overlaps nothing, rather than dividing by zero", () => {
    expect(tokenOverlap(new Set(), new Set(["a"]))).toBe(0)
    expect(tokenOverlap(new Set(), new Set())).toBe(0)
  })

  test("the threshold is strict enough that a shared word is not a duplicate", () => {
    const a = new Set(["keep", "answers", "short"])
    const b = new Set(["keep", "receipts", "forever"])
    expect(tokenOverlap(a, b)).toBeLessThan(DUPLICATE_THRESHOLD)
  })
})
