/**
 * @fileoverview The finite set of things the agent can ask to happen. ANI-205.
 *
 * The model never builds a device packet or calls an OS API. It names an
 * action from this registry with arguments, and the registry decides — in
 * order, each step a typed refusal if it fails:
 *
 *   1. Is it a registered action, at a version that still exists?
 *   2. Do the arguments fit its schema exactly? Unknown fields, wrong types,
 *      oversized payloads and missing required fields are refused.
 *   3. Is there a device that can do it, right now (DeviceRegistry)?
 *   4. Does policy allow it, and is a consequential action confirmed for this
 *      exact payload (PolicyEngine)?
 *
 * Only then does a handler run, with a timeout. Outcomes are logged as
 * metadata — action, version, status, duration — never arguments.
 *
 * A consequential action cannot even be REGISTERED without a confirmation
 * policy, so "send" cannot be added to the agent's toolbox by forgetting a
 * flag.
 */

import type {DeviceContext, PolicyDecision, PolicyEngine} from "./policy"
import type {CapabilityId, DeviceRegistry} from "./registry"

/** A deliberately small JSON-Schema subset. Objects are always closed. */
export type Schema =
  | {type: "string"; maxLength: number; enum?: string[]; pattern?: string}
  | {type: "integer" | "number"; minimum?: number; maximum?: number}
  | {type: "boolean"}
  | {type: "array"; items: Schema; maxItems: number}
  | {type: "object"; properties: Record<string, Schema>; required?: string[]}

export type Destination = "glasses" | "ring" | "phone"

export interface ActionDefinition {
  id: string
  version: number
  description: string
  params: Extract<Schema, {type: "object"}>
  destination: Destination
  /** Device capabilities it needs on the destination. */
  needs: CapabilityId[]
  risk: "observe" | "state_change" | "consequential"
  /** Required, and must be "always", for a consequential action. */
  confirmation?: "always" | "none"
  /** Whether it interrupts the wearer (a card, a sound) or not. */
  output: "interrupt" | "silent"
  urgent?: boolean
  timeoutMs: number
  /** "once": the same payload runs at most one time; a repeat returns the first outcome. */
  idempotency: "once" | "repeatable"
  deprecated?: {replacedBy?: string}
}

export const MAX_ARGS_BYTES = 4096

export type PrepareResult =
  | {ok: true; plan: Plan}
  | {ok: false; reason: "unknown_action" | "unknown_version" | "too_large" | "invalid_args"; detail: string}
  | {ok: false; reason: "device_unavailable"; detail: string}
  | {ok: false; reason: "policy"; decision: PolicyDecision; summary?: string; payloadHash?: string}

export interface Plan {
  action: ActionDefinition
  args: Record<string, unknown>
  deviceId: string
  payloadHash: string
  deprecatedWarning?: string
}

export interface Outcome {
  actionId: string
  version: number
  status: "ok" | "timeout" | "error"
  durationMs: number
  result?: unknown
}

export function validate(schema: Schema, v: unknown, path = "args"): string | null {
  switch (schema.type) {
    case "string":
      if (typeof v !== "string") return `${path}: expected string`
      if (v.length > schema.maxLength) return `${path}: longer than ${schema.maxLength}`
      if (schema.enum && !schema.enum.includes(v)) return `${path}: not one of ${schema.enum.join(", ")}`
      if (schema.pattern && !new RegExp(schema.pattern).test(v)) return `${path}: does not match`
      return null
    case "integer":
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `${path}: expected number`
      if (schema.type === "integer" && !Number.isInteger(v)) return `${path}: expected integer`
      if (schema.minimum !== undefined && v < schema.minimum) return `${path}: below ${schema.minimum}`
      if (schema.maximum !== undefined && v > schema.maximum) return `${path}: above ${schema.maximum}`
      return null
    case "boolean":
      return typeof v === "boolean" ? null : `${path}: expected boolean`
    case "array":
      if (!Array.isArray(v)) return `${path}: expected array`
      if (v.length > schema.maxItems) return `${path}: more than ${schema.maxItems} items`
      for (let i = 0; i < v.length; i++) {
        const e = validate(schema.items, v[i], `${path}[${i}]`)
        if (e) return e
      }
      return null
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return `${path}: expected object`
      const o = v as Record<string, unknown>
      for (const k of Object.keys(o)) if (!(k in schema.properties)) return `${path}.${k}: unknown field`
      for (const r of schema.required ?? []) if (!(r in o)) return `${path}.${r}: required`
      for (const [k, s] of Object.entries(schema.properties)) {
        if (k in o) {
          const e = validate(s, o[k], `${path}.${k}`)
          if (e) return e
        }
      }
      return null
    }
  }
}

