/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {EmbeddingUnavailableError, FakeEmbeddingProvider} from "../embeddings"
import {MemoryMaintenance} from "../maintenance"
import {MAX_PAGE_SIZE, MemoryService, RevokedScopeError, UnscopedCaptureError} from "../memory"
import {MemoryBlobStore, MemoryKeyValueStore} from "../ports"
import {SensitiveInferenceError} from "../sensitive"
import type {Memory, MemoryInput} from "../types"
import {modelTag, packVectors, unpackVectors} from "../vectors"

const DAY = 86_400_000

/** A clock the test moves by hand. */
function clock(start = 1_761_000_000_000) {
  const c = {t: start, now: () => c.t, advance: (ms: number) => (c.t += ms)}
  return c
}

function service(opts: Partial<ConstructorParameters<typeof MemoryService>[0]> = {}) {
  let n = 0
  return new MemoryService({
    storage: new MemoryKeyValueStore(),
    blobs: new MemoryBlobStore(),
    provider: new FakeEmbeddingProvider(32),
    embeddingsEnabled: true,
    idgen: () => `m${++n}`,
    ...opts,
  })
}

const note = (text: string, extra: Partial<MemoryInput> = {}): MemoryInput => ({
  class: "episodic",
  text,
  source: {turnId: "t1", turnAt: 1},
  ...extra,
})

const captured = (text: string, scopeId: string): MemoryInput =>
  note(text, {source: {turnId: "t1", turnAt: 1, provenance: "captured", scopeId}})

describe("tasks are kept until done, then for the retention period", () => {
  test("an open task has no expiry, however old it gets", async () => {
    const c = clock()
    const m = service({now: c.now})
    const task = await m.add(note("send the deck after the call", {class: "active_task"}))
    expect(task.expiresAt).toBeUndefined()
    c.advance(365 * DAY)
    expect((await m.collect()).deleted).toBe(0)
    expect(await m.get(task.id)).not.toBeNull()
  })

  test("completing a task starts a seven-day clock, and collection honours it", async () => {
    const c = clock()
    const m = service({now: c.now})
    const task = await m.add(note("send the deck", {class: "active_task"}))
    c.advance(3 * DAY)
    const done = await m.complete(task.id)
    expect(done!.completedAt).toBe(c.t)
    expect(done!.expiresAt).toBe(c.t + 7 * DAY)

    c.advance(7 * DAY - 1)
    expect((await m.collect()).deleted).toBe(0)
    c.advance(1)
    expect((await m.collect()).ids).toEqual([task.id])
  })

  test("completing twice does not extend retention", async () => {
    const c = clock()
    const m = service({now: c.now})
    const task = await m.add(note("chase the quote", {class: "active_task"}))
    const first = (await m.complete(task.id))!.expiresAt
    c.advance(5 * DAY)
    expect((await m.complete(task.id))!.expiresAt).toBe(first)
  })

  test("reopening stops the clock", async () => {
    const c = clock()
    const m = service({now: c.now})
    const task = await m.add(note("chase the quote", {class: "active_task"}))
    await m.complete(task.id)
    const open = await m.reopen(task.id)
    expect(open!.completedAt).toBeUndefined()
    expect(open!.expiresAt).toBeUndefined()
    c.advance(30 * DAY)
    expect((await m.collect()).deleted).toBe(0)
  })

  test("only a task can be completed", async () => {
    const m = service()
    const fact = await m.add(note("met Tanu at the lake"))
    await expect(m.complete(fact.id)).rejects.toThrow(/active_task/)
  })

  test("retention is applied at write time when a class has one", async () => {
    const c = clock()
    const m = service({now: c.now, retention: {episodic: {afterCreateMs: 30 * DAY}}})
    const e = await m.add(note("parked on level 3"))
    expect(e.expiresAt).toBe(c.t + 30 * DAY)
    // An explicit expiry from the caller wins over the class default.
    const short = await m.add(note("gate code 4411", {expiresAt: c.t + DAY}))
    expect(short.expiresAt).toBe(c.t + DAY)
    // Classes without a policy get no invented expiry.
    expect((await m.add(note("works on wearables", {class: "profile_fact"}))).expiresAt).toBeUndefined()
  })
})

describe("pinned means it never expires, in reads too", () => {
  test("a pinned memory past its expiry is still listed and found", async () => {
    // Collection already skipped pinned rows, but list and search hid them,
    // so a pinned memory with an old expiry was kept forever and shown never.
    const m = service({now: () => 10})
    await m.add(note("met Tanu at the Agara Lake walk", {pinned: true, expiresAt: 1}))
    expect((await m.list()).length).toBe(1)
    expect((await m.search("Tanu")).length).toBe(1)
  })
})

