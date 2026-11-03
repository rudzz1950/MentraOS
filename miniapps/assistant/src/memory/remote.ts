/**
 * @fileoverview MemoryStore backed by the Project K memory API (ANI-270 / ANI-267).
 *
 * The same port as MemoryService, so callers do not change: the context engine, the
 * turn loop and the settings screens can be pointed at the cloud store per user. The
 * server holds the multi-user rules (isolation, consent, retention at write); this
 * client adds nothing to them and hides nothing from them.
 *
 * Two things stay on the phone on purpose:
 *
 *   * CAPTURED MEMORIES without a cloud consent scope. Patch 0019 keeps captured memory
 *     on the device by default. `scopeFor` maps a device scope to the cloud scope for
 *     the same grant; with no mapping, `add` throws UnscopedCaptureError rather than
 *     sending it, and the host keeps it in the local MemoryService.
 *   * THE USER'S TOKEN. `token()` is asked for one on every request and never stored here.
 *
 * Errors come back as the same error types MemoryService throws, so existing handling works.
 */

import {UnscopedCaptureError, type MemoryStore} from "./memory"
import {SensitiveInferenceError, type SensitiveCategory} from "./sensitive"
import type {
  ImportReport,
  Memory,
  MemoryClass,
  MemoryExport,
  MemoryInput,
  MemoryPage,
  MemoryPatch,
  PageOptions,
  SearchOptions,
  SearchResult,
} from "./types"

export interface RemoteMemoryOptions {
  /** e.g. https://api.example.in */
  baseUrl: string
  /** The signed-in user's access token, fetched fresh for each request. */
  token: () => Promise<string>
  /** Device consent scope -> cloud scope id for the same grant. Undefined: keep it local. */
  scopeFor?: (deviceScopeId: string) => string | undefined
  fetch?: typeof fetch
  /** Per request. Default 10 s. */
  timeoutMs?: number
}

export class RemoteMemoryError extends Error {
  constructor(readonly status: number, readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = "RemoteMemoryError"
  }
}

export class RemoteMemoryStore implements MemoryStore {
  private readonly fetch: typeof fetch

  constructor(private readonly opts: RemoteMemoryOptions) {
    this.fetch = opts.fetch ?? fetch
  }

  async add(input: MemoryInput): Promise<Memory> {
    return this.call("POST", "/v1/memories", this.mapScope(input))
  }

  async get(id: string): Promise<Memory | null> {
    return this.call("GET", `/v1/memories/${encodeURIComponent(id)}`, undefined, true)
  }

  async list(opts: {classes?: MemoryClass[]; includeExpired?: boolean} = {}): Promise<Memory[]> {
    const out: Memory[] = []
    let cursor: string | undefined
    do {
      const page = await this.listPage({...opts, cursor})
      out.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    return out
  }

  async listPage(opts: PageOptions = {}): Promise<MemoryPage> {
    const q = new URLSearchParams()
    if (opts.classes?.length) q.set("classes", opts.classes.join(","))
    if (opts.includeExpired) q.set("includeExpired", "true")
    if (opts.limit) q.set("limit", String(opts.limit))
    if (opts.cursor) q.set("cursor", opts.cursor)
    return this.call("GET", `/v1/memories?${q}`)
  }

  async search(query: string, k = 5, opts: SearchOptions = {}): Promise<SearchResult[]> {
    return this.call("POST", "/v1/memories/search", {query, k, classes: opts.classes, tags: opts.tags})
  }

  async update(id: string, patch: MemoryPatch): Promise<Memory | null> {
    return this.call("PATCH", `/v1/memories/${encodeURIComponent(id)}`, patch, true)
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.call<{deleted: boolean}>("DELETE", `/v1/memories/${encodeURIComponent(id)}`, undefined, true)
    return r?.deleted ?? false
  }

  async exportAll(): Promise<MemoryExport> {
    return this.call("GET", "/v1/export")
  }

  async importAll(dump: MemoryExport): Promise<number> {
    return (await this.importChecked(dump)).imported
  }

  /** What the server took, and what it refused and why. Nothing is re-scoped to get it across. */
  async importChecked(dump: MemoryExport): Promise<ImportReport> {
    const mapped: MemoryExport = {...dump, memories: dump.memories.map(m => ({...m, source: this.scopeSource(m.source)}))}
    return this.call("POST", "/v1/import", mapped)
  }

  private mapScope(input: MemoryInput): MemoryInput {
    if ((input.source.provenance ?? "self_reported") !== "captured") return input
    const cloud = input.source.scopeId ? this.opts.scopeFor?.(input.source.scopeId) : undefined
    if (!cloud) throw new UnscopedCaptureError()
    return {...input, source: {...input.source, scopeId: cloud}}
  }

  private scopeSource(source: Memory["source"]): Memory["source"] {
    if ((source.provenance ?? "self_reported") !== "captured" || !source.scopeId) return source
    // An unmapped capture is sent unscoped-in-the-cloud, and the server refuses it. It is
    // reported back, which is the point: the user sees what stayed on the phone.
    return {...source, scopeId: this.opts.scopeFor?.(source.scopeId) ?? source.scopeId}
  }

  private async call<T>(method: string, path: string, body?: unknown, nullOn404 = false): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000)
    try {
      const res = await this.fetch(this.opts.baseUrl.replace(/\/$/, "") + path, {
        method,
        headers: {
          authorization: `Bearer ${await this.opts.token()}`,
          ...(body !== undefined ? {"content-type": "application/json"} : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      if (res.ok) return (await res.json()) as T
      if (res.status === 404 && nullOn404) return null as T
      let err: {error?: string; detail?: string} = {}
      try {
        err = await res.json()
      } catch {
        // not JSON: keep the status
      }
      if (err.error === "unscoped_capture") throw new UnscopedCaptureError()
      if (err.error === "sensitive_inference") throw new SensitiveInferenceError((err.detail ?? "health") as SensitiveCategory)
      throw new RemoteMemoryError(res.status, err.error ?? "http_error", err.detail)
    } finally {
      clearTimeout(timer)
    }
  }
}
