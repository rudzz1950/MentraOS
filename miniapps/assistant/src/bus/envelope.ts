/**
 * @fileoverview The one shape every event in the ecosystem travels in. ANI-196.
 *
 * Ring, glasses, phone, assistant and any cloud service exchange events in
 * this envelope, so that duplicates, delays, reordering, expiry, consent and
 * provenance are handled ONCE, here, instead of differently in every feature.
 *
 * What a receiver gets from it:
 *
 *   - Validation. A malformed envelope is refused with a reason, never half-read.
 *   - Authentication binding. The source device id must be the peer the
 *     transport authenticated; an envelope claiming to be from the ring that
 *     arrived over the glasses link is refused.
 *   - Deduplication by event id and idempotency key, ordering checks by
 *     per-source sequence, and expiry by TTL.
 *   - The consent rule from ADR-002, a third time: captured data carries a
 *     consent scope, or it does not travel.
 *   - No raw media. Camera and audio bytes go through the media transport; the
 *     bus carries references. A payload with binary in it is refused.
 *
 * Clocks are not synchronised across devices, so expiry cannot compare a
 * device's monotonic timestamp with the phone's clock. Instead the receiver
 * keeps, per source, the smallest (received - sent) it has ever seen: the
 * fastest delivery bounds the clock offset. An event's age is how much later
 * it arrived than that fastest path would have delivered it. That measures
 * queueing and retransmission delay, which is what makes an instruction
 * stale, without pretending the clocks agree.
 *
 * Deterministic safety interlocks do NOT go through this (ANI-196's last
 * criterion). An asynchronous hop has no place between "stop" and stopping.
 */

export type Priority =
  /** User control and safety: stop capture, mute. Never dropped by a full queue. */
  | "safety"
  /** Commands the user is waiting on. */
  | "interactive"
  /** State and measurements. The first to go when a queue fills. */
  | "telemetry"
  /** A reference to media held elsewhere. */
  | "bulk_ref"

export type Provenance = "sensor" | "self_reported" | "captured" | "derived"

export interface EventEnvelope<P = unknown> {
  eventId: string
  eventType: string
  /** Major version of the payload schema for this event type. */
  schemaVersion: number
  source: {deviceId: string; accountId: string; module: string}
  sessionId: string
  correlationId?: string
  /** The event that caused this one, for tracing an action back to its trigger. */
  causationId?: string
  /** The sender's monotonic clock, ms. Comparable only with that sender's own timestamps. */
  deviceTimeMs: number
  /** Per source and session, strictly increasing. */
  seq: number
  /** Set by the receiver, never trusted from the wire. */
  receivedAt?: number
  payload: P
  ttlMs: number
  priority: Priority
  delivery: "at_most_once" | "at_least_once"
  /** Same key, same effect: a retry of a command carries the key of the original. */
  idempotencyKey: string
  provenance?: Provenance
  /** 0..1, for derived and sensor data. */
  confidence?: number
  /** Required when provenance is "captured". */
  consentScopeId?: string
  /** Trace ids only. No personal content can live here: anything else is refused. */
  trace?: {traceId: string; spanId: string; parentSpanId?: string}
}

export const MAX_PAYLOAD_BYTES = 16 * 1024
/** A string this long in a payload is treated as smuggled media. */
const MAX_STRING = 4096

export type EnvelopeRejection =
  | "malformed"
  | "unknown_type"
  | "unsupported_version"
  | "payload_invalid"
  | "payload_too_large"
  | "raw_media"
  | "unscoped_capture"
  | "bad_trace"
  | "unauthenticated_source"
  | "wrong_account"
  | "duplicate"
  | "stale_sequence"
  | "expired"

/** One registered event type: the versions understood and how to check a payload. */
export interface EventSchema<P = unknown> {
  type: string
  /** Oldest and newest major versions accepted. */
  versions: [number, number]
  priority: Priority
  validate(payload: unknown, version: number): payload is P
}

