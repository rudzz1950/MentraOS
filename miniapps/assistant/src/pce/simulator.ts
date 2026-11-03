/**
 * @fileoverview Simulated ring, glasses and phone, with faults, on the real contracts. ANI-214.
 *
 * The simulated devices speak the real envelope (bus/envelope.ts) and the
 * real hello (pce/registry.ts), so a scenario run here exercises the same
 * receiver, registry, session and policy code that real hardware will.
 * The contract suite takes a DeviceUnderTest, which a simulated device and a
 * physical one both implement.
 *
 * Faults are injected deterministically from a seed: delay, duplication,
 * reordering, loss, clock skew and restart. The same seed gives the same run,
 * so a failure can be replayed.
 *
 * And the line that matters most: every report says how it was produced. A
 * simulated pass is evidence that the code honours the contract, and nothing
 * more; `canCloseRequirement` refuses to let one stand in for a physical test.
 */

import {EventSender, type EventEnvelope} from "../bus/envelope"
import type {Capability, DeviceHello, DeviceKind} from "./registry"

export const SIMULATOR_VERSION = "pce-sim-1"

/** mulberry32: small, seedable, good enough for test schedules. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Faults {
  /** Probability each event is lost. */
  drop?: number
  /** Probability each event is delivered twice. */
  duplicate?: number
  /** Probability adjacent events swap order. */
  reorder?: number
  /** Extra delivery delay, ms, uniformly up to this. */
  maxDelayMs?: number
  /** Added to the device's clock, ms. */
  clockSkewMs?: number
}

/** What both a simulated and a physical device give the contract suite. */
export interface DeviceUnderTest {
  readonly mode: "simulated" | "physical"
  readonly deviceId: string
  readonly kind: DeviceKind
  hello(): DeviceHello
  /** Produce one event of a type. */
  emit<P>(eventType: string, payload: P, opts?: {ttlMs?: number; priority?: EventEnvelope["priority"]}): EventEnvelope<P>
  /** Lose the session: sequence numbers restart, as after a reboot. */
  restart(): void
}

export class SimulatedDevice implements DeviceUnderTest {
  readonly mode = "simulated" as const
  private sender: EventSender
  private clock: number
  private session = 0

  constructor(
    readonly deviceId: string,
    readonly kind: DeviceKind,
    private readonly opts: {
      accountId: string
      capabilities: Capability[]
      commands?: string[]
      firmwareVersion?: string
      protocolVersion?: number
      startClockMs?: number
      faults?: Faults
    },
  ) {
    this.clock = (opts.startClockMs ?? 0) + (opts.faults?.clockSkewMs ?? 0)
    this.sender = this.makeSender()
  }

  /** Advance the device's own clock. */
  tick(ms: number): void {
    this.clock += ms
  }

  hello(): DeviceHello {
    return {
      descriptor: {
        deviceId: this.deviceId,
        kind: this.kind,
        model: `SIM-${this.kind.toUpperCase()}`,
        firmwareVersion: this.opts.firmwareVersion ?? "sim-1.0.0",
        protocolVersion: this.opts.protocolVersion ?? 1,
      },
      capabilities: this.opts.capabilities.map(c => ({...c})),
      commands: [...(this.opts.commands ?? [])],
    }
  }

  emit<P>(eventType: string, payload: P, opts: {ttlMs?: number; priority?: EventEnvelope["priority"]} = {}): EventEnvelope<P> {
    return this.sender.make(eventType, payload, {schemaVersion: 1, priority: opts.priority ?? "interactive", ttlMs: opts.ttlMs ?? 1000})
  }

  restart(): void {
    this.session++
    this.sender = this.makeSender()
  }

  get sessionId(): string {
    return `${this.deviceId}-s${this.session}`
  }

  private makeSender(): EventSender {
    let n = 0
    return new EventSender(
      {deviceId: this.deviceId, accountId: this.opts.accountId, module: "sim"},
      this.sessionId,
      () => this.clock,
      () => `${this.deviceId}-s${this.session}-e${++n}`,
    )
  }
}

/**
 * Pass events through a faulty link. Returns them as they would arrive, each
 * with its arrival time on the phone's clock.
 */
