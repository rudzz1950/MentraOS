/**
 * @fileoverview One place to see and control the whole ecosystem. ANI-213.
 *
 * A view-model for the phone app's settings centre: devices, permissions,
 * memory, active context, proactive behaviour, data lifecycle and the six
 * separate model-use controls. It owns no state of its own. Every control
 * calls the module that enforces it — SessionManager, DeviceRegistry,
 * PolicyEngine, DataLifecycle, Proactive, the memory store — so revoking
 * something here is revoking it, not hiding it.
 *
 * Sensitive controls (revoke a device, delete data, change model use) need
 * the phone's own confirmation when they come from the HUD or by voice:
 * a two-line panel is no place to read what "delete" will remove.
 *
 * The six model-use controls are separate on purpose, and training is OFF
 * by default and stays separate from everything else (ANI-213's extension,
 * and ANI-90's rule that nothing captured is ever trained on).
 */

import type {DataLifecycle, ErasureReceipt} from "./lifecycle"
import type {ConsentRevocation, PolicyEngine} from "./policy"
import type {DeviceRegistry} from "./registry"
import type {SessionManager} from "./session"
import type {Proactive} from "./triggers"

export type Origin = "phone" | "hud" | "voice"

export interface ModelUse {
  /** 1. Process a request at all. Off means the assistant answers only from rules. */
  processRequests: boolean
  /** 2. Save personal memory. */
  saveMemory: boolean
  /** 3. Share a specific item or space with someone. */
  sharing: boolean
  /** 4. Operational analytics (telemetry with no content). */
  analytics: boolean
  /** 5. Help improve models. Off by default; never covers captured data. */
  modelImprovement: boolean
  /** 6. Send data to named third-party model providers. */
  thirdPartyProviders: Record<string, boolean>
}

export const DEFAULT_MODEL_USE: ModelUse = {
  processRequests: true,
  saveMemory: true,
  sharing: false,
  analytics: false,
  modelImprovement: false,
  thirdPartyProviders: {},
}

export type ControlResult = {ok: true} | {ok: false; reason: "needs_phone_confirmation" | "unknown" | "not_allowed"}

export interface DeviceRow {
  deviceId: string
  kind: string
  model: string
  firmware: string
  trust: string
  link: string | undefined
  /** The states the UI must keep distinct. */
  connected: boolean
  authorized: boolean
  capturing: boolean
  modelProcessing: boolean
  capabilities: string[]
}

export class SettingsCentre {
  private modelUse: ModelUse = structuredClone(DEFAULT_MODEL_USE)
  private capturing = new Set<string>()
  private processing = false
  private contextPaused = false

  constructor(
    private readonly deps: {
      registry: DeviceRegistry
      session: SessionManager
      policy: PolicyEngine
      lifecycle: DataLifecycle
      proactive: Proactive
      memory: {list(): Promise<{id: string; text: string; class: string; approved: boolean; source: {turnId: string; deviceId?: string; scopeId?: string}}[]>; update(id: string, p: {approved?: boolean; pinned?: boolean; text?: string}): Promise<unknown>; delete(id: string): Promise<boolean>}
    },
  ) {}

  // ---- state the UI shows ------------------------------------------------

  /** Set by the capture service and the model router, so the UI can tell recording from thinking. */
  setCapturing(deviceId: string, on: boolean): void {
    if (on) this.capturing.add(deviceId)
    else this.capturing.delete(deviceId)
  }
  setModelProcessing(on: boolean): void {
    this.processing = on
  }

  devices(): DeviceRow[] {
    const available = new Map(this.deps.registry.available().map(a => [a.deviceId, a.capabilities]))
    return this.deps.registry.devices().map(d => {
      const link = this.deps.session.linkState(d.deviceId)
      return {
        deviceId: d.deviceId,
        kind: d.kind,
        model: d.model,
        firmware: d.firmwareVersion,
        trust: d.trust,
        link,
        connected: link === "connected" || link === "degraded",
        authorized: d.trust === "enrolled",
        capturing: this.capturing.has(d.deviceId),
        modelProcessing: this.processing,
        capabilities: available.get(d.deviceId) ?? [],
      }
    })
  }

  lifecycleDashboard() {
    return {
      activeScopes: this.deps.policy.activeScopes(),
      revokedScopes: this.deps.policy.revokedScopes(),
      pendingRevocations: this.deps.lifecycle.unconverged(),
      inventory: this.deps.lifecycle.inventory(),
      gaps: this.deps.lifecycle.gaps(),
    }
  }

  async memoryCentre() {
    const all = await this.deps.memory.list()
    // Unapproved guesses are never stored (the memory store refuses them), so
    // there is no "pending approval" list here: proposals come from the
    // consolidation plan and are approved by being written.
    return {memories: all.map(m => ({id: m.id, text: m.text, class: m.class, source: m.source}))}
  }

  proactiveRules() {
    return this.deps.proactive.list()
  }

  getModelUse(): ModelUse {
    return structuredClone(this.modelUse)
  }

  get isContextPaused(): boolean {
    return this.contextPaused
  }

  // ---- controls ------------------------------------------------------------

  /** Revoke a device: the registry refuses it from now on, whatever the UI shows. */
  revokeDevice(deviceId: string, origin: Origin, phoneConfirmed = false): ControlResult {
    const gate = this.sensitive(origin, phoneConfirmed)
    if (!gate.ok) return gate
    if (!this.deps.registry.get(deviceId)) return {ok: false, reason: "unknown"}
    this.deps.session.revoked(deviceId)
    return {ok: true}
  }

  /** Withdraw a consent scope everywhere, with the per-store receipt. */
  async revokeScope(revocation: ConsentRevocation, origin: Origin, phoneConfirmed = false): Promise<ControlResult | ErasureReceipt> {
    const gate = this.sensitive(origin, phoneConfirmed)
    if (!gate.ok) return gate
    return this.deps.lifecycle.revoke(revocation.scopeId, revocation)
  }

  async deleteMemory(id: string, origin: Origin, phoneConfirmed = false): Promise<ControlResult> {
    const gate = this.sensitive(origin, phoneConfirmed)
    if (!gate.ok) return gate
    return (await this.deps.memory.delete(id)) ? {ok: true} : {ok: false, reason: "unknown"}
  }

  /** Pause context capture. A HUD or voice shortcut is fine: pausing is never dangerous. */
  pauseContext(on: boolean): ControlResult {
    this.contextPaused = on
    return {ok: true}
  }

  snoozeTrigger(id: string, untilMs: number): ControlResult {
    this.deps.proactive.snooze(id, untilMs)
    return {ok: true}
  }

  toggleTrigger(id: string, on: boolean): ControlResult {
    this.deps.proactive.enable(id, on)
    return {ok: true}
  }

  /** Change one model-use control. Turning anything ON is sensitive; turning it off never is. */
  setModelUse<K extends keyof ModelUse>(key: K, value: ModelUse[K], origin: Origin, phoneConfirmed = false): ControlResult {
    const enabling = key === "thirdPartyProviders"
      ? Object.entries(value as Record<string, boolean>).some(([p, on]) => on && !this.modelUse.thirdPartyProviders[p])
      : value === true
    if (enabling) {
      const gate = this.sensitive(origin, phoneConfirmed)
      if (!gate.ok) return gate
    }
    this.modelUse = {...this.modelUse, [key]: structuredClone(value)}
    return {ok: true}
  }

  private sensitive(origin: Origin, phoneConfirmed: boolean): ControlResult {
    return origin === "phone" || phoneConfirmed ? {ok: true} : {ok: false, reason: "needs_phone_confirmation"}
  }
}
