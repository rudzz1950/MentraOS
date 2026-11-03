/**
 * @fileoverview Which devices are paired, and what each can do right now. ANI-197.
 *
 * One registry for ring and glasses alike. Its single rule is that a
 * capability is only "supported" when the device said so in THIS session.
 * Nothing is inferred from a model name ("the X2 has a camera") or carried
 * over from a profile cached last week: a firmware update can remove a
 * feature, a permission can be withdrawn, a sensor can fail, and acting on a
 * stale belief means sending a command to hardware that is not there.
 *
 * Each capability is one of five states, because "no" has several meanings
 * the wearer needs told apart:
 *
 *   supported          reported this session, usable
 *   unavailable        the device does not have it
 *   permission_denied  it has it, and the user or OS has not allowed it
 *   degraded           it has it, working badly (low battery, sensor fault)
 *   unknown            not reported this session — treated as not usable
 */

export type DeviceKind = "ring" | "glasses" | "phone"

export type CapabilityId =
  | "camera.still"
  | "camera.clip"
  | "mic.lc3"
  | "mic.pcm"
  | "vad"
  | "speaker"
  | "display"
  | "button"
  | "imu"
  | "haptics"
  | "ring.gestures"
  | "wellness.hr"
  | "wellness.spo2"
  | "battery.telemetry"

export type CapabilityState = "supported" | "unavailable" | "permission_denied" | "degraded" | "unknown"

export interface Capability {
  id: CapabilityId
  state: CapabilityState
  /** Details that matter to a caller, e.g. display geometry or audio format. Never inferred. */
  params?: Record<string, string | number | boolean>
}

export interface DeviceDescriptor {
  deviceId: string
  kind: DeviceKind
  model: string
  hardwareRevision?: string
  firmwareVersion: string
  /** Link protocol version the device speaks. */
  protocolVersion: number
  trust: "enrolled" | "pending" | "revoked"
  lastSeenAt: number
}

/** What a device reports when a session is established (DeviceInfo, ANI-68). */
export interface DeviceHello {
  descriptor: Omit<DeviceDescriptor, "lastSeenAt" | "trust">
  capabilities: Capability[]
  /** Commands the device firmware understands, by name. */
  commands: string[]
}

/** Protocol versions this phone build can speak. v0 is the frozen dev contract, v1 adds DisplayProfile. */
export const SUPPORTED_PROTOCOLS = {min: 0, max: 1}

export type NegotiationResult =
  | {ok: true; protocolVersion: number; device: DeviceDescriptor}
  | {ok: false; reason: "protocol_too_old" | "protocol_too_new" | "revoked" | "not_enrolled"}

export type CapabilityCheck =
  | {ok: true}
  | {ok: false; reason: "no_device" | "device_revoked" | "not_connected" | CapabilityState; device?: string; capability: CapabilityId}

export interface RegistryChange {
  deviceId: string
  /** Capabilities whose state changed, with before and after. */
  changed: {id: CapabilityId; from: CapabilityState; to: CapabilityState}[]
  commandsAdded: string[]
  commandsRemoved: string[]
}

interface Entry {
  device: DeviceDescriptor
  caps: Map<CapabilityId, Capability>
  commands: Set<string>
  /** Whether the capabilities were reported in the current session. */
  fresh: boolean
}

export class DeviceRegistry {
  private entries = new Map<string, Entry>()
  private listeners: ((c: RegistryChange) => void)[] = []

  constructor(private readonly now: () => number) {}

  /** Record a device the user enrolled (pairing, ANI-198). Capabilities come later, from its hello. */
  enroll(d: Omit<DeviceDescriptor, "lastSeenAt" | "trust">): void {
    const existing = this.entries.get(d.deviceId)
    this.entries.set(d.deviceId, {
      device: {...d, trust: "enrolled", lastSeenAt: existing?.device.lastSeenAt ?? 0},
      caps: existing?.caps ?? new Map(),
      commands: existing?.commands ?? new Set(),
      fresh: false,
    })
  }

  revoke(deviceId: string): void {
    const e = this.entries.get(deviceId)
    if (!e) return
    e.device.trust = "revoked"
    e.fresh = false
  }