/** Stable across key order, so the same arguments always hash the same. */
export function payloadHash(actionId: string, version: number, args: unknown): string {
  const canon = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(canon) : x && typeof x === "object"
      ? Object.fromEntries(Object.keys(x as object).sort().map(k => [k, canon((x as Record<string, unknown>)[k])]))
      : x
  const s = `${actionId}@${version}:${JSON.stringify(canon(args))}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}

export class ActionRegistry {
  private defs = new Map<string, ActionDefinition[]>()
  private onceResults = new Map<string, Outcome>()
  readonly outcomes: Outcome[] = []

  constructor(
    private readonly deps: {
      devices: DeviceRegistry
      policy: PolicyEngine
      /** The device currently active for a destination (SessionManager.activeDevice, or the phone's own id). */
      target: (d: Destination) => string | undefined
      now: () => number
    },
  ) {}

  register(def: ActionDefinition): void {
    if (!/^[a-z][a-z0-9_.]{2,63}$/.test(def.id)) throw new Error(`Bad action id ${def.id}`)
    if (def.risk === "consequential" && def.confirmation !== "always") {
      throw new Error(`${def.id} is consequential and must declare confirmation: "always"`)
    }
    if (def.params.type !== "object") throw new Error("params must be an object schema")
    const versions = this.defs.get(def.id) ?? []
    if (versions.some(v => v.version === def.version)) throw new Error(`${def.id}@${def.version} registered twice`)
    versions.push(def)
    versions.sort((a, b) => a.version - b.version)
    this.defs.set(def.id, versions)
  }

  /**
   * The tool list the orchestrator is shown: only actions some connected
   * device can perform right now, at their newest non-deprecated version.
   */
  tools(): {name: string; version: number; description: string; parameters: Schema; risk: ActionDefinition["risk"]}[] {
    const out = []
    for (const versions of this.defs.values()) {
      const def = [...versions].reverse().find(v => !v.deprecated)
      if (!def) continue
      const id = this.deps.target(def.destination)
      if (!id || !this.deps.devices.check(id, def.needs).ok) continue
      out.push({name: def.id, version: def.version, description: def.description, parameters: def.params, risk: def.risk})
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  prepare(call: {action: string; version?: number; args: unknown; confirmationToken?: string}, ctx: DeviceContext): PrepareResult {
    const versions = this.defs.get(call.action)
    if (!versions) return {ok: false, reason: "unknown_action", detail: call.action}
    const def = call.version === undefined
      ? [...versions].reverse().find(v => !v.deprecated) ?? versions[versions.length - 1]
      : versions.find(v => v.version === call.version)
    if (!def) return {ok: false, reason: "unknown_version", detail: `${call.action}@${call.version}`}

    let size: number
    try {
      size = new TextEncoder().encode(JSON.stringify(call.args) ?? "").length
    } catch {
      return {ok: false, reason: "invalid_args", detail: "not serialisable"}
    }
    if (size > MAX_ARGS_BYTES) return {ok: false, reason: "too_large", detail: `${size} bytes`}
    const err = validate(def.params, call.args)
    if (err) return {ok: false, reason: "invalid_args", detail: err}
    const args = call.args as Record<string, unknown>

    const deviceId = this.deps.target(def.destination)
    if (!deviceId) return {ok: false, reason: "device_unavailable", detail: `no active ${def.destination}`}
    const cap = this.deps.devices.check(deviceId, def.needs)
    if (!cap.ok) return {ok: false, reason: "device_unavailable", detail: `${cap.capability}: ${cap.reason}`}

    const hash = payloadHash(def.id, def.version, args)
    const decision = this.deps.policy.authorizeAction(
      {
        actionId: def.id,
        risk: def.risk,
        payloadHash: hash,
        output: def.output,
        urgent: def.urgent,
        confirmationToken: call.confirmationToken,
        deviceTrusted: this.deps.devices.get(deviceId)?.trust === "enrolled",
      },
      ctx,
    )
    if (decision.decision !== "allow") {
      return {ok: false, reason: "policy", decision, payloadHash: hash, summary: decision.decision === "require_confirmation" ? `${def.description}: ${summarise(args)}` : undefined}
    }
    return {
      ok: true,
      plan: {
        action: def,
        args,
        deviceId,
        payloadHash: hash,
        deprecatedWarning: def.deprecated ? `${def.id}@${def.version} is deprecated${def.deprecated.replacedBy ? `; use ${def.deprecated.replacedBy}` : ""}` : undefined,
      },
    }
  }

  /** Run a prepared plan with its timeout. "once" actions never run the same payload twice. */
  async execute(plan: Plan, handler: (deviceId: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>): Promise<Outcome> {
    const key = `${plan.action.id}:${plan.payloadHash}`
    if (plan.action.idempotency === "once") {
      const prior = this.onceResults.get(key)
      if (prior && prior.status === "ok") return prior
    }
    const started = this.deps.now()
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">(r => {
      timer = setTimeout(() => {
        ctrl.abort()
        r("timeout")
      }, plan.action.timeoutMs)
    })
    let outcome: Outcome
    try {
      const r = await Promise.race([handler(plan.deviceId, plan.args, ctrl.signal), timeout])
      outcome = r === "timeout"
        ? {actionId: plan.action.id, version: plan.action.version, status: "timeout", durationMs: this.deps.now() - started}
        : {actionId: plan.action.id, version: plan.action.version, status: "ok", durationMs: this.deps.now() - started, result: r}
    } catch {
      outcome = {actionId: plan.action.id, version: plan.action.version, status: "error", durationMs: this.deps.now() - started}
    } finally {
      clearTimeout(timer)
    }
    if (plan.action.idempotency === "once") this.onceResults.set(key, outcome)
    // Metadata only: the result and arguments stay out of the log.
    this.outcomes.push({actionId: outcome.actionId, version: outcome.version, status: outcome.status, durationMs: outcome.durationMs})
    return outcome
  }
}

function summarise(args: Record<string, unknown>): string {
  return Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v)}`).join(", ").slice(0, 160)
}

