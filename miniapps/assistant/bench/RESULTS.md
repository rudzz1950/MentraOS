# Memory store at scale (ANI-204)

`bun bench/memory.bench.ts`. In-process stores and the fake 384-dimension
embedder, so this is the service's own cost, not a provider round trip or
device flash. Measured in the cloud build container on 3 Nov 2026, **not on a
phone** — expect a phone to be several times slower. The shape matters more
than the numbers.

| Memories | Write p50 / p95 | Search p50 / p95 (k=5) | Page of 50 | Heap |
| ---: | --- | --- | --- | ---: |
| 1,000 | 0.36 / 1.62 ms | 2.49 / 3.75 ms | 0.13 ms | +9.8 MB |
| 5,000 | 1.58 / 4.12 ms | 10.57 / 17.88 ms | 0.56 ms | +35.2 MB |
| 10,000 | 2.83 / 7.40 ms | 28.25 / 33.93 ms | 1.08 ms | +49.8 MB |

## What this says

- **Search is fine at personal scale.** Brute-force cosine over 10k vectors stays
  well under the 300 ms rules-path budget, as the comment in `vectors.ts` predicted.
- **Writes are the problem, and they grow linearly.** Every `add` rewrites the
  whole id index and the whole vector blob — about 15 MB at 10k memories. In
  memory that is cheap; on phone flash it is a full-file rewrite per memory, plus
  the wear that comes with it. This is the concrete case for the SQLite move:
  a row insert and a vector append instead of rewriting everything.
- **Every row is held in RAM.** `listPage` bounds what a caller gets back, but
  the service still loads every row at start. Bounded *loading* also needs the
  native store.

Neither is fixed here. Both belong to the native `MemoryStore`, which the
existing seam was built for.