export class SchemaRegistry {
  private schemas = new Map<string, EventSchema>()
  register<P>(schema: EventSchema<P>): this {
    if (this.schemas.has(schema.type)) throw new Error(`Event type ${schema.type} registered twice`)
    this.schemas.set(schema.type, schema as EventSchema)
    return this
  }
  get(type: string): EventSchema | undefined {
    return this.schemas.get(type)
  }
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/
const HEX = /^[0-9a-f]{8,64}$/

/** Structural checks on an envelope as it came off the wire. Does not consult a registry. */
export function checkShape(e: unknown): EnvelopeRejection | null {
  if (!e || typeof e !== "object") return "malformed"
  const x = e as Record<string, unknown>
  const src = x.source as Record<string, unknown> | undefined
  const ids = [x.eventId, x.eventType, x.sessionId, x.idempotencyKey, src?.deviceId, src?.accountId, src?.module]
  if (!ids.every(v => typeof v === "string" && ID.test(v))) return "malformed"
  for (const opt of [x.correlationId, x.causationId, x.consentScopeId]) {
    if (opt !== undefined && !(typeof opt === "string" && ID.test(opt))) return "malformed"
  }
  if (!Number.isInteger(x.schemaVersion) || (x.schemaVersion as number) < 1) return "malformed"
  if (!Number.isInteger(x.seq) || (x.seq as number) < 0) return "malformed"
  if (typeof x.deviceTimeMs !== "number" || !Number.isFinite(x.deviceTimeMs) || x.deviceTimeMs < 0) return "malformed"
  if (typeof x.ttlMs !== "number" || !(x.ttlMs > 0)) return "malformed"
  if (!["safety", "interactive", "telemetry", "bulk_ref"].includes(x.priority as string)) return "malformed"
  if (!["at_most_once", "at_least_once"].includes(x.delivery as string)) return "malformed"
  if (x.provenance !== undefined && !["sensor", "self_reported", "captured", "derived"].includes(x.provenance as string)) return "malformed"
  if (x.confidence !== undefined && !(typeof x.confidence === "number" && x.confidence >= 0 && x.confidence <= 1)) return "malformed"
  if (x.provenance === "captured" && !x.consentScopeId) return "unscoped_capture"

  if (x.trace !== undefined) {
    const t = x.trace as Record<string, unknown>
    if (!t || typeof t !== "object") return "bad_trace"
    const keys = Object.keys(t)
    if (keys.some(k => !["traceId", "spanId", "parentSpanId"].includes(k))) return "bad_trace"
    if (!keys.every(k => typeof t[k] === "string" && HEX.test(t[k] as string))) return "bad_trace"
    if (!t.traceId || !t.spanId) return "bad_trace"
  }

  if (containsBinary(x.payload, 0)) return "raw_media"
  let size: number
  try {
    size = new TextEncoder().encode(JSON.stringify(x.payload) ?? "").length
  } catch {
    return "malformed"
  }
  if (size > MAX_PAYLOAD_BYTES) return "payload_too_large"
  return null
}

function containsBinary(v: unknown, depth: number): boolean {
  if (depth > 16) return true
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return true
  if (typeof v === "string") return v.length > MAX_STRING || /^data:(image|audio|video)\//i.test(v)
  if (Array.isArray(v)) return v.some(i => containsBinary(i, depth + 1))
  if (v && typeof v === "object") return Object.values(v).some(i => containsBinary(i, depth + 1))
  return false
}

export type Accepted<P> = {ok: true; event: EventEnvelope<P>; outOfOrder: boolean; ageMs: number}
export type Refused = {ok: false; reason: EnvelopeRejection; eventId?: string}

/**
 * The receiving end of one link. Holds the per-source state that dedupe,
 * ordering and expiry need, and nothing else.
 */
export class EventReceiver {
  private seenIds = new Map<string, number>()
  private seenKeys = new Map<string, number>()
  private lastSeq = new Map<string, number>()
  private minOffset = new Map<string, number>()

  constructor(
    private readonly opts: {
      registry: SchemaRegistry
      /** The account this phone belongs to. Events for any other are refused. */
      accountId: string
      now: () => number
      /** How long ids are remembered for dedupe. Ten minutes by default. */
      dedupeWindowMs?: number
      /**
       * Which priorities must arrive in order. An out-of-order safety or
       * interactive event is a stale command and is refused; telemetry is
       * delivered and flagged. Defaults to both safety and interactive.
       */
      strictOrder?: Priority[]
    },
  ) {}

