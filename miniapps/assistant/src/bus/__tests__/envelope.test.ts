/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {BoundedQueue, InMemoryBus} from "../bus"
import {EventReceiver, EventSender, SchemaRegistry, type EventEnvelope, type Priority} from "../envelope"

const ring = {deviceId: "ring-01", accountId: "acct-1", module: "gesture"}

function registry() {
  return new SchemaRegistry()
    .register({
      type: "ring.gesture",
      versions: [1, 2],
      priority: "interactive",
      validate: (p): p is {gesture: string} => typeof (p as {gesture?: unknown})?.gesture === "string",
    })
    .register({
      type: "ring.battery",
      versions: [1, 1],
      priority: "telemetry",
      validate: (p): p is {percent: number} => typeof (p as {percent?: unknown})?.percent === "number",
    })
}

function rig() {
  const clock = {t: 1_000_000, now: () => clock.t}
  // The ring's monotonic clock: an unrelated epoch, as it would be.
  const ringClock = {t: 42, now: () => ringClock.t}
  let n = 0
  const sender = new EventSender(ring, "sess-1", ringClock.now, () => `ev${++n}`)
  const rx = new EventReceiver({registry: registry(), accountId: "acct-1", now: clock.now})
  const gesture = (g = "double_tap", over: Partial<EventEnvelope> = {}) =>
    ({...sender.make("ring.gesture", {gesture: g}, {schemaVersion: 1, priority: "interactive", ttlMs: 500}), ...over})
  return {clock, ringClock, sender, rx, gesture}
}

describe("ANI-196: what a receiver refuses", () => {
  test("a well-formed event is accepted and stamped on receipt", () => {
    const {rx, gesture, clock} = rig()
    const r = rx.receive(gesture(), "ring-01")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.receivedAt).toBe(clock.t)
  })

  test("malformed envelopes", () => {
    const {rx, gesture} = rig()
    expect(rx.receive(null, "ring-01")).toMatchObject({ok: false, reason: "malformed"})
    expect(rx.receive({...gesture(), eventId: ""}, "ring-01")).toMatchObject({reason: "malformed"})
    expect(rx.receive({...gesture(), seq: -1}, "ring-01")).toMatchObject({reason: "malformed"})
    expect(rx.receive({...gesture(), ttlMs: 0}, "ring-01")).toMatchObject({reason: "malformed"})
    expect(rx.receive({...gesture(), priority: "urgent"}, "ring-01")).toMatchObject({reason: "malformed"})
    expect(rx.receive({...gesture(), confidence: 1.5}, "ring-01")).toMatchObject({reason: "malformed"})
  })

  test("a source claim that does not match the authenticated peer", () => {
    const {rx, gesture} = rig()
    // Claims to be the ring, arrived over the glasses link.
    expect(rx.receive(gesture(), "glasses-01")).toMatchObject({ok: false, reason: "unauthenticated_source"})
  })

  test("another account's events", () => {
    const {rx, gesture} = rig()
    expect(rx.receive(gesture("tap", {source: {...ring, accountId: "acct-2"}}), "ring-01")).toMatchObject({reason: "wrong_account"})
  })

  test("unknown types, unsupported versions and invalid payloads", () => {
    const {rx, gesture} = rig()
    expect(rx.receive(gesture("tap", {eventType: "ring.teleport"}), "ring-01")).toMatchObject({reason: "unknown_type"})
    expect(rx.receive(gesture("tap", {schemaVersion: 3}), "ring-01")).toMatchObject({reason: "unsupported_version"})
    expect(rx.receive(gesture("tap", {schemaVersion: 2}), "ring-01").ok).toBe(true)
    expect(rx.receive(gesture("tap", {payload: {gesture: 7}}), "ring-01")).toMatchObject({reason: "payload_invalid"})
  })

  test("captured data without a consent scope does not travel", () => {
    const {rx, gesture} = rig()
    expect(rx.receive(gesture("tap", {provenance: "captured"}), "ring-01")).toMatchObject({reason: "unscoped_capture"})
    expect(rx.receive(gesture("tap", {provenance: "captured", consentScopeId: "scope-9"}), "ring-01").ok).toBe(true)
  })

  test("raw media is refused: the bus carries references", () => {
    const {rx, gesture} = rig()
    expect(rx.receive(gesture("tap", {payload: {gesture: "tap", frame: new Uint8Array(10)}}), "ring-01")).toMatchObject({reason: "raw_media"})
    expect(rx.receive(gesture("tap", {payload: {gesture: "tap", img: "data:image/jpeg;base64,AAAA"}}), "ring-01")).toMatchObject({reason: "raw_media"})
    expect(rx.receive(gesture("tap", {payload: {gesture: "x".repeat(5000)}}), "ring-01")).toMatchObject({reason: "raw_media"})
  })

  test("oversize payloads", () => {
    const {rx, gesture} = rig()
    const big = {gesture: "tap", rows: Array.from({length: 400}, (_, i) => `row ${i} ${"y".repeat(40)}`)}
    expect(rx.receive(gesture("tap", {payload: big}), "ring-01")).toMatchObject({reason: "payload_too_large"})
  })

  test("trace metadata holds ids only, never content", () => {
    const {rx, gesture} = rig()
    expect(rx.receive(gesture("tap", {trace: {traceId: "a1b2c3d4e5f6", spanId: "0011aabb"}}), "ring-01").ok).toBe(true)
    expect(rx.receive(gesture("tap", {trace: {traceId: "a1b2c3d4e5f6", spanId: "0011aabb", note: "Asha said"} as never}), "ring-01")).toMatchObject({reason: "bad_trace"})
    expect(rx.receive(gesture("tap", {trace: {traceId: "call mom", spanId: "0011aabb"}}), "ring-01")).toMatchObject({reason: "bad_trace"})
  })
})