describe("update obeys the same rules as add", () => {
  test("cannot turn a stated memory into an unapproved inference", async () => {
    const m = service()
    const saved = await m.add(note("likes short answers", {class: "stable_preference"}))
    await expect(m.update(saved.id, {class: "inferred_preference", approved: false})).rejects.toThrow(/approval/)
    expect((await m.get(saved.id))!.class).toBe("stable_preference")
  })

  test("cannot give an approved inference sensitive text", async () => {
    const m = service()
    const saved = await m.add(note("prefers Hindi for casual replies", {class: "inferred_preference", approved: true}))
    await expect(m.update(saved.id, {text: "is probably pregnant"})).rejects.toThrow(SensitiveInferenceError)
    expect((await m.get(saved.id))!.text).toBe("prefers Hindi for casual replies")
  })

  test("a memory that stops being a task loses its completion", async () => {
    const m = service()
    const task = await m.add(note("send the deck", {class: "active_task"}))
    await m.complete(task.id)
    expect((await m.update(task.id, {class: "episodic"}))!.completedAt).toBeUndefined()
  })
})

describe("revocation survives restores, reloads and late writes", () => {
  test("a write queued before revocation is refused after it", async () => {
    const m = service()
    await m.add(captured("Asha said the vendor slipped", "scope-1"))
    await m.deleteScope("scope-1")
    await expect(m.add(captured("Asha also said the price rose", "scope-1"))).rejects.toThrow(RevokedScopeError)
    // Other scopes are untouched.
    await m.add(captured("Ravi confirmed the date", "scope-2"))
    expect(await m.scopes()).toEqual(["scope-2"])
  })

  test("restoring an old backup does not bring revoked rows back", async () => {
    const m = service()
    await m.add(captured("Asha said the vendor slipped", "scope-1"))
    await m.add(note("my own note"))
    const backup = await m.exportAll()

    await m.deleteScope("scope-1")
    const report = await m.importChecked(backup)
    expect(report.imported).toBe(1)
    expect(report.revoked.length).toBe(1)
    expect(await m.scopes()).toEqual([])
  })

  test("the revocation is remembered across a reload", async () => {
    const storage = new MemoryKeyValueStore()
    const blobs = new MemoryBlobStore()
    const m = service({storage, blobs})
    await m.add(captured("Asha said the vendor slipped", "scope-1"))
    await m.deleteScope("scope-1")

    const reloaded = service({storage, blobs})
    expect(await reloaded.revokedScopes()).toEqual(["scope-1"])
    await expect(reloaded.add(captured("late write", "scope-1"))).rejects.toThrow(RevokedScopeError)
  })

  test("a revocation interrupted halfway is finished on the next load", async () => {
    const storage = new MemoryKeyValueStore()
    const m = service({storage})
    const a = await m.add(captured("one", "scope-1"))
    await m.add(captured("two", "scope-1"))
    // Simulate a crash after the revocation was recorded but before the rows
    // went: record it by hand and leave the rows in storage.
    await storage.set("mem:revoked", JSON.stringify(["scope-1"]))

    const reloaded = service({storage})
    expect(await reloaded.get(a.id)).toBeNull()
    expect((await reloaded.list()).length).toBe(0)
    expect(await storage.get("mem:" + a.id)).toBeNull()
  })
})

describe("import is held to the write-path rules", () => {
  const dump = (memories: Partial<Memory>[]) => ({
    version: 1 as const,
    exportedAt: 0,
    memories: memories.map((m, i) => ({
      id: `x${i}`,
      class: "episodic" as const,
      text: "something",
      tags: [],
      source: {turnId: "t", turnAt: 0},
      createdAt: 0,
      updatedAt: 0,
      pinned: false,
      approved: true,
      embedded: true,
      ...m,
    })) as Memory[],
  })

  test("an unscoped capture, an unapproved guess and a sensitive guess are refused", async () => {
    const m = service({now: () => 100})
    const report = await m.importChecked(
      dump([
        {text: "fine"},
        {source: {turnId: "t", turnAt: 0, provenance: "captured"}},
        {class: "inferred_preference", approved: false},
        {class: "inferred_preference", approved: true, text: "is probably pregnant"},
      ]),
    )
    expect(report.imported).toBe(1)
    expect(report.rejected.map(r => r.id)).toEqual(["x1", "x2", "x3"])
    expect(report.rejected[0].reason).toMatch(/scopeId/)
    expect((await m.list()).map(x => x.id)).toEqual(["x0"])
  })

  test("rows whose retention already ran out are not imported", async () => {
    const m = service({now: () => 100})
    const report = await m.importChecked(dump([{expiresAt: 50}, {expiresAt: 500}, {expiresAt: 50, pinned: true}]))
    expect(report.expired).toEqual(["x0"])
    expect(report.imported).toBe(2)
  })

  test("an unknown export version is refused outright", async () => {
    const m = service()
    await expect(m.importChecked({version: 2, exportedAt: 0, memories: []} as never)).rejects.toThrow(/version/)
  })

  test("importAll still returns the count", async () => {
    const m = service({now: () => 100})
    expect(await m.importAll(dump([{}, {source: {turnId: "t", turnAt: 0, provenance: "captured"}}]))).toBe(1)
  })
})

