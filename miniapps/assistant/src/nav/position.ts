/**
 * @fileoverview Where the phone is, how sure it is, and how old that is. ANI-240.
 *
 * The Android binding (fused location provider, the Navigation SDK's
 * road-snapped location, the foreground service) cannot be compiled here.
 * This is everything after it: one PositionFix shape with explicit accuracy,
 * freshness, source and permission state, and the rules that stop a bad fix
 * being presented as a good one.
 *
 *   NEVER "EXACT" WHEN IT IS NOT. A fix is `precise` only when its accuracy
 *   radius is small and it is fresh. Otherwise it is `approximate`, `stale`
 *   or `lost`, and every consumer sees which. Approximate permission is always
 *   approximate, whatever the radius says.
 *
 *   RAW AND SNAPPED ARE KEPT APART. The SDK's map-matched position is better
 *   for display; the raw GNSS fix is what deviation and drift checks need.
 *   Both are kept, labelled.
 *
 *   PERMISSION CHANGES STOP THINGS. Revoking location, or the system
 *   suspending background location, stops route updates at once; the next
 *   fix after re-grant starts fresh rather than resuming a stale track.
 *
 *   LOGS GET COARSE LOCATION. `forLog` rounds to about a kilometre, and is
 *   the only form telemetry accepts.
 *
 * Glasses never supply coordinates: they have no GNSS, and a camera is not one.
 */

export type LocationPermission = "precise" | "approximate" | "denied" | "background_restricted"

export interface RawFix {
  latitude: number
  longitude: number
  /** Horizontal accuracy radius, metres (68% confidence on Android). */
  accuracyM: number
  altitudeM?: number
  speedMps?: number
  bearingDeg?: number
  /** Wall-clock time of the fix, epoch ms. */
  timeMs: number
  /** Monotonic elapsed-realtime of the fix, ms; survives wall-clock changes, not reboots. */
  elapsedMs: number
  source: "gnss" | "fused" | "network" | "sdk_snapped"
}

export type FixQuality = "precise" | "approximate" | "stale" | "lost"

export interface PositionFix {
  latitude: number
  longitude: number
  accuracyM: number
  speedMps?: number
  bearingDeg?: number
  altitudeM?: number
  /** Monotonic, for age. */
  elapsedMs: number
  timeMs: number
  source: RawFix["source"]
  quality: FixQuality
  permission: LocationPermission
}

export const POSITION_THRESHOLDS = {
  /** Accuracy radius at or below this, and fresh, is precise. */
  preciseAccuracyM: 20,
  /** Older than this is stale. */
  staleAfterMs: 5_000,
  /** No fix for this long is lost (a tunnel). */
  lostAfterMs: 15_000,
  /** Accuracy worse than this is not usable for guidance at all. */
  unusableAccuracyM: 500,
}

export type PositionEvent =
  | {kind: "fix"; fix: PositionFix; snapped?: PositionFix}
  | {kind: "stop_route_updates"; reason: "permission_denied" | "background_restricted" | "unusable_fix"}
  | {kind: "resume_route_updates"}

export function validFix(r: RawFix): boolean {
  return Number.isFinite(r.latitude) && Math.abs(r.latitude) <= 90 &&
    Number.isFinite(r.longitude) && Math.abs(r.longitude) <= 180 &&
    Number.isFinite(r.accuracyM) && r.accuracyM > 0 &&
    !(r.latitude === 0 && r.longitude === 0) &&
    (r.speedMps === undefined || (r.speedMps >= 0 && r.speedMps < 120)) &&
    (r.bearingDeg === undefined || (r.bearingDeg >= 0 && r.bearingDeg < 360))
}

export function classify(r: RawFix, permission: LocationPermission, nowElapsedMs: number): FixQuality {
  const age = nowElapsedMs - r.elapsedMs
  if (age > POSITION_THRESHOLDS.lostAfterMs) return "lost"
  if (age > POSITION_THRESHOLDS.staleAfterMs) return "stale"
  if (permission === "approximate") return "approximate"
  return r.accuracyM <= POSITION_THRESHOLDS.preciseAccuracyM ? "precise" : "approximate"
}