/** The built-in device and phone actions ANI-205 lists. Tool adapters (ANI-208) register their own. */
export const BUILTIN_ACTIONS: ActionDefinition[] = [
  {id: "hud.show_card", version: 1, description: "Show a two-line card on the glasses", destination: "glasses", needs: ["display"], risk: "state_change", output: "interrupt", timeoutMs: 1000, idempotency: "repeatable",
    params: {type: "object", properties: {line1: {type: "string", maxLength: 64}, line2: {type: "string", maxLength: 64}}, required: ["line1"]}},
  {id: "hud.navigate", version: 1, description: "Move between HUD cards", destination: "glasses", needs: ["display"], risk: "state_change", output: "silent", timeoutMs: 500, idempotency: "repeatable",
    params: {type: "object", properties: {direction: {type: "string", maxLength: 8, enum: ["next", "prev", "home"]}}, required: ["direction"]}},
  {id: "audio.play", version: 1, description: "Speak a short sentence on the glasses", destination: "glasses", needs: ["speaker"], risk: "state_change", output: "interrupt", timeoutMs: 5000, idempotency: "repeatable",
    params: {type: "object", properties: {text: {type: "string", maxLength: 300}}, required: ["text"]}},
  {id: "ring.haptic", version: 1, description: "Play a haptic pattern on the ring", destination: "ring", needs: ["haptics"], risk: "state_change", output: "silent", timeoutMs: 500, idempotency: "repeatable",
    params: {type: "object", properties: {pattern: {type: "string", maxLength: 16, enum: ["tick", "double", "long", "alert"]}}, required: ["pattern"]}},
  {id: "camera.request_capture", version: 1, description: "Ask the glasses for one still photo", destination: "glasses", needs: ["camera.still"], risk: "state_change", output: "silent", timeoutMs: 3000, idempotency: "repeatable",
    params: {type: "object", properties: {purpose: {type: "string", maxLength: 32, enum: ["vision_qa", "upi_scan"]}}, required: ["purpose"]}},
  {id: "calendar.read_next", version: 1, description: "Read the next permitted calendar items", destination: "phone", needs: [], risk: "observe", output: "silent", timeoutMs: 2000, idempotency: "repeatable",
    params: {type: "object", properties: {count: {type: "integer", minimum: 1, maximum: 5}}}},
  {id: "task.create", version: 1, description: "Create a task", destination: "phone", needs: [], risk: "state_change", output: "silent", timeoutMs: 2000, idempotency: "once",
    params: {type: "object", properties: {title: {type: "string", maxLength: 120}, dueAt: {type: "integer", minimum: 0}}, required: ["title"]}},
  {id: "message.draft", version: 1, description: "Draft a message without sending it", destination: "phone", needs: [], risk: "state_change", output: "silent", timeoutMs: 2000, idempotency: "repeatable",
    params: {type: "object", properties: {to: {type: "string", maxLength: 80}, body: {type: "string", maxLength: 500}}, required: ["to", "body"]}},
  {id: "message.send", version: 1, description: "Send a message", destination: "phone", needs: [], risk: "consequential", confirmation: "always", output: "silent", timeoutMs: 5000, idempotency: "once",
    params: {type: "object", properties: {to: {type: "string", maxLength: 80}, body: {type: "string", maxLength: 500}}, required: ["to", "body"]}},
  {id: "app.open", version: 1, description: "Open an allow-listed phone app", destination: "phone", needs: [], risk: "state_change", output: "silent", timeoutMs: 2000, idempotency: "repeatable",
    params: {type: "object", properties: {app: {type: "string", maxLength: 32, enum: ["maps", "calendar", "messages", "payments"]}}, required: ["app"]}},
]
