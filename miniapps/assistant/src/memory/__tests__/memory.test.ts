/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {EmbeddingUnavailableError, FakeEmbeddingProvider} from "../embeddings"
import {MemoryService, UnscopedCaptureError} from "../memory"
import {MemoryBlobStore, MemoryKeyValueStore} from "../ports"
import {SensitiveInferenceError} from "../sensitive"
import type {MemoryInput} from "../types"

const T0 = 1_761_000_000_000

/** "pitch" and "deck"/"investors" land on the same dimension, so they read as synonyms. */
function provider() {
  return new FakeEmbeddingProvider(64, [["pitch", "deck", "investors", "fundraise"]])
}

/** A provider that is offline until `online` is set. */
class FlakyProvider extends FakeEmbeddingProvider {
  online = false
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.online) throw new EmbeddingUnavailableError("test: offline")
    return super.embed(texts)
  }
}

function service(opts: Partial<ConstructorParameters<typeof MemoryService>[0]> = {}) {
  let t = T0
  let n = 0
  return new MemoryService({
    storage: new MemoryKeyValueStore(),
    blobs: new MemoryBlobStore(),
    provider: provider(),
    now: () => (t += 1000),
    idgen: () => `m${++n}`,
    // Consent is off until asked, so the tests that exercise the embedding
    // path grant it. Passing it explicitly keeps that visible rather than
    // relying on a default that deliberately is not on.
    embeddingsEnabled: true,
    ...opts,
  })
}

const stated = (text: string, extra: Partial<MemoryInput> = {}): MemoryInput => ({
  class: "episodic",
  text,
  source: {turnId: "t1", turnAt: T0},
  ...extra,
})

describe("retrieval", () => {
  test("finds a memory by meaning, not wording", async () => {
    const m = service()
    await m.add(stated("Sent the deck to the investors on Tuesday"))
    await m.add(stated("Booked a dentist appointment"))
    await m.add(stated("The car needs a service"))

    const hits = await m.search("how did the pitch go", 3)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].memory.text).toContain("deck")
    // The query shares no meaningful word with the winner, so it is the semantic
    // term separating it from the rest, not a lexical overlap.
    expect(hits[0].memory.text).not.toContain("pitch")
    expect(hits[0].breakdown.semantic).toBeGreaterThan(hits[1].breakdown.semantic * 2)
  })

  test("an exact name still wins, which embeddings alone would miss", async () => {
    const m = service()
    await m.add(stated("Met Tanu at the Agara Lake walk"))
    await m.add(stated("Met someone at a lake for a morning walk about startups"))

    const hits = await m.search("Tanu", 2)
    expect(hits[0].memory.text).toContain("Tanu")
    expect(hits[0].breakdown.exact).toBeGreaterThan(0)
  })

  test("respects class and tag filters", async () => {
    const m = service()
    await m.add(stated("Keep answers to two lines", {class: "stable_preference"}))
    await m.add(stated("Ordered the dev kit", {tags: ["glasses"]}))
    await m.add(stated("Ordered groceries", {tags: ["home"]}))

    expect((await m.search("ordered", 5, {tags: ["glasses"]})).length).toBe(1)
    const prefs = await m.search("answers", 5, {classes: ["stable_preference"]})
    expect(prefs.every(h => h.memory.class === "stable_preference")).toBe(true)
  })

  test("expired memories drop out of search and list", async () => {
    const m = service()
    await m.add(stated("Temporary note", {expiresAt: T0 + 2000}))
    await m.add(stated("Permanent note"))
    const hits = await m.search("note", 5, {now: T0 + 10_000})
    expect(hits.map(h => h.memory.text)).toEqual(["Permanent note"])
  })
})

describe("offline and consent", () => {
  test("queues while offline, searches on keywords, backfills on reconnect", async () => {
    const p = new FlakyProvider(64, [["pitch", "deck", "investors"]])
    const m = service({provider: p})

    await m.add(stated("Sent the deck to the investors"))
    let s = await m.stats()
    expect(s.queued).toBe(1)
    expect(s.embedded).toBe(0)

    // Keyword still works, so the feature degrades rather than disappearing.
    const offlineHits = await m.search("deck", 3)
    expect(offlineHits[0].memory.text).toContain("deck")
    expect(offlineHits[0].breakdown.semantic).toBe(0)

    p.online = true
    expect(await m.flushQueue()).toBe(1)
    s = await m.stats()
    expect(s.queued).toBe(0)
    expect(s.embedded).toBe(1)

    const hits = await m.search("how did the pitch go", 3)
    expect(hits[0].breakdown.semantic).toBeGreaterThan(0)
  })

  test("consent off never calls the provider and still returns results", async () => {
    const p = provider()
    const m = service({provider: p, embeddingsEnabled: false})
    await m.add(stated("Sent the deck to the investors"))
    const hits = await m.search("deck", 3)

    expect(p.callCount).toBe(0)
    expect(hits[0].memory.text).toContain("deck")
    expect(hits[0].breakdown.semantic).toBe(0)
    expect((await m.stats()).embeddingsEnabled).toBe(false)
  })
})

