/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {EmbeddingUnavailableError, FakeEmbeddingProvider} from "../embeddings"
import {MemoryService} from "../memory"
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
    })
    const s = await other.stats()
    expect(s.total).toBe(1)
    expect(s.vectorStatus).toBe("model_changed")
    expect(s.queued).toBe(1)
  })
})
