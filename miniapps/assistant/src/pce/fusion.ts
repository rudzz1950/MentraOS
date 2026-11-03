/**
 * @fileoverview Combining readings from ring, glasses and phone without pretending they agree. ANI-202.
 *
 * Three problems, three parts:
 *
 *   CLOCKS. Each device has its own monotonic clock. ClockAligner estimates,
 *   per source, the offset to the phone (from the fastest-delivered sample,
 *   as the event receiver does) and the drift (from how that offset moves
 *   over a window), and reports its uncertainty. A sample is placed on the
 *   phone's timeline with an error bar, not a point.
 *
 *   DISAGREEMENT. fuse() takes observations of one quantity from several
 *   sources. Stale ones are excluded. If the fresh ones disagree, the result
 *   is "conflict" with every reading attached — NOT an average, because the
 *   average of "driving" and "walking" is not a real state. If there are
 *   none, it is "missing". Only agreement is "ok".
 *
 *   USE. Every fused result carries its sources, their event ids, their
 *   consent scopes and a confidence. `usableFor` gates it by a declared
 *   threshold per purpose, and refuses consequential use outright: an
 *   uncertain fusion can shape a suggestion, never send a message.
 *
 * Wellness readings are summaries; nothing here derives a diagnosis or any
 * other sensitive attribute from them.
 */

export interface Sample {
  source: string
  eventId: string
  /** The source's own monotonic time. */
  deviceTimeMs: number
  /** When the phone received it. */
  receivedAt: number
}

export class ClockAligner {
  private points = new Map<string, {device: number; offset: number}[]>()
  private lastDevice = new Map<string, number>()

  constructor(private readonly windowSize = 32) {}

  /**
   * Record a sample. Returns false for a replay or a clock that went
   * backwards, which is excluded rather than corrupting the estimate.
   */
  observe(s: Sample): boolean {
    const last = this.lastDevice.get(s.source)
    if (last !== undefined && s.deviceTimeMs <= last) return false
    this.lastDevice.set(s.source, s.deviceTimeMs)
    const pts = this.points.get(s.source) ?? []
    pts.push({device: s.deviceTimeMs, offset: s.receivedAt - s.deviceTimeMs})
    if (pts.length > this.windowSize) pts.shift()
    this.points.set(s.source, pts)
    return true
  }

  /**
   * Offset (phone = device + offset), drift in ppm, and uncertainty in ms.
   * The offset is the smallest seen, adjusted for drift, because delivery
   * delay only ever adds. Uncertainty is the spread of delays above that floor.
   */
  estimate(source: string): {offsetMs: number; driftPpm: number; uncertaintyMs: number} | null {
    const pts = this.points.get(source)
    if (!pts || pts.length === 0) return null
    let drift = 0
    if (pts.length >= 4) {
      // Drift from the lower envelope: the minimum offset in the first and last quarter.
      const q = Math.max(1, Math.floor(pts.length / 4))
      const head = pts.slice(0, q).reduce((a, b) => (b.offset < a.offset ? b : a))
      const tail = pts.slice(-q).reduce((a, b) => (b.offset < a.offset ? b : a))
      const span = tail.device - head.device
      if (span > 0) drift = (tail.offset - head.offset) / span
    }
    const ref = pts[pts.length - 1].device
    const adjusted = pts.map(p => p.offset + drift * (ref - p.device))
    const floor = Math.min(...adjusted)
    const delays = adjusted.map(a => a - floor).sort((a, b) => a - b)
    const p90 = delays[Math.min(delays.length - 1, Math.floor(delays.length * 0.9))]
    return {offsetMs: floor, driftPpm: drift * 1e6, uncertaintyMs: Math.max(1, p90)}
  }

  /** A device time on the phone's timeline, with its error bar. */
  toPhoneTime(source: string, deviceTimeMs: number): {at: number; plusMinusMs: number} | null {
    const e = this.estimate(source)
    if (!e) return null
    const pts = this.points.get(source)!
    const ref = pts[pts.length - 1].device
    return {at: deviceTimeMs + e.offsetMs + (e.driftPpm / 1e6) * (deviceTimeMs - ref), plusMinusMs: e.uncertaintyMs}
  }
}

export interface Observation<T> {
  source: string
  eventId: string
  value: T
  /** On the phone's timeline. */
  at: number
  confidence: number
  scopeId?: string
  /** Flags from the source: "motion_artifact", "low_battery", ... */
  quality?: string[]
}

export interface Fused<T> {
  status: "ok" | "conflict" | "stale" | "missing"
  value?: T
  confidence: number
  sources: {source: string; eventId: string; value: T; at: number; confidence: number; scopeId?: string}[]
  /** Scopes the result inherits: it is as restricted as everything it came from. */
  scopes: string[]
  reason?: string
}

export interface FuseOptions<T> {
  now: number
  /** Readings older than this are stale. */
  freshnessMs: number
  /** Whether two values agree. Defaults to strict equality. */
  agree?: (a: T, b: T) => boolean
  /** Readings flagged with any of these are excluded. */
  rejectQuality?: string[]
  /** Values outside what is physically possible. */
  plausible?: (v: T) => boolean
}

export function fuse<T>(obs: Observation<T>[], opts: FuseOptions<T>): Fused<T> {
  const agree = opts.agree ?? ((a, b) => a === b)
  const reject = new Set(opts.rejectQuality ?? ["motion_artifact"])
  const usable = obs.filter(o =>
    o.confidence > 0 &&
    !(o.quality ?? []).some(q => reject.has(q)) &&
    (opts.plausible ? opts.plausible(o.value) : true) &&
    o.at <= opts.now + 1000,
  )
  const fresh = usable.filter(o => opts.now - o.at <= opts.freshnessMs)
  const toSource = (o: Observation<T>) => ({source: o.source, eventId: o.eventId, value: o.value, at: o.at, confidence: o.confidence, scopeId: o.scopeId})
  const scopes = [...new Set(fresh.flatMap(o => (o.scopeId ? [o.scopeId] : [])))].sort()

  if (fresh.length === 0) {
    return usable.length
      ? {status: "stale", confidence: 0, sources: usable.map(toSource), scopes: [], reason: "every reading is older than the freshness window"}
      : {status: "missing", confidence: 0, sources: [], scopes: [], reason: obs.length ? "no plausible, artifact-free reading" : "no readings"}
  }
  const first = fresh[0].value
  if (fresh.some(o => !agree(o.value, first))) {
    return {status: "conflict", confidence: 0, sources: fresh.map(toSource), scopes, reason: "sources disagree"}
  }
  // Agreement from independent sources raises confidence; it is never higher
  // than the most confident source alone would justify plus a bounded bonus.
  const best = Math.max(...fresh.map(o => o.confidence))
  const distinct = new Set(fresh.map(o => o.source)).size
  const confidence = Math.min(0.99, best + 0.1 * (distinct - 1))
  const newest = fresh.reduce((a, b) => (b.at > a.at ? b : a))
  return {status: "ok", value: newest.value, confidence, sources: fresh.map(toSource), scopes}
}

/** Declared thresholds per use. Consequential use is not in the table, on purpose. */
export const CONFIDENCE_THRESHOLDS = {
  display_hint: 0.5,
  suggestion: 0.7,
  restrict_ui: 0.6,
} as const

export function usableFor<T>(f: Fused<T>, purpose: keyof typeof CONFIDENCE_THRESHOLDS | "consequential"): boolean {
  if (purpose === "consequential") return false
  return f.status === "ok" && f.confidence >= CONFIDENCE_THRESHOLDS[purpose]
}
