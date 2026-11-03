/**
 * @fileoverview The ring <-> phone <-> glasses contract, on the canonical envelope. ANI-177.
 *
 * The contract lives in proto/ecosystem_events.v1.json. It is version
 * controlled, and the C header for firmware and the TypeScript here are both
 * generated from it (scripts/gen-ecosystem-c.py, with a --check in CI).
 * This file turns it into:
 *
 *   - Payload validators registered with the envelope's SchemaRegistry.
 *     Known fields are type-checked; unknown fields are IGNORED (consumers read through `readPayload`, which returns the known fields only),
 *     which is the forward-compatibility rule LINK_CONTRACT.md already uses,
 *     so a newer device's extra field never breaks an older phone.
 *   - Command semantics. An intent is sent with a command id (its event id)
 *     and must be answered by an ACK or a NACK naming that id. No answer
 *     before the intent's TTL is a timeout; an answer after it is ignored;
 *     a second answer is ignored. So a duplicate, delayed or out-of-order
 *     event can never cause the action twice — the receiver drops duplicate
 *     intents, and the tracker drops duplicate responses.
 *
 * The phone is the hub. A ring intent is never addressed to the glasses; the
 * phone maps it to a glasses command through the action registry.
 */

import {ECOSYSTEM_CONTRACT} from "./ecosystem.generated"
import type {EventEnvelope, Priority, SchemaRegistry} from "./envelope"

type FieldSpec = {type?: "bool" | "uint" | "int" | "id"; enum?: readonly string[]; enum_ref?: "nack_reasons"; min?: number; max?: number}
type EventSpec = {type: string; class: "intent" | "response" | "telemetry"; ttl_ms: number; fields: Record<string, FieldSpec>}

export const CONTRACT_VERSION = ECOSYSTEM_CONTRACT.version
export const EVENTS = ECOSYSTEM_CONTRACT.events as unknown as EventSpec[]
export type NackReason = (typeof ECOSYSTEM_CONTRACT.nack_reasons)[number]

const PRIORITY: Record<EventSpec["class"], Priority> = {intent: "interactive", response: "interactive", telemetry: "telemetry"}

function checkField(spec: FieldSpec, v: unknown): boolean {
  const values = spec.enum ?? (spec.enum_ref ? ECOSYSTEM_CONTRACT[spec.enum_ref] : undefined)
  if (values) return typeof v === "string" && (values as readonly string[]).includes(v)
  switch (spec.type) {
    case "bool":
      return typeof v === "boolean"
    case "id":
      return typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v)
    case "uint":
    case "int":
      return typeof v === "number" && Number.isInteger(v) && (spec.type === "int" || v >= 0) &&
        (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max)
  }
  return false
}

/** Validate a payload against the contract, returning the known fields only. */
export function readPayload(eventType: string, payload: unknown): Record<string, unknown> | null {
  const spec = EVENTS.find(e => e.type === eventType)
  if (!spec || !payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [name, f] of Object.entries(spec.fields)) {
    if (!(name in p) || !checkField(f, p[name])) return null
    out[name] = p[name]
  }
  return out
}

/** Register every contract event with the envelope's schema registry. */
export function registerEcosystem(registry: SchemaRegistry): SchemaRegistry {
  for (const e of EVENTS) {
    registry.register({
      type: e.type,
      versions: [1, CONTRACT_VERSION],
      priority: PRIORITY[e.class],
      validate: (p): p is Record<string, unknown> => readPayload(e.type, p) !== null,
    })
  }
  return registry
}

export function ttlFor(eventType: string): number {
  return EVENTS.find(e => e.type === eventType)?.ttl_ms ?? 1000
}

export type CommandOutcome =
  | {status: "acked"; commandId: string; latencyMs: number}
  | {status: "nacked"; commandId: string; reason: NackReason}
  | {status: "timeout"; commandId: string}

/**
 * Tracks intents waiting for an answer. Exactly one outcome per command:
 * the first ACK or NACK before expiry, or a timeout.
 */
export class CommandTracker {
  private open = new Map<string, {sentAt: number; expiresAt: number; resolve: (o: CommandOutcome) => void}>()
  private done = new Set<string>()
  readonly ignored: {commandId: string; why: "unknown" | "already_answered" | "late"}[] = []

  constructor(private readonly now: () => number) {}

  /** Register an intent that was just sent. Resolves with its single outcome. */
  track(intent: EventEnvelope): Promise<CommandOutcome> {
    if (!intent.eventType.startsWith("intent.")) throw new Error("Only intents are tracked")
    return new Promise(resolve => {
      this.open.set(intent.eventId, {sentAt: this.now(), expiresAt: this.now() + intent.ttlMs, resolve})
    })
  }

  /** A response event from a device, already accepted by the EventReceiver. */
  onResponse(e: EventEnvelope): void {
    const p = readPayload(e.eventType, e.payload)
    if (!p) return
    const id = p.command_id as string
    const c = this.open.get(id)
    if (!c) {
      this.ignored.push({commandId: id, why: this.done.has(id) ? "already_answered" : "unknown"})
      return
    }
    if (this.now() > c.expiresAt) {
      // Answered after its deadline: the timeout already stands (or will on the next tick).
      this.ignored.push({commandId: id, why: "late"})
      return
    }
    this.finish(id, e.eventType === "response.ack"
      ? {status: "acked", commandId: id, latencyMs: this.now() - c.sentAt}
      : {status: "nacked", commandId: id, reason: p.reason as NackReason})
  }

  /** Expire commands nobody answered. Call from the session's timer. */
  tick(): CommandOutcome[] {
    const out: CommandOutcome[] = []
    for (const [id, c] of [...this.open]) {
      if (this.now() > c.expiresAt) {
        const o: CommandOutcome = {status: "timeout", commandId: id}
        this.finish(id, o)
        out.push(o)
      }
    }
    return out
  }

  get pending(): number {
    return this.open.size
  }

  private finish(id: string, o: CommandOutcome) {
    const c = this.open.get(id)!
    this.open.delete(id)
    this.done.add(id)
    c.resolve(o)
  }
}

/**
 * What to send a device for an intent, given what its firmware understands
 * (DeviceRegistry.understands). Old firmware degrades: scroll falls back to
 * select-and-back where only those exist, and an intent it cannot express is
 * refused here rather than sent and NACKed.
 */
export function degradeFor(intentType: string, understands: (cmd: string) => boolean): {send: string} | {unsupported: true} {
  if (understands(intentType)) return {send: intentType}
  if (intentType === "intent.dismiss" && understands("intent.back")) return {send: "intent.back"}
  if (intentType === "intent.assistant_activate" && understands("intent.select")) return {send: "intent.select"}
  return {unsupported: true}
}
