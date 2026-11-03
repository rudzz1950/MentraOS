/**
 * @fileoverview Diagnosable without becoming a second store of personal content. ANI-211.
 *
 * Telemetry here is structurally unable to carry content, rather than
 * carefully filtered:
 *
 *   - Attributes are numbers, booleans, or short identifier-shaped strings
 *     (`[a-z0-9_.:-]`, 64 chars). A transcript, a name, an address or a
 *     payload cannot be expressed in that alphabet, so it is dropped and
 *     counted, not stored.
 *   - Device ids are pseudonymised with a per-install salt before they are
 *     recorded, so a log does not identify hardware across installs.
 *   - Error messages, the one place free text gets in, are scrubbed of
 *     emails, phone numbers, UPI addresses, long digit runs, URLs and base64.
 *
 * Spans give one trace across a turn: receive, normalise, context, memory,
 * model first token, dispatch, render, audio start, haptic ack. Everything
 * stays local (no managed service is required); a support bundle is built
 * only on the wearer's say-so, after they have seen a preview.
 */

export type Stage =
  | "event_receive"
  | "normalize"
  | "context_assembly"
  | "memory_retrieval"
  | "model_first_token"
  | "model_complete"
  | "action_dispatch"
  | "hud_render"
  | "audio_start"
  | "haptic_ack"

export type AttrValue = number | boolean | string
export interface SpanRecord {
  traceId: string
  stage: Stage
  startMs: number
  durationMs: number
  attrs: Record<string, AttrValue>
}

export interface Metric {
  name: string
  value: number
  at: number
  attrs: Record<string, AttrValue>
}

const SAFE_STRING = /^[a-z0-9_.:-]{1,64}$/
const SAFE_KEY = /^[a-z][a-z0-9_]{0,31}$/

/** Remove the shapes personal data takes from free text. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[a-z0-9._-]{2,}@[a-z]{2,}\b/gi, "[vpa]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?<![\w+])\+?\d[\d -]{8,}\d\b/g, "[number]")
    .replace(/\b\d{6,}\b/g, "[number]")
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}/g, "[blob]")
    .slice(0, 200)
}

function hash(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}

export interface AlertThresholds {
  /** Crashes within the window that count as a crash loop. */
  crashLoop: {count: number; windowMs: number}
  /** p95 latency per stage, ms. */
  p95Ms: Partial<Record<Stage, number>>
  /** Queue depth that is growth, not noise. */
  queueDepth: number
  repeatedDisconnect: {count: number; windowMs: number}
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  crashLoop: {count: 3, windowMs: 600_000},
  p95Ms: {model_first_token: 700, hud_render: 100, haptic_ack: 150, action_dispatch: 300},
  queueDepth: 50,
  repeatedDisconnect: {count: 5, windowMs: 600_000},
}

export type Alert = {kind: "crash_loop" | "high_latency" | "queue_growth" | "repeated_disconnect" | "revocation_failed"; detail: string}

export class Telemetry {
  private spans: SpanRecord[] = []
  private metrics: Metric[] = []
  private events: {name: string; at: number; attrs: Record<string, AttrValue>}[] = []
  dropped = 0
  private n = 0

  constructor(
    private readonly opts: {
      now: () => number
      /** Per-install salt for pseudonyms. Never leaves the device. */
      salt: string
      /** Local retention, ms. A day by default; on-prem sets its own. */
      retentionMs?: number
      versions: {app: string; firmware?: Record<string, string>}
    },
  ) {}

  newTrace(): string {
    return hash(`${this.opts.salt}:${this.opts.now()}:${++this.n}`)
  }

  /** A stable pseudonym for a device id, for this install only. */
  pseudonym(deviceId: string): string {
    return `dev:${hash(`${this.opts.salt}|${deviceId}`).slice(0, 12)}`
  }

  span(traceId: string, stage: Stage, startMs: number, endMs: number, attrs: Record<string, unknown> = {}): void {
    this.prune()
    this.spans.push({traceId, stage, startMs, durationMs: Math.max(0, endMs - startMs), attrs: this.clean(attrs)})
  }