export function deliver<E>(events: {event: E; sentAt: number}[], faults: Faults, seed: number): {event: E; arrivesAt: number}[] {
  const rand = prng(seed)
  const out: {event: E; arrivesAt: number}[] = []
  for (const {event, sentAt} of events) {
    if (rand() < (faults.drop ?? 0)) continue
    const arrivesAt = sentAt + Math.floor(rand() * (faults.maxDelayMs ?? 0))
    out.push({event, arrivesAt})
    if (rand() < (faults.duplicate ?? 0)) out.push({event, arrivesAt: arrivesAt + 1})
  }
  out.sort((a, b) => a.arrivesAt - b.arrivesAt)
  for (let i = 0; i + 1 < out.length; i++) {
    if (rand() < (faults.reorder ?? 0)) {
      ;[out[i], out[i + 1]] = [out[i + 1], out[i]]
      i++
    }
  }
  return out
}

export interface TestReport {
  scenario: string
  mode: "simulated" | "physical"
  simulatorVersion?: string
  seed?: number
  firmware: Record<string, string>
  appVersion: string
  passed: boolean
  checks: {name: string; passed: boolean; detail?: string}[]
}

/**
 * Whether a report may close a requirement. A requirement that needs
 * physical evidence is never closed by a simulated run, however green.
 */
export function canCloseRequirement(report: TestReport, requirement: {needsPhysical: boolean}): {ok: boolean; reason?: string} {
  if (!report.passed) return {ok: false, reason: "the run failed"}
  if (requirement.needsPhysical && report.mode !== "physical") {
    return {ok: false, reason: "simulated evidence cannot close a physical-integration requirement"}
  }
  return {ok: true}
}

/**
 * The contract suite: the checks a device must pass, run the same way against
 * a simulated or a physical DeviceUnderTest. The receiver and registry are
 * the production ones.
 */
export function contractSuite(
  dut: DeviceUnderTest,
  h: {
    registry: import("./registry").DeviceRegistry
    receiver: import("../bus/envelope").EventReceiver
    eventType: string
    payload: unknown
    appVersion: string
    seed?: number
  },
): TestReport {
  const checks: TestReport["checks"] = []
  const check = (name: string, passed: boolean, detail?: string) => checks.push({name, passed, detail})

  const hello = dut.hello()
  const neg = h.registry.negotiate(hello)
  check("negotiates", neg.ok, neg.ok ? undefined : neg.reason)
  const supported = hello.capabilities.filter(c => c.state === "supported").map(c => c.id)
  check("reported capabilities are usable", h.registry.check(dut.deviceId, supported).ok)
  const unsupported = hello.capabilities.filter(c => c.state !== "supported").map(c => c.id)
  check("unreported or unsupported capabilities are refused", unsupported.every(id => !h.registry.check(dut.deviceId, [id]).ok))

  const a = dut.emit(h.eventType, h.payload)
  const b = dut.emit(h.eventType, h.payload)
  check("a well-formed event is accepted", h.receiver.receive(a, dut.deviceId).ok)
  check("a duplicate is refused", !h.receiver.receive(a, dut.deviceId).ok)
  check("in-order delivery is accepted", h.receiver.receive(b, dut.deviceId).ok)
  const old = {...a, eventId: `${a.eventId}-replay`, idempotencyKey: `${a.idempotencyKey}-replay`}
  const r = h.receiver.receive(old, dut.deviceId)
  check("an out-of-order interactive event is refused", !r.ok && r.reason === "stale_sequence")
  check("an envelope from another peer is refused", !h.receiver.receive(dut.emit(h.eventType, h.payload), "someone-else").ok)

  dut.restart()
  const fresh = dut.emit(h.eventType, h.payload)
  check("after a restart, a new session is accepted", h.receiver.receive(fresh, dut.deviceId).ok)

  return {
    scenario: "device-contract",
    mode: dut.mode,
    simulatorVersion: dut.mode === "simulated" ? SIMULATOR_VERSION : undefined,
    seed: h.seed,
    firmware: {[dut.deviceId]: hello.descriptor.firmwareVersion},
    appVersion: h.appVersion,
    passed: checks.every(c => c.passed),
    checks,
  }
}