describe("ANI-196: duplicates, order and expiry", () => {
  test("a duplicate by event id or idempotency key is dropped", () => {
    const {rx, gesture} = rig()
    const e = gesture()
    expect(rx.receive(e, "ring-01").ok).toBe(true)
    expect(rx.receive(e, "ring-01")).toMatchObject({reason: "duplicate"})
    // A retry with a new event id but the same idempotency key has the same effect: none.
    expect(rx.receive(gesture("double_tap", {idempotencyKey: e.idempotencyKey}), "ring-01")).toMatchObject({reason: "duplicate"})
  })

  test("a replay after the dedupe window has forgotten its id is still refused, as expired", () => {
    const {rx, gesture, clock, ringClock} = rig()
    const e = gesture()
    rx.receive(e, "ring-01")
    clock.t += 600_001
    ringClock.t += 600_001
    // Same envelope, much later: its age now exceeds its TTL, so it is refused as expired rather than replayed.
    expect(rx.receive(e, "ring-01")).toMatchObject({ok: false})
  })

  test("an out-of-order interactive command is refused as stale", () => {
    const {rx, gesture} = rig()
    const first = gesture("tap")
    const second = gesture("double_tap")
    expect(rx.receive(second, "ring-01").ok).toBe(true)
    expect(rx.receive(first, "ring-01")).toMatchObject({reason: "stale_sequence"})
  })

  test("out-of-order telemetry is delivered, flagged", () => {
    const {rx, sender} = rig()
    const a = sender.make("ring.battery", {percent: 81}, {schemaVersion: 1, priority: "telemetry", ttlMs: 60_000})
    const b = sender.make("ring.battery", {percent: 80}, {schemaVersion: 1, priority: "telemetry", ttlMs: 60_000})
    rx.receive(b, "ring-01")
    const late = rx.receive(a, "ring-01")
    expect(late).toMatchObject({ok: true, outOfOrder: true})
  })

  test("expiry measures delay against the fastest path seen, with no shared clock", () => {
    const {rx, gesture, clock, ringClock} = rig()
    // First event arrives promptly: sets the offset baseline.
    expect(rx.receive(gesture(), "ring-01")).toMatchObject({ok: true, ageMs: 0})
    // Second was sent 10 ms later on the ring but arrived 900 ms later here.
    ringClock.t += 10
    const delayed = gesture("tap")
    clock.t += 900
    expect(rx.receive(delayed, "ring-01")).toMatchObject({ok: false, reason: "expired"})
  })

  test("a new session resets the sequence", () => {
    const {rx, gesture} = rig()
    rx.receive(gesture("tap", {seq: 50}), "ring-01")
    expect(rx.receive(gesture("tap", {seq: 0}), "ring-01")).toMatchObject({reason: "stale_sequence"})
    rx.resetStream("ring-01", "sess-1")
    expect(rx.receive(gesture("tap", {seq: 0}), "ring-01").ok).toBe(true)
  })
})

describe("ANI-196: the Bus port and the queue", () => {
  test("the in-memory bus delivers by type and prefix, and answers queries", async () => {
    const bus = new InMemoryBus()
    const {gesture} = rig()
    const exact: string[] = []
    const prefix: string[] = []
    const off = bus.subscribe("ring.gesture", e => exact.push(e.eventId))
    bus.subscribe("ring.*", e => prefix.push(e.eventId))
    const e = gesture()
    await bus.publish(e)
    off()
    await bus.publish(gesture("tap"))
    expect(exact).toEqual([e.eventId])
    expect(prefix.length).toBe(2)
    expect((await bus.query("ring.gesture"))!.payload).toEqual({gesture: "tap"})
    expect(await bus.query("glasses.hud")).toBeNull()
  })

  function ev(id: string, priority: Priority, ttlMs = 10_000): EventEnvelope {
    return {
      eventId: id, eventType: "x", schemaVersion: 1, source: ring, sessionId: "s", deviceTimeMs: 0, seq: 0,
      payload: {}, ttlMs, priority, delivery: "at_least_once", idempotencyKey: id,
    }
  }

  test("a full queue drops the oldest telemetry, never a safety event", () => {
    const clock = {t: 0}
    const q = new BoundedQueue(3, () => clock.t)
    q.push(ev("t1", "telemetry"))
    q.push(ev("t2", "telemetry"))
    q.push(ev("i1", "interactive"))
    expect(q.push(ev("i2", "interactive"))).toBe(true)
    expect(q.dropped).toEqual([{eventId: "t1", reason: "evicted"}])
    q.push(ev("i3", "interactive"))
    // Only interactive left: a new telemetry event is refused, not an eviction.
    expect(q.push(ev("t3", "telemetry"))).toBe(false)
    // Safety always gets in.
    expect(q.push(ev("stop-capture", "safety"))).toBe(true)
    expect(q.size).toBe(4)
    expect(q.shift()!.eventId).toBe("stop-capture")
    expect(q.shift()!.eventId).toBe("i1")
  })

  test("expired events are dropped rather than sent late", () => {
    const clock = {t: 0}
    const q = new BoundedQueue(10, () => clock.t)
    q.push(ev("next-turn", "interactive", 500))
    clock.t = 501
    expect(q.shift()).toBeUndefined()
    expect(q.dropped).toEqual([{eventId: "next-turn", reason: "expired"}])
  })
})