  /**
   * Session establishment: the device says what it is and what it can do.
   * Version compatibility is checked first; the capability set then REPLACES
   * whatever was known before, so a firmware update that removed a feature
   * removes it here too.
   */
  negotiate(hello: DeviceHello): NegotiationResult {
    const e = this.entries.get(hello.descriptor.deviceId)
    if (!e) return {ok: false, reason: "not_enrolled"}
    if (e.device.trust === "revoked") return {ok: false, reason: "revoked"}
    const v = hello.descriptor.protocolVersion
    if (v < SUPPORTED_PROTOCOLS.min) return {ok: false, reason: "protocol_too_old"}
    if (v > SUPPORTED_PROTOCOLS.max) return {ok: false, reason: "protocol_too_new"}

    const before = new Map([...e.caps].map(([k, c]) => [k, c.state]))
    const beforeCmds = e.commands
    e.device = {...e.device, ...hello.descriptor, trust: e.device.trust, lastSeenAt: this.now()}
    e.caps = new Map(hello.capabilities.map(c => [c.id, {...c}]))
    e.commands = new Set(hello.commands)
    e.fresh = true

    const ids = new Set<CapabilityId>([...before.keys(), ...e.caps.keys()])
    const change: RegistryChange = {
      deviceId: e.device.deviceId,
      changed: [...ids]
        .map(id => ({id, from: before.get(id) ?? "unknown", to: e.caps.get(id)?.state ?? "unknown"}))
        .filter(c => c.from !== c.to),
      commandsAdded: [...e.commands].filter(c => !beforeCmds.has(c)),
      commandsRemoved: [...beforeCmds].filter(c => !e.commands.has(c)),
    }
    if (change.changed.length || change.commandsAdded.length || change.commandsRemoved.length) this.emit(change)
    return {ok: true, protocolVersion: v, device: {...e.device}}
  }

  /** A capability changed mid-session: permission withdrawn, sensor degraded, battery low. */
  updateCapability(deviceId: string, id: CapabilityId, state: CapabilityState, params?: Capability["params"]): void {
    const e = this.entries.get(deviceId)
    if (!e) return
    const from = e.caps.get(id)?.state ?? "unknown"
    e.caps.set(id, {id, state, params: params ?? e.caps.get(id)?.params})
    if (from !== state) this.emit({deviceId, changed: [{id, from, to: state}], commandsAdded: [], commandsRemoved: []})
  }

  /** The link dropped. What the device reported is no longer current until it says it again. */
  markStale(deviceId: string): void {
    const e = this.entries.get(deviceId)
    if (e) e.fresh = false
  }

  seen(deviceId: string): void {
    const e = this.entries.get(deviceId)
    if (e) e.device.lastSeenAt = this.now()
  }

  get(deviceId: string): DeviceDescriptor | undefined {
    const e = this.entries.get(deviceId)
    return e ? {...e.device} : undefined
  }

  devices(kind?: DeviceKind): DeviceDescriptor[] {
    return [...this.entries.values()].filter(e => !kind || e.device.kind === kind).map(e => ({...e.device}))
  }

  /** The state a capability is in now. Anything not reported this session is unknown. */
  capability(deviceId: string, id: CapabilityId): Capability {
    const e = this.entries.get(deviceId)
    if (!e || !e.fresh || e.device.trust !== "enrolled") return {id, state: "unknown"}
    return e.caps.get(id) ?? {id, state: "unknown"}
  }

  /** Whether an action needing these capabilities can be sent to this device. */
  check(deviceId: string, needs: CapabilityId[], opts: {allowDegraded?: boolean} = {}): CapabilityCheck {
    const e = this.entries.get(deviceId)
    if (!e) return {ok: false, reason: "no_device", capability: needs[0]}
    if (e.device.trust === "revoked") return {ok: false, reason: "device_revoked", device: deviceId, capability: needs[0]}
    if (!e.fresh) return {ok: false, reason: "not_connected", device: deviceId, capability: needs[0]}
    for (const id of needs) {
      const s = this.capability(deviceId, id).state
      if (s === "supported" || (s === "degraded" && opts.allowDegraded)) continue
      return {ok: false, reason: s, device: deviceId, capability: id}
    }
    return {ok: true}
  }

  /** Whether the device's firmware understands this command. */
  understands(deviceId: string, command: string): boolean {
    const e = this.entries.get(deviceId)
    return !!e && e.fresh && e.commands.has(command)
  }

  /** Capabilities usable right now across connected devices, for the action registry's tool list. */
  available(): {deviceId: string; kind: DeviceKind; capabilities: CapabilityId[]}[] {
    return [...this.entries.values()]
      .filter(e => e.fresh && e.device.trust === "enrolled")
      .map(e => ({
        deviceId: e.device.deviceId,
        kind: e.device.kind,
        capabilities: [...e.caps.values()].filter(c => c.state === "supported").map(c => c.id),
      }))
  }

  onChange(fn: (c: RegistryChange) => void): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn)
    }
  }

  private emit(c: RegistryChange) {
    for (const l of this.listeners) l(c)
  }
}
