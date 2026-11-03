/**
 * @fileoverview Every modality, normalised into one typed perception event. ANI-201.
 *
 * Voice, vision, motion, ring and phone each have an adapter: a pure function
 * from what that source produces to a PerceptionEvent, or a typed refusal.
 * The vendor SDKs and drivers sit behind the adapter; the context engine sees
 * only these events.
 *
 * Before anything enters context, the hub checks:
 *   - the payload validates for its modality and is within size;
 *   - captured content (an utterance overheard, a photo) carries a consent
 *     scope, per ADR-002;
 *   - no raw audio or video is in it. Media is a reference to the media
 *     store; context gets the derived text, never the bytes;
 *   - it is not older than the newest event already accepted from that
 *     modality's stream, for the kinds where order matters (a late partial
 *     transcript must not overwrite a final one).
 *
 * A modality that is missing or failing is reported as absent and does not
 * block the others: losing the camera never stops a ring gesture.
 */

export type Modality = "voice" | "vision" | "motion" | "ring" | "phone"

export type PerceptionEvent =
  | {modality: "voice"; kind: "partial" | "final"; text: string; confidence?: number; utteranceId: string; at: number; scopeId?: string}
  | {modality: "voice"; kind: "vad"; voiced: boolean; at: number}
  | {modality: "vision"; kind: "capture"; captureRef: string; at: number; scopeId: string; ocrText?: string; width?: number; height?: number}
  | {modality: "vision"; kind: "camera_state"; state: "idle" | "capturing" | "permission_denied" | "unavailable"; at: number}
  | {modality: "motion"; kind: "head_gesture"; gesture: "head_up" | "nod" | "shake"; confidence: number; at: number}
  | {modality: "motion"; kind: "activity"; activity: "still" | "walking" | "running" | "cycling" | "in_vehicle" | "unknown"; confidence: number; at: number; source: "platform" | "imu"}
  | {modality: "ring"; kind: "gesture"; gesture: "tap" | "double_tap" | "hold" | "swipe_up" | "swipe_down"; at: number}
  | {modality: "ring"; kind: "battery"; percent: number; at: number}
  | {modality: "ring"; kind: "haptic_result"; actionId: string; ok: boolean; at: number}
  | {modality: "ring"; kind: "wellness_summary"; metric: "resting_hr" | "sleep_minutes" | "steps"; value: number; unit: "bpm" | "min" | "count"; at: number; scopeId: string}
  | {modality: "phone"; kind: "notification"; app: string; category: string; at: number}
  | {modality: "phone"; kind: "calendar"; eventId: string; change: "starting_soon" | "started" | "ended" | "moved" | "cancelled"; at: number}
  | {modality: "phone"; kind: "app_lifecycle"; state: "foreground" | "background" | "killed"; at: number}
  | {modality: "phone"; kind: "call"; state: "idle" | "ringing" | "in_call"; at: number}
  | {modality: "phone"; kind: "connectivity"; state: "online" | "site_only" | "offline"; at: number}

export type Rejection = "malformed" | "too_large" | "raw_media" | "unscoped_capture" | "late" | "modality_absent"

export type AdapterResult = {ok: true; event: PerceptionEvent} | {ok: false; reason: Rejection; detail?: string}

export type Adapter = (raw: unknown) => AdapterResult

const MAX_TEXT = 2000
const MAX_BYTES = 8 * 1024

const str = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const prob = (v: unknown): v is number => num(v) && v >= 0 && v <= 1
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): v is T => typeof v === "string" && (xs as readonly string[]).includes(v)
const bad = (detail: string): AdapterResult => ({ok: false, reason: "malformed", detail})
const ok = (event: PerceptionEvent): AdapterResult => ({ok: true, event})

function hasRawMedia(v: unknown, depth = 0): boolean {
  if (depth > 8) return true
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return true
  if (typeof v === "string") return /^data:(image|audio|video)\//i.test(v)
  if (Array.isArray(v)) return v.some(x => hasRawMedia(x, depth + 1))
  if (v && typeof v === "object") return Object.values(v).some(x => hasRawMedia(x, depth + 1))
  return false
}