  metric(name: string, value: number, attrs: Record<string, unknown> = {}): void {
    if (!SAFE_KEY.test(name) || !Number.isFinite(value)) {
      this.dropped++
      return
    }
    this.prune()
    this.metrics.push({name, value, at: this.opts.now(), attrs: this.clean(attrs)})
  }

  /** A discrete event (crash, disconnect, revocation failure). Errors are scrubbed. */
  event(name: string, attrs: Record<string, unknown> = {}, error?: unknown): void {
    if (!SAFE_KEY.test(name)) {
      this.dropped++
      return
    }
    const a = this.clean(attrs)
    if (error !== undefined) a.error = scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    this.prune()
    this.events.push({name, at: this.opts.now(), attrs: a})
  }

  /** One trace, stage by stage, in order. */
  trace(traceId: string): SpanRecord[] {
    return this.spans.filter(s => s.traceId === traceId).sort((a, b) => a.startMs - b.startMs)
  }

  p95(stage: Stage): number | null {
    const xs = this.spans.filter(s => s.stage === stage).map(s => s.durationMs).sort((a, b) => a - b)
    if (!xs.length) return null
    return xs[Math.max(0, Math.ceil(0.95 * xs.length) - 1)]
  }

  alerts(t: AlertThresholds = DEFAULT_THRESHOLDS): Alert[] {
    const now = this.opts.now()
    const out: Alert[] = []
    const recent = (name: string, ms: number) => this.events.filter(e => e.name === name && now - e.at <= ms).length
    if (recent("crash", t.crashLoop.windowMs) >= t.crashLoop.count) out.push({kind: "crash_loop", detail: `${recent("crash", t.crashLoop.windowMs)} crashes`})
    for (const [stage, limit] of Object.entries(t.p95Ms) as [Stage, number][]) {
      const p = this.p95(stage)
      if (p !== null && p > limit) out.push({kind: "high_latency", detail: `${stage} p95 ${p} ms > ${limit}`})
    }
    const depth = [...this.metrics].reverse().find(m => m.name === "queue_depth")
    if (depth && depth.value >= t.queueDepth) out.push({kind: "queue_growth", detail: `queue depth ${depth.value}`})
    const dc = recent("disconnect", t.repeatedDisconnect.windowMs)
    if (dc >= t.repeatedDisconnect.count) out.push({kind: "repeated_disconnect", detail: `${dc} disconnects`})
    // A failed revocation is always an alert: there is no acceptable rate.
    if (this.events.some(e => e.name === "revocation_failed")) out.push({kind: "revocation_failed", detail: "revocation did not propagate to every store"})
    return out
  }

  /** What a support bundle would contain, for the wearer to look at first. */
  preview(): {spans: number; metrics: number; events: number; versions: Telemetry["opts"]["versions"]; sample: unknown[]} {
    return {
      spans: this.spans.length,
      metrics: this.metrics.length,
      events: this.events.length,
      versions: this.opts.versions,
      sample: this.events.slice(-5),
    }
  }

  /** The bundle itself. Only with the wearer's explicit authorisation, after a preview. */
  exportBundle(authorisation: {userAuthorised: true; previewedAt: number}): string {
    if (authorisation?.userAuthorised !== true || !(authorisation.previewedAt <= this.opts.now())) {
      throw new Error("A diagnostic bundle needs the user's authorisation after a preview")
    }
    return JSON.stringify({kind: "diagnostic_bundle", createdAt: this.opts.now(), versions: this.opts.versions, spans: this.spans, metrics: this.metrics, events: this.events, dropped: this.dropped})
  }

  private clean(attrs: Record<string, unknown>): Record<string, AttrValue> {
    const out: Record<string, AttrValue> = {}
    for (const [k, v] of Object.entries(attrs)) {
      const ok = SAFE_KEY.test(k) && (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && SAFE_STRING.test(v)))
      if (ok) out[k] = v as AttrValue
      else this.dropped++
    }
    return out
  }

  private prune() {
    const cutoff = this.opts.now() - (this.opts.retentionMs ?? 86_400_000)
    this.spans = this.spans.filter(s => s.startMs >= cutoff)
    this.metrics = this.metrics.filter(m => m.at >= cutoff)
    this.events = this.events.filter(e => e.at >= cutoff)
  }
}