describe("a merged duplicate stays searchable by meaning", () => {
  test("the survivor is re-embedded, not left marked embedded with no vector", async () => {
    const m = service()
    await m.add(note("keep answers to two lines", {class: "stable_preference"}))
    await m.add(note("keep answers to two lines please", {class: "stable_preference"}))
    const plan = await m.consolidationPlan()
    expect(plan.duplicates.length).toBe(1)
    await m.applyDedupe(plan.duplicates)

    const stats = await m.stats()
    expect(stats.total).toBe(1)
    expect(stats.embedded).toBe(1)
    const [hit] = await m.search("answers two lines")
    expect(hit.breakdown.semantic).toBeGreaterThan(0)
  })
})

describe("the embedding queue drains in batches", () => {
  /** Online for `allow` requests, then offline. */
  class Metered extends FakeEmbeddingProvider {
    requests = 0
    constructor(public allow: number) {
      super(32)
    }
    async embed(texts: string[]) {
      if (this.requests++ >= this.allow) throw new EmbeddingUnavailableError("test: dropped")
      return super.embed(texts)
    }
  }

  test("a connection that drops partway keeps what already landed", async () => {
    const provider = new Metered(0)
    const m = service({provider})
    for (let i = 0; i < 10; i++) await m.add(note(`note ${i}`))
    expect((await m.stats()).queued).toBe(10)

    provider.requests = 0
    provider.allow = 2
    expect(await m.flushQueue({batchSize: 3})).toBe(6)
    expect((await m.stats()).queued).toBe(4)

    provider.requests = 0
    provider.allow = 99
    expect(await m.flushQueue({batchSize: 3})).toBe(4)
  })
})

describe("listing is paginated and bounded", () => {
  test("pages cover every row once, newest first", async () => {
    const c = clock()
    const m = service({now: () => c.advance(1)})
    for (let i = 0; i < 25; i++) await m.add(note(`note ${i}`))

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await m.listPage({limit: 10, cursor})
      seen.push(...page.items.map(x => x.text))
      cursor = page.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(seen.length).toBe(25)
    expect(new Set(seen).size).toBe(25)
    expect(seen[0]).toBe("note 24")
  })

  test("a write between pages neither repeats nor skips a row", async () => {
    const c = clock()
    const m = service({now: () => c.advance(1)})
    for (let i = 0; i < 6; i++) await m.add(note(`note ${i}`))
    const first = await m.listPage({limit: 3})
    await m.add(note("arrived between pages"))
    const second = await m.listPage({limit: 3, cursor: first.nextCursor})
    expect(second.items.map(x => x.text)).toEqual(["note 2", "note 1", "note 0"])
  })

  test("the page size is capped", async () => {
    const m = service()
    for (let i = 0; i < MAX_PAGE_SIZE + 5; i++) await m.add(note(`n${i}`))
    expect((await m.listPage({limit: 10_000})).items.length).toBe(MAX_PAGE_SIZE)
  })

  test("a malformed cursor is an error, not page one", async () => {
    const m = service()
    await expect(m.listPage({cursor: "garbage"})).rejects.toThrow(/cursor/)
  })
})