/** From the STT (TranscriptStabilizer) and the firmware VAD. */
export const voiceAdapter: Adapter = raw => {
  const r = raw as Record<string, unknown>
  if (!num(r?.at)) return bad("at")
  if (r.kind === "vad") return typeof r.voiced === "boolean" ? ok({modality: "voice", kind: "vad", voiced: r.voiced, at: r.at}) : bad("voiced")
  if (r.kind !== "partial" && r.kind !== "final") return bad("kind")
  if (!str(r.text, MAX_TEXT) || !str(r.utteranceId, 64)) return bad("text")
  if (r.confidence !== undefined && !prob(r.confidence)) return bad("confidence")
  // An utterance the wearer did not address to the assistant is a capture of
  // whoever spoke; it needs a scope to enter context at all.
  if (r.captured === true && !str(r.scopeId, 128)) return {ok: false, reason: "unscoped_capture"}
  return ok({modality: "voice", kind: r.kind, text: r.text, confidence: r.confidence as number | undefined, utteranceId: r.utteranceId, at: r.at, scopeId: r.scopeId as string | undefined})
}

/** From the capture service (ANI-166) and the OCR step (ANI-235). */
export const visionAdapter: Adapter = raw => {
  const r = raw as Record<string, unknown>
  if (!num(r?.at)) return bad("at")
  if (r.kind === "camera_state") {
    return oneOf(r.state, ["idle", "capturing", "permission_denied", "unavailable"] as const) ? ok({modality: "vision", kind: "camera_state", state: r.state, at: r.at}) : bad("state")
  }
  if (r.kind !== "capture") return bad("kind")
  if (!str(r.captureRef, 128) || !/^media:/.test(r.captureRef)) return bad("captureRef must be a media: reference")
  if (!str(r.scopeId, 128)) return {ok: false, reason: "unscoped_capture"}
  if (r.ocrText !== undefined && !(typeof r.ocrText === "string" && r.ocrText.length <= MAX_TEXT)) return bad("ocrText")
  return ok({modality: "vision", kind: "capture", captureRef: r.captureRef, scopeId: r.scopeId, at: r.at, ocrText: r.ocrText as string | undefined,
    width: num(r.width) ? r.width : undefined, height: num(r.height) ? r.height : undefined})
}

/** From the glasses IMU classifier and the phone's activity recognition. */
export const motionAdapter: Adapter = raw => {
  const r = raw as Record<string, unknown>
  if (!num(r?.at) || !prob(r.confidence)) return bad("at/confidence")
  if (r.kind === "head_gesture") return oneOf(r.gesture, ["head_up", "nod", "shake"] as const) ? ok({modality: "motion", kind: "head_gesture", gesture: r.gesture, confidence: r.confidence, at: r.at}) : bad("gesture")
  if (r.kind === "activity" && oneOf(r.activity, ["still", "walking", "running", "cycling", "in_vehicle", "unknown"] as const) && oneOf(r.source, ["platform", "imu"] as const)) {
    return ok({modality: "motion", kind: "activity", activity: r.activity, confidence: r.confidence, at: r.at, source: r.source})
  }
  return bad("kind")
}

/** From the ring's classified events. Raw PPG and IMU never come through here. */
export const ringAdapter: Adapter = raw => {
  const r = raw as Record<string, unknown>
  if (!num(r?.at)) return bad("at")
  switch (r.kind) {
    case "gesture":
      return oneOf(r.gesture, ["tap", "double_tap", "hold", "swipe_up", "swipe_down"] as const) ? ok({modality: "ring", kind: "gesture", gesture: r.gesture, at: r.at}) : bad("gesture")
    case "battery":
      return num(r.percent) && r.percent >= 0 && r.percent <= 100 ? ok({modality: "ring", kind: "battery", percent: r.percent, at: r.at}) : bad("percent")
    case "haptic_result":
      return str(r.actionId, 64) && typeof r.ok === "boolean" ? ok({modality: "ring", kind: "haptic_result", actionId: r.actionId, ok: r.ok, at: r.at}) : bad("haptic")
    case "wellness_summary": {
      // Summaries only, with explicit units. A diagnosis is not a metric.
      if (!oneOf(r.metric, ["resting_hr", "sleep_minutes", "steps"] as const) || !num(r.value) || r.value < 0) return bad("metric")
      const unit = {resting_hr: "bpm", sleep_minutes: "min", steps: "count"}[r.metric] as "bpm" | "min" | "count"
      if (r.unit !== unit) return bad(`unit must be ${unit}`)
      if (!str(r.scopeId, 128)) return {ok: false, reason: "unscoped_capture"}
      return ok({modality: "ring", kind: "wellness_summary", metric: r.metric, value: r.value, unit, at: r.at, scopeId: r.scopeId})
    }
  }
  return bad("kind")
}

