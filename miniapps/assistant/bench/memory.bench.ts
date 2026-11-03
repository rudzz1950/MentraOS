/**
 * Memory store at realistic and stress sizes (ANI-204). Run: bun bench/memory.bench.ts
 *
 * In-process stores and the fake 384-dim embedder, so this measures the
 * service's own cost — scoring, sorting, paging — not a provider round trip or
 * device storage. Numbers from a phone will be slower; the shape is the point.
 */
import {FakeEmbeddingProvider} from "../src/memory/embeddings"
import {MemoryService} from "../src/memory/memory"
import {MemoryBlobStore, MemoryKeyValueStore} from "../src/memory/ports"

const WORDS = "deck investors pitch dentist car service Tanu lake walk compressor quote vendor price meeting call send chase review plan budget".split(" ")

function sentence(i: number) {
  const w = (k: number) => WORDS[(i * 7 + k * 13) % WORDS.length]
  return `${w(0)} ${w(1)} ${w(2)} note ${i} ${w(3)} ${w(4)}`
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function run(n: number) {
  const m = new MemoryService({
    storage: new MemoryKeyValueStore(),
    blobs: new MemoryBlobStore(),
    provider: new FakeEmbeddingProvider(384),
    embeddingsEnabled: true,
  })
  const heapBefore = process.memoryUsage().heapUsed
  const writes: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    await m.add({class: "episodic", text: sentence(i), source: {turnId: `t${i}`, turnAt: i}})
    writes.push(performance.now() - t)
  }
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6

  const searches: number[] = []
  for (let i = 0; i < 50; i++) {
    const t = performance.now()
    await m.search(`${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]}`, 5)
    searches.push(performance.now() - t)
  }
  const pages: number[] = []
  for (let i = 0; i < 20; i++) {
    const t = performance.now()
    await m.listPage({limit: 50})
    pages.push(performance.now() - t)
  }
  console.log(
    `${String(n).padStart(6)} | write p50 ${pct(writes, 50).toFixed(2)} p95 ${pct(writes, 95).toFixed(2)} ms` +
      ` | search p50 ${pct(searches, 50).toFixed(2)} p95 ${pct(searches, 95).toFixed(2)} ms` +
      ` | page p50 ${pct(pages, 50).toFixed(2)} ms | heap +${heapMb.toFixed(1)} MB`,
  )
}

for (const n of [1_000, 5_000, 10_000]) await run(n)