describe("the vector cache recognises its own model", () => {
  test("a model id longer than the header field still matches itself", async () => {
    // Previously cut to 32 bytes on write and compared in full on read, so
    // every launch discarded the cache and re-sent all memory to the provider.
    const id = "nomic-ai/nomic-embed-text-v1.5@768"
    expect(new TextEncoder().encode(id).length).toBeGreaterThan(32)
    const packed = packVectors({dim: 2, modelId: id, count: 1}, new Float32Array([1, 0]))
    expect(unpackVectors(packed, id).status).toBe("ok")
  })

  test("two long ids that share a 32-byte prefix do not match", () => {
    const a = "vendor/some-very-long-embedding-model-name@2026-10"
    const b = "vendor/some-very-long-embedding-model-name@2026-11"
    const packed = packVectors({dim: 2, modelId: a, count: 1}, new Float32Array([1, 0]))
    expect(unpackVectors(packed, b).status).toBe("model_changed")
    expect(modelTag(a).length).toBe(32)
  })

  test("short ids are stored as before, so existing caches stay valid", () => {
    expect(new TextDecoder().decode(modelTag("fake-64"))).toBe("fake-64")
  })

  test("a reload with a long model id keeps its vectors", async () => {
    class LongId extends FakeEmbeddingProvider {
      readonly modelId = "nomic-ai/nomic-embed-text-v1.5@768-long"
    }
    const storage = new MemoryKeyValueStore()
    const blobs = new MemoryBlobStore()
    const first = service({storage, blobs, provider: new LongId(32)})
    await first.add(note("sent the deck"))
    const second = service({storage, blobs, provider: new LongId(32)})
    const stats = await second.stats()
    expect(stats.vectorStatus).toBe("ok")
    expect(stats.queued).toBe(0)
  })
})

describe("maintenance runs on a schedule the host can see", () => {
  function fakeStore() {
    return {
      collects: 0,
      flushes: 0,
      failCollect: false,
      async collect() {
        this.collects++
        if (this.failCollect) throw new Error("disk full")
        return {deleted: 2, ids: ["a", "b"]}
      },
      async flushQueue() {
        this.flushes++
        return 3
      },
    }
  }

  test("both jobs run at launch, then on their own periods", async () => {
    const c = clock(0)
    const store = fakeStore()
    const mm = new MemoryMaintenance(store, c, {collectEveryMs: 1000, flushEveryMs: 300})
    expect(mm.nextDeadline()).toBe(0)
    const first = await mm.tick()
    expect(first!.ran).toEqual(["collect", "flush"])
    expect(first!.collected).toBe(2)
    expect(first!.embedded).toBe(3)

    expect(mm.nextDeadline()).toBe(300)
    c.advance(299)
    expect(await mm.tick()).toBeNull()
    c.advance(1)
    expect((await mm.tick())!.ran).toEqual(["flush"])
    c.advance(700)
    expect((await mm.tick())!.ran).toEqual(["collect", "flush"])
    expect(store.collects).toBe(2)
  })

  test("a host that slept through many periods gets one run, not a burst", async () => {
    const c = clock(0)
    const store = fakeStore()
    const mm = new MemoryMaintenance(store, c, {collectEveryMs: 1000, flushEveryMs: 1000})
    await mm.tick()
    c.advance(10_500)
    await mm.tick()
    expect(await mm.tick()).toBeNull()
    expect(store.collects).toBe(2)
    expect(mm.nextDeadline()).toBe(11_000)
  })

  test("a failing job is reported and does not stop the other", async () => {
    const c = clock(0)
    const store = fakeStore()
    store.failCollect = true
    const mm = new MemoryMaintenance(store, c)
    const report = await mm.tick()
    expect(report!.errors).toEqual([{job: "collect", message: "disk full"}])
    expect(report!.embedded).toBe(3)
    expect(mm.history().length).toBe(1)
  })

  test("runs do not overlap", async () => {
    const c = clock(0)
    let release!: () => void
    const store = {
      async collect() {
        await new Promise<void>(r => (release = r))
        return {deleted: 0, ids: []}
      },
      async flushQueue() {
        return 0
      },
    }
    const mm = new MemoryMaintenance(store, c)
    const running = mm.tick()
    expect(await mm.runNow()).toBeNull()
    release()
    expect(await running).not.toBeNull()
  })

  test("history is bounded", async () => {
    const c = clock(0)
    const mm = new MemoryMaintenance(fakeStore(), c, {historySize: 3})
    for (let i = 0; i < 5; i++) await mm.runNow()
    expect(mm.history().length).toBe(3)
  })

  test("drives a real store: an expired task is gone after the next tick", async () => {
    const c = clock()
    const m = service({now: c.now})
    const mm = new MemoryMaintenance(m, c)
    const task = await m.add(note("send the deck", {class: "active_task"}))
    await m.complete(task.id)
    await mm.tick()
    c.advance(7 * DAY + 3_600_000)
    const report = await mm.tick()
    expect(report!.collected).toBe(1)
    expect(await m.get(task.id)).toBeNull()
  })

  test("refuses a zero interval, which would spin", () => {
    expect(() => new MemoryMaintenance(fakeStore(), clock(0), {collectEveryMs: 0})).toThrow()
  })
})

void UnscopedCaptureError