  /**
   * @param authenticatedPeer the device id the transport authenticated this
   *   message as coming from. The envelope's own claim must match it.
   */
  receive<P = unknown>(raw: unknown, authenticatedPeer: string): Accepted<P> | Refused {
    const shape = checkShape(raw)
    const id = (raw as {eventId?: unknown})?.eventId
    const eventId = typeof id === "string" ? id : undefined
    if (shape) return {ok: false, reason: shape, eventId}
    const e = {...(raw as EventEnvelope<P>)}
    const now = this.opts.now()

    if (e.source.deviceId !== authenticatedPeer) return {ok: false, reason: "unauthenticated_source", eventId}
    if (e.source.accountId !== this.opts.accountId) return {ok: false, reason: "wrong_account", eventId}

    const schema = this.opts.registry.get(e.eventType)
    if (!schema) return {ok: false, reason: "unknown_type", eventId}
    if (e.schemaVersion < schema.versions[0] || e.schemaVersion > schema.versions[1]) {
      return {ok: false, reason: "unsupported_version", eventId}
    }
    if (!schema.validate(e.payload, e.schemaVersion)) return {ok: false, reason: "payload_invalid", eventId}

    this.forget(now)
    if (this.seenIds.has(e.eventId) || this.seenKeys.has(e.idempotencyKey)) {
      return {ok: false, reason: "duplicate", eventId}
    }

    const stream = `${e.source.deviceId}|${e.sessionId}`
    const offset = now - e.deviceTimeMs
    const best = Math.min(this.minOffset.get(stream) ?? offset, offset)
    this.minOffset.set(stream, best)
    const ageMs = offset - best
    if (ageMs > e.ttlMs) return {ok: false, reason: "expired", eventId}

    const last = this.lastSeq.get(stream)
    const outOfOrder = last !== undefined && e.seq <= last
    const strict = this.opts.strictOrder ?? ["safety", "interactive"]
    if (outOfOrder && strict.includes(e.priority)) return {ok: false, reason: "stale_sequence", eventId}

    this.seenIds.set(e.eventId, now)
    this.seenKeys.set(e.idempotencyKey, now)
    if (!outOfOrder) this.lastSeq.set(stream, e.seq)
    e.receivedAt = now
    return {ok: true, event: e, outOfOrder, ageMs}
  }

  /** A new session restarts sequence numbers. Called by the session lifecycle (ANI-199). */
  resetStream(deviceId: string, sessionId: string): void {
    const stream = `${deviceId}|${sessionId}`
    this.lastSeq.delete(stream)
    this.minOffset.delete(stream)
  }

  private forget(now: number) {
    const window = this.opts.dedupeWindowMs ?? 600_000
    for (const map of [this.seenIds, this.seenKeys]) {
      for (const [k, at] of map) if (now - at > window) map.delete(k)
    }
  }
}

/** Builds envelopes for one source, numbering them. */
export class EventSender {
  private seq = 0
  private n = 0
  constructor(
    private readonly source: EventEnvelope["source"],
    private readonly sessionId: string,
    private readonly clock: () => number,
    private readonly idgen: () => string = () => `${source.deviceId}-${Date.now().toString(36)}-${(this.n++).toString(36)}`,
  ) {}

  make<P>(
    eventType: string,
    payload: P,
    opts: Partial<Omit<EventEnvelope<P>, "eventType" | "payload" | "source" | "sessionId" | "seq">> & {schemaVersion: number; priority: Priority; ttlMs: number},
  ): EventEnvelope<P> {
    const eventId = opts.eventId ?? this.idgen()
    return {
      delivery: "at_most_once",
      ...opts,
      eventId,
      eventType,
      payload,
      source: this.source,
      sessionId: this.sessionId,
      deviceTimeMs: opts.deviceTimeMs ?? this.clock(),
      seq: this.seq++,
      idempotencyKey: opts.idempotencyKey ?? eventId,
    }
  }
}
