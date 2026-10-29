/**
 * @fileoverview Embedding providers.
 *
 * One interface, two implementations: a real HTTP one for the phone and a
 * deterministic fake for tests. No endpoint, model name or key is hard-coded
 * here — the caller passes them in, and the key comes from the host's secure
 * config at runtime, never from the repository.
 */

export interface EmbeddingProvider {
  /** Vector length this provider returns. Fixed per provider. */
  readonly dimensions: number
  /** Stable id stored alongside vectors, so a model change invalidates the cache. */
  readonly modelId: string
  /** Embed a batch. Must return one vector per input, in order. Throws when offline. */
  embed(texts: string[]): Promise<Float32Array[]>
}

export interface HttpEmbeddingConfig {
  /** Full URL of an OpenAI-compatible /embeddings endpoint. */
  endpoint: string
  model: string
  dimensions: number
  /** Supplied by the host at runtime. Never read from a file in this repo. */
  apiKey?: () => string | undefined
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Max texts per request. */
  batchSize?: number
  timeoutMs?: number
}

/** Thrown when the provider could not be reached. The caller queues and retries. */
export class EmbeddingUnavailableError extends Error {
  constructor(cause: string) {
    super(`Embedding provider unavailable: ${cause}`)
    this.name = "EmbeddingUnavailableError"
  }
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number
  readonly modelId: string
  private readonly cfg: Required<Pick<HttpEmbeddingConfig, "batchSize" | "timeoutMs">> & HttpEmbeddingConfig

  constructor(config: HttpEmbeddingConfig) {
    this.cfg = {batchSize: 32, timeoutMs: 10_000, ...config}
    this.dimensions = config.dimensions
    this.modelId = `${config.model}@${config.dimensions}`
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const doFetch = this.cfg.fetchImpl ?? globalThis.fetch
    if (!doFetch) throw new EmbeddingUnavailableError("no fetch implementation")
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += this.cfg.batchSize) {
      const batch = texts.slice(i, i + this.cfg.batchSize)
      const key = this.cfg.apiKey?.()
      let res: Response
      try {
        res = await doFetch(this.cfg.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? {authorization: `Bearer ${key}`} : {}),
          },
          body: JSON.stringify({model: this.cfg.model, input: batch}),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        })
      } catch (e) {
        // Network down, DNS failure, timeout: all recoverable, all queued.
        throw new EmbeddingUnavailableError(e instanceof Error ? e.message : String(e))
      }
      if (!res.ok) throw new EmbeddingUnavailableError(`HTTP ${res.status}`)
      const body = (await res.json()) as {data?: {embedding: number[]}[]}
      const rows = body.data ?? []
      if (rows.length !== batch.length) {
        throw new EmbeddingUnavailableError(`expected ${batch.length} vectors, got ${rows.length}`)
      }
      for (const row of rows) {
        if (row.embedding.length !== this.dimensions) {
          throw new EmbeddingUnavailableError(
            `model returned ${row.embedding.length} dimensions, expected ${this.dimensions}`,
          )
        }
        out.push(normalize(Float32Array.from(row.embedding)))
      }
    }
    return out
  }
}

/**
 * Deterministic bag-of-words embedding: no network, same text always gives the
 * same vector, and texts sharing vocabulary land near each other. Good enough
 * to test the retrieval machinery; useless as a real semantic model.
 *
 * Tests that need "different wording, same meaning" register synonym groups,
 * which map several words onto one dimension.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string
  private calls = 0

  constructor(
    readonly dimensions = 64,
    /** Each group's words share a dimension, so they read as synonyms. */
    private readonly synonymGroups: string[][] = [],
  ) {
    // Dimensions belong in the id: a cache written by a 64-dim model must not be
    // read back by a 32-dim one just because both are called "fake-bow".
    this.modelId = `fake-bow-v1@${dimensions}`
  }

  /** How many times `embed` was called. Lets a test assert the provider was never used. */
  get callCount() {
    return this.calls
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += 1
    return texts.map(t => this.one(t))
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dimensions)
    for (const word of tokenize(text)) {
      v[this.slot(word)] += 1
    }
    return normalize(v)
  }

  private slot(word: string): number {
    const groupIndex = this.synonymGroups.findIndex(g => g.includes(word))
    if (groupIndex >= 0) return groupIndex % this.dimensions
    // Reserve the low slots for synonym groups so hashing cannot collide with them.
    const reserved = Math.min(this.synonymGroups.length, this.dimensions)
    const span = this.dimensions - reserved
    return span > 0 ? reserved + (hash(word) % span) : hash(word) % this.dimensions
  }
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Unit-length, so cosine similarity is a dot product. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  if (norm === 0) return v
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}