/** About a kilometre: two decimal places. The only form a log or telemetry gets. */
export function forLog(f: Pick<PositionFix, "latitude" | "longitude" | "accuracyM" | "quality">): {lat: number; lon: number; accuracyBucket: string; quality: FixQuality} {
  const round = (v: number) => Math.round(v * 100) / 100
  const b = f.accuracyM <= 10 ? "le10m" : f.accuracyM <= 50 ? "le50m" : f.accuracyM <= 200 ? "le200m" : "gt200m"
  return {lat: round(f.latitude), lon: round(f.longitude), accuracyBucket: b, quality: f.quality}
}

/** The phone's position session for navigation and the context engine. */
export class PositionService {
  private permission: LocationPermission = "denied"
  private lastRaw: RawFix | null = null
  private lastSnapped: RawFix | null = null
  private stopped = true

  constructor(private readonly nowElapsed: () => number) {}

  setPermission(p: LocationPermission): PositionEvent[] {
    this.permission = p
    if (p === "denied" || p === "background_restricted") {
      // Whatever we knew is no longer allowed to be used.
      this.lastRaw = null
      this.lastSnapped = null
      if (!this.stopped) {
        this.stopped = true
        return [{kind: "stop_route_updates", reason: p === "denied" ? "permission_denied" : "background_restricted"}]
      }
      return []
    }
    return []
  }

  /** A fix from the platform. Invalid fixes are dropped; none is ever extrapolated. */
  onFix(r: RawFix): PositionEvent[] {
    if (this.permission === "denied" || this.permission === "background_restricted") return []
    if (!validFix(r)) return []
    // Keep raw and snapped apart; a snapped fix never replaces the raw one.
    if (r.source === "sdk_snapped") this.lastSnapped = r
    else {
      if (this.lastRaw && r.elapsedMs <= this.lastRaw.elapsedMs) return []
      this.lastRaw = r
    }
    const raw = this.current()
    if (!raw) return []
    const events: PositionEvent[] = []
    if (raw.accuracyM > POSITION_THRESHOLDS.unusableAccuracyM) {
      if (!this.stopped) {
        this.stopped = true
        events.push({kind: "stop_route_updates", reason: "unusable_fix"})
      }
      return events
    }
    if (this.stopped) {
      this.stopped = false
      events.push({kind: "resume_route_updates"})
    }
    events.push({kind: "fix", fix: raw, snapped: this.snapped() ?? undefined})
    return events
  }

  /** The latest raw fix, classified as of now. Null when none is allowed or known. */
  current(): PositionFix | null {
    return this.lastRaw ? this.toFix(this.lastRaw) : null
  }

  snapped(): PositionFix | null {
    return this.lastSnapped ? this.toFix(this.lastSnapped) : null
  }

  /** A phone reboot resets the monotonic clock: nothing from before it can be aged correctly. */
  onReboot(): void {
    this.lastRaw = null
    this.lastSnapped = null
    this.stopped = true
  }

  /** The shape nav/guidance.ts consumes. */
  forGuidance(): {accuracyM: number; at: number} | null {
    const f = this.current()
    if (!f || f.quality === "lost") return null
    return {accuracyM: f.quality === "stale" ? Math.max(f.accuracyM, 1000) : f.accuracyM, at: f.elapsedMs}
  }

  private toFix(r: RawFix): PositionFix {
    return {
      latitude: r.latitude,
      longitude: r.longitude,
      accuracyM: r.accuracyM,
      speedMps: r.speedMps,
      bearingDeg: r.bearingDeg,
      altitudeM: r.altitudeM,
      elapsedMs: r.elapsedMs,
      timeMs: r.timeMs,
      source: r.source,
      quality: classify(r, this.permission, this.nowElapsed()),
      permission: this.permission,
    }
  }
}