describe("what may be stored", () => {
  test("an unapproved inference is refused", async () => {
    const m = service()
    await expect(
      m.add(stated("Prefers Hindi for casual replies", {class: "inferred_preference"})),
    ).rejects.toThrow(/approval/i)
  })

  test("an approved inference that reads as a sensitive attribute is still refused", async () => {
    const m = service()
    let caught: unknown
    try {
      await m.add(
        stated("Seems to be diabetic", {class: "inferred_preference", approved: true}),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SensitiveInferenceError)
    expect((await m.list()).length).toBe(0)
  })

  test("the same sensitive text stated by the user is stored", async () => {
    const m = service()
    const saved = await m.add(stated("I am diabetic", {class: "profile_fact"}))
    expect((await m.get(saved.id))?.text).toBe("I am diabetic")
  })

  test("every memory records the turn it came from", async () => {
    const m = service()
    const saved = await m.add(stated("Something happened"))
    expect(saved.source.turnId).toBe("t1")
  })
})

describe("lifecycle", () => {
  test("delete removes the row and its vector, and survives a reload", async () => {
    const storage = new MemoryKeyValueStore()
    const blobs = new MemoryBlobStore()
    const m = service({storage, blobs})
    const a = await m.add(stated("Sent the deck to the investors"))
    await m.add(stated("Booked a dentist appointment"))

    expect(await m.delete(a.id)).toBe(true)
    expect(await m.get(a.id)).toBeNull()

    const reloaded = service({storage, blobs})
    expect(await reloaded.get(a.id)).toBeNull()
    expect((await reloaded.list()).length).toBe(1)
    const hits = await reloaded.search("pitch", 5)
    expect(hits.every(h => h.memory.id !== a.id)).toBe(true)
  })

  test("editing the text re-embeds it", async () => {
    const m = service()
    const saved = await m.add(stated("Booked a dentist appointment"))
    const before = (await m.search("how did the pitch go", 3)).find(h => h.memory.id === saved.id)
    const beforeScore = before?.breakdown.semantic ?? 0

    await m.update(saved.id, {text: "Sent the deck to the investors"})
    const hits = await m.search("how did the pitch go", 3)
    expect(hits[0].memory.id).toBe(saved.id)
    // The vector followed the new text rather than staying on the old one.
    expect(hits[0].breakdown.semantic).toBeGreaterThan(beforeScore * 2)
  })

  test("export and import round-trip, with vectors rebuilt not trusted", async () => {
    const m = service()
    await m.add(stated("Sent the deck to the investors"))
    await m.add(stated("Keep answers to two lines", {class: "stable_preference"}))
    const dump = await m.exportAll()
    expect(JSON.stringify(dump)).not.toContain("vectors")

    const fresh = service()
    expect(await fresh.importAll(dump)).toBe(2)
    expect((await fresh.stats()).embedded).toBe(2)
    const hits = await fresh.search("how did the pitch go", 3)
    expect(hits[0].memory.text).toContain("deck")
  })

  test("always-loaded classes are the small stable ones", async () => {
    const m = service()
    await m.add(stated("Keep answers to two lines", {class: "stable_preference"}))
    await m.add(stated("Sent the deck", {class: "episodic"}))
    const always = await m.alwaysLoaded()
    expect(always.length).toBe(1)
    expect(always[0].class).toBe("stable_preference")
  })
})

describe("the vector blob is a cache, not data", () => {
  test("a corrupt blob loses no memories, only the embeddings", async () => {
    const storage = new MemoryKeyValueStore()
    const blobs = new MemoryBlobStore()
    const m = service({storage, blobs})
    await m.add(stated("Sent the deck to the investors"))
    await m.add(stated("Booked a dentist appointment"))

    blobs.__overwrite("mem:vectors", new Uint8Array([1, 2, 3, 4, 5]))

    const reloaded = service({storage, blobs})
    const s = await reloaded.stats()
    expect(s.total).toBe(2)
    expect(s.vectorStatus).toBe("corrupt")
    expect(s.queued).toBe(2)
    // Still searchable on keywords while the queue drains.
    expect((await reloaded.search("deck", 3)).length).toBeGreaterThan(0)
    expect(await reloaded.flushQueue()).toBe(2)
  })

  test("a truncated blob keeps the whole vectors that landed", async () => {
    const storage = new MemoryKeyValueStore()
    const blobs = new MemoryBlobStore()
    const m = service({storage, blobs})
    await m.add(stated("Sent the deck to the investors"))
    await m.add(stated("Booked a dentist appointment"))

    const full = (await blobs.bytes("mem:vectors"))!
    blobs.__overwrite("mem:vectors", full.subarray(0, full.length - 64))

    const reloaded = service({storage, blobs})
    const s = await reloaded.stats()
    expect(s.total).toBe(2)
    expect(s.vectorStatus).toBe("truncated")
    expect(s.queued).toBeGreaterThan(0)
  })

  test("a different embedding model invalidates the cache", async () => {
    const storage = new MemoryKeyValueStore()
    const blobs = new MemoryBlobStore()
    const m = service({storage, blobs})
    await m.add(stated("Sent the deck to the investors"))

    const other = new MemoryService({
      storage,
      blobs,
      provider: new FakeEmbeddingProvider(32),
      now: () => T0,
      embeddingsEnabled: true,
    })
    const s = await other.stats()
    expect(s.total).toBe(1)
    expect(s.vectorStatus).toBe("model_changed")
    expect(s.queued).toBe(1)
  })
})

describe("embedding consent", () => {
  test("is off until asked, and search still works meanwhile", async () => {
    const p = provider()
    // No embeddingsEnabled passed at all: the host has not put the question yet.
    const m = new MemoryService({
      storage: new MemoryKeyValueStore(),
      blobs: new MemoryBlobStore(),
      provider: p,
      now: () => T0,
      idgen: (() => {
        let n = 0
        return () => `m${++n}`
      })(),
    })
    await m.add(stated("Sent the deck to the investors"))

    const s = await m.stats()
    expect(s.embeddingConsent).toBe("unasked")
    expect(s.embeddingsEnabled).toBe(false)
    expect(p.callCount).toBe(0)

    // Degraded, not broken.
    const hits = await m.search("deck", 3)
    expect(hits[0].memory.text).toContain("deck")
  })

  test("granting it embeds what was queued while undecided", async () => {
    const p = provider()
    const m = service({provider: p, embeddingsEnabled: undefined})
    await m.add(stated("Sent the deck to the investors"))
    expect((await m.stats()).queued).toBe(1)

    m.setEmbeddingsEnabled(true)
    expect(await m.flushQueue()).toBe(1)

    const s = await m.stats()
    expect(s.embeddingConsent).toBe("granted")
    expect(s.queued).toBe(0)
    const hits = await m.search("how did the pitch go", 3)
    expect(hits[0].breakdown.semantic).toBeGreaterThan(0)
  })

  test("declining is recorded as a decision, not as an unanswered question", async () => {
    const p = provider()
    const m = service({provider: p, embeddingsEnabled: undefined})
    m.setEmbeddingsEnabled(false)
    await m.add(stated("Sent the deck to the investors"))

    const s = await m.stats()
    expect(s.embeddingConsent).toBe("denied")
    expect(p.callCount).toBe(0)
  })
})

describe("consent scoping — ADR-002's write-path rule", () => {
  const captured = (scopeId?: string) => ({
    class: "episodic" as const,
    text: "Ravi said the compressor was replaced in March",
    source: {
      turnId: "t1",
      turnAt: 1,
      provenance: "captured" as const,
      ...(scopeId ? {scopeId} : {}),
    },
  })

  test("a captured memory with no scope is refused, not downgraded", async () => {
    const m = service()
    await expect(m.add(captured())).rejects.toThrow(UnscopedCaptureError)
    expect((await m.list()).length).toBe(0)
  })

  test("with a scope it stores", async () => {
    const m = service()
    const stored = await m.add(captured("scope-1"))
    expect(stored.source.scopeId).toBe("scope-1")
    expect(stored.source.provenance).toBe("captured")
  })

  test("a self-reported note needs no scope", async () => {
    const m = service()
    const stored = await m.add({
      class: "episodic",
      text: "the lab quote was 90k",
      source: {turnId: "t1", turnAt: 1},
    })
    expect(stored.source.provenance).toBe("self_reported")
  })

  test("and must not carry one, which would fake coverage", async () => {
    const m = service()
    await expect(
      m.add({
        class: "episodic",
        text: "the lab quote was 90k",
        source: {turnId: "t1", turnAt: 1, provenance: "self_reported", scopeId: "scope-1"},
      }),
    ).rejects.toThrow(/must not carry a scopeId/)
  })

  test("existing memories default to self_reported, not captured", async () => {
    // Every memory this store held before provenance existed came from the
    // wearer's dictation. Defaulting to "captured" would have retro-tagged
    // them all as needing a scope they never had.
    const m = service()
    const stored = await m.add({
      class: "profile_fact",
      text: "works on wearables",
      source: {turnId: "t1", turnAt: 1},
    })
    expect(stored.source.provenance).toBe("self_reported")
  })
})

describe("revoking a scope", () => {
  const captured = (text: string, scopeId: string) => ({
    class: "episodic" as const,
    text,
    source: {turnId: "t1", turnAt: 1, provenance: "captured" as const, scopeId},
  })

  test("removes everything in it and reports the count", async () => {
    const m = service()
    await m.add(captured("first thing said", "scope-1"))
    await m.add(captured("second thing said", "scope-1"))
    await m.add(captured("someone else entirely", "scope-2"))

    const receipt = await m.deleteScope("scope-1")
    expect(receipt.deleted).toBe(2)
    expect(receipt.ids.length).toBe(2)
    expect((await m.list()).length).toBe(1)
  })

  test("leaves other scopes alone", async () => {
    const m = service()
    await m.add(captured("in scope one", "scope-1"))
    await m.add(captured("in scope two", "scope-2"))
    await m.deleteScope("scope-1")
    const left = await m.list()
    expect(left.length).toBe(1)
    expect(left[0].source.scopeId).toBe("scope-2")
  })

  test("leaves the wearer's own notes alone", async () => {
    const m = service()
    await m.add({class: "episodic", text: "my own note", source: {turnId: "t1", turnAt: 1}})
    await m.add(captured("what Ravi said", "scope-1"))
    await m.deleteScope("scope-1")
    const left = await m.list()
    expect(left.length).toBe(1)
    expect(left[0].text).toBe("my own note")
  })

  test("a count of zero is reported rather than passing as success", async () => {
    const m = service()
    const receipt = await m.deleteScope("scope-never-existed")
    expect(receipt.deleted).toBe(0)
    expect(receipt.scopeId).toBe("scope-never-existed")
  })

  test("the deleted memory is gone from search, not just from the list", async () => {
    // An embedding of what someone said is still about them, so the vector
    // has to go with the row.
    const m = service()
    await m.add(captured("the compressor was replaced in March", "scope-1"))
    expect((await m.search("compressor")).length).toBeGreaterThan(0)
    await m.deleteScope("scope-1")
    expect((await m.search("compressor")).length).toBe(0)
  })

  test("it lists the scopes it holds, so a revocation can be checked", async () => {
    const m = service()
    await m.add(captured("a", "scope-b"))
    await m.add(captured("b", "scope-a"))
    expect(await m.scopes()).toEqual(["scope-a", "scope-b"])
    await m.deleteScope("scope-a")
    expect(await m.scopes()).toEqual(["scope-b"])
  })

  test("an empty scopeId is refused rather than deleting everything untagged", async () => {
    const m = service()
    await expect(m.deleteScope("")).rejects.toThrow()
  })
})

describe("collecting what has expired", () => {
  test("expired rows are actually deleted, not just hidden from reads", async () => {
    // Expiry was honoured on the read path but nothing removed the row, so it
    // sat in storage indefinitely. A retention promise enforced only at read
    // time is not a retention promise.
    const m = service()
    const stored = await m.add({
      class: "active_task",
      text: "send the deck after the call",
      source: {turnId: "t1", turnAt: 1},
      expiresAt: 1,
    })
    expect((await m.list()).length).toBe(0) // already hidden
    expect((await m.list({includeExpired: true})).length).toBe(1) // but still there

    const receipt = await m.collect()
    expect(receipt.deleted).toBe(1)
    expect(receipt.ids).toEqual([stored.id])
    expect((await m.list({includeExpired: true})).length).toBe(0)
  })

  test("a live memory is left alone", async () => {
    const m = service()
    await m.add({
      class: "active_task",
      text: "order the dev kit",
      source: {turnId: "t1", turnAt: 1},
      expiresAt: Number.MAX_SAFE_INTEGER,
    })
    expect((await m.collect()).deleted).toBe(0)
    expect((await m.list()).length).toBe(1)
  })

  test("a memory with no expiry is never collected", async () => {
    const m = service()
    await m.add({class: "profile_fact", text: "works on wearables", source: {turnId: "t1", turnAt: 1}})
    expect((await m.collect()).deleted).toBe(0)
  })

  test("a pinned memory is never collected, which is what pinning means", async () => {
    const m = service()
    await m.add({
      class: "episodic",
      text: "met Tanu at the Agara Lake walk",
      source: {turnId: "t1", turnAt: 1},
      expiresAt: 1,
      pinned: true,
    })
    expect((await m.collect()).deleted).toBe(0)
    expect((await m.list({includeExpired: true})).length).toBe(1)
  })

  test("the collected memory is gone from search too", async () => {
    const m = service()
    await m.add({
      class: "active_task",
      text: "chase the compressor quote",
      source: {turnId: "t1", turnAt: 1},
      expiresAt: 1,
    })
    await m.collect()
    expect((await m.search("compressor")).length).toBe(0)
  })
})

describe("applying a consolidation plan", () => {
  const pref = (text: string) => ({
    class: "stable_preference" as const,
    text,
    source: {turnId: "t1", turnAt: 1},
  })

  test("duplicates are merged and the store shrinks", async () => {
    const m = service()
    await m.add(pref("keep answers short and direct"))
    await m.add(pref("keep answers short and direct"))
    const plan = await m.consolidationPlan()
    expect(plan.duplicates.length).toBe(1)

    const result = await m.applyDedupe(plan.duplicates)
    expect(result.merged).toBe(1)
    expect(result.removed).toBe(1)
    expect((await m.list()).length).toBe(1)
  })

  test("the plan itself writes nothing", async () => {
    const m = service()
    await m.add(pref("keep answers short and direct"))
    await m.add(pref("keep answers short and direct"))
    await m.consolidationPlan()
    expect((await m.list()).length).toBe(2)
  })

  test("contradictions are reported and left alone for the wearer to settle", async () => {
    const m = service()
    await m.add(pref("keep answers short"))
    await m.add(pref("keep answers long"))
    const plan = await m.consolidationPlan()
    expect(plan.contradictions.length).toBe(1)
    // applyDedupe touches only duplicates.
    await m.applyDedupe(plan.duplicates)
    expect((await m.list()).length).toBe(2)
  })

  test("captured memories in different scopes are never merged", async () => {
    const m = service()
    const cap = (scopeId: string) => ({
      class: "episodic" as const,
      text: "the compressor was replaced in March",
      source: {turnId: "t1", turnAt: 1, provenance: "captured" as const, scopeId},
    })
    await m.add(cap("scope-1"))
    await m.add(cap("scope-2"))

    const plan = await m.consolidationPlan()
    expect(plan.duplicates).toEqual([])
    expect((await m.list()).length).toBe(2)
    // Each scope still deletes exactly its own.
    expect((await m.deleteScope("scope-1")).deleted).toBe(1)
    expect((await m.list()).length).toBe(1)
  })

  test("a hand-made group crossing scopes is refused even if passed directly", async () => {
    // The plan is re-checked on apply: merging across a consent scope must be
    // impossible even by accident or by a stale plan.
    const m = service()
    const a = await m.add({
      class: "episodic",
      text: "the compressor was replaced in March",
      source: {turnId: "t1", turnAt: 1, provenance: "captured", scopeId: "scope-1"},
    })
    const b = await m.add({
      class: "episodic",
      text: "the compressor was replaced in March",
      source: {turnId: "t1", turnAt: 1, provenance: "captured", scopeId: "scope-2"},
    })
    const result = await m.applyDedupe([{keep: a, merge: [b], similarity: 1}])
    expect(result.merged).toBe(0)
    expect((await m.list()).length).toBe(2)
  })

  test("a merged memory is still findable by the text that survived", async () => {
    const m = service()
    await m.add(pref("keep answers short and direct"))
    await m.add(pref("keep answers short and direct please"))
    const plan = await m.consolidationPlan()
    expect(plan.duplicates.length).toBe(1)
    await m.applyDedupe(plan.duplicates)
    const hits = await m.search("answers")
    expect(hits.length).toBe(1)
    // The fuller wording is what survived, and it is what search finds.
    expect(hits[0].memory.text).toContain("please")
  })

  test("an empty plan is harmless", async () => {
    const m = service()
    await m.add(pref("keep answers short"))
    expect(await m.applyDedupe([])).toEqual({merged: 0, removed: 0})
    expect((await m.list()).length).toBe(1)
  })
})