/** From the phone OS. Notification text stays in the notification gate; context gets app and category. */
export const phoneAdapter: Adapter = raw => {
  const r = raw as Record<string, unknown>
  if (!num(r?.at)) return bad("at")
  switch (r.kind) {
    case "notification":
      return str(r.app, 64) && str(r.category, 32) ? ok({modality: "phone", kind: "notification", app: r.app, category: r.category, at: r.at}) : bad("notification")
    case "calendar":
      return str(r.eventId, 128) && oneOf(r.change, ["starting_soon", "started", "ended", "moved", "cancelled"] as const) ? ok({modality: "phone", kind: "calendar", eventId: r.eventId, change: r.change, at: r.at}) : bad("calendar")
    case "app_lifecycle":
      return oneOf(r.state, ["foreground", "background", "killed"] as const) ? ok({modality: "phone", kind: "app_lifecycle", state: r.state, at: r.at}) : bad("state")
    case "call":
      return oneOf(r.state, ["idle", "ringing", "in_call"] as const) ? ok({modality: "phone", kind: "call", state: r.state, at: r.at}) : bad("state")
    case "connectivity":
      return oneOf(r.state, ["online", "site_only", "offline"] as const) ? ok({modality: "phone", kind: "connectivity", state: r.state, at: r.at}) : bad("state")
  }
  return bad("kind")
}

export const ADAPTERS: Record<Modality, Adapter> = {voice: voiceAdapter, vision: visionAdapter, motion: motionAdapter, ring: ringAdapter, phone: phoneAdapter}

/** Streams where a late event must not overwrite a newer one. */
function streamKey(e: PerceptionEvent): string | null {
  if (e.modality === "voice" && e.kind !== "vad") return `voice:${e.utteranceId}`
  if (e.modality === "motion" && e.kind === "activity") return `activity:${e.source}`
  if (e.modality === "ring" && e.kind === "battery") return "ring:battery"
  if (e.modality === "phone" && e.kind === "connectivity") return "phone:connectivity"
  return null
}

export class PerceptionHub {
  private adapters: Partial<Record<Modality, Adapter>>
  private newest = new Map<string, {at: number; final: boolean}>()
  private health: Partial<Record<Modality, {ok: number; rejected: number; lastAt?: number}>> = {}
  private listeners: ((e: PerceptionEvent) => void)[] = []

  constructor(adapters: Partial<Record<Modality, Adapter>> = ADAPTERS) {
    this.adapters = {...adapters}
  }

  /** A modality that is unavailable on this hardware or failing. Its events are refused; others are unaffected. */
  remove(m: Modality): void {
    delete this.adapters[m]
  }

  ingest(modality: Modality, raw: unknown): AdapterResult {
    const h = (this.health[modality] ??= {ok: 0, rejected: 0})
    const adapter = this.adapters[modality]
    const fail = (reason: Rejection, detail?: string): AdapterResult => {
      h.rejected++
      return {ok: false, reason, detail}
    }
    if (!adapter) return fail("modality_absent")
    let size: number
    try {
      size = JSON.stringify(raw)?.length ?? 0
    } catch {
      return fail("malformed", "not serialisable")
    }
    if (hasRawMedia(raw)) return fail("raw_media")
    if (size > MAX_BYTES) return fail("too_large")
    let r: AdapterResult
    try {
      r = adapter(raw)
    } catch {
      return fail("malformed", "adapter error")
    }
    if (!r.ok) return fail(r.reason, r.detail)

    const key = streamKey(r.event)
    if (key) {
      const prev = this.newest.get(key)
      const isFinal = r.event.modality === "voice" && r.event.kind === "final"
      // Older than what is already known, or a partial after its final.
      if (prev && (r.event.at < prev.at || (prev.final && !isFinal))) return fail("late")
      this.newest.set(key, {at: r.event.at, final: prev?.final || isFinal})
    }
    h.ok++
    h.lastAt = r.event.at
    for (const l of this.listeners) l(r.event)
    return r
  }

  onEvent(fn: (e: PerceptionEvent) => void): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn)
    }
  }

  /** Per modality: present or absent, with counts. */
  status(): Record<Modality, {present: boolean; ok: number; rejected: number; lastAt?: number}> {
    const out = {} as Record<Modality, {present: boolean; ok: number; rejected: number; lastAt?: number}>
    for (const m of ["voice", "vision", "motion", "ring", "phone"] as Modality[]) {
      out[m] = {present: !!this.adapters[m], ok: 0, rejected: 0, ...this.health[m]}
    }
    return out
  }
}
