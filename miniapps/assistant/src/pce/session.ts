/**
 * @fileoverview One ecosystem session across ring, glasses and phone. ANI-199.
 *
 * The phone coordinates; each device stays the authority for its own
 * physical state. So this tracks LINKS and the SESSION built on them, and
 * when a link comes back it re-negotiates (the registry replaces whatever was
 * believed about the device) rather than assuming nothing changed.
 *
 * Two rules carry most of the weight:
 *
 *   One device going away never disturbs another. Losing the ring leaves the
 *   glasses' state exactly as it was; the session becomes partial, not broken.
 *
 *   Reconnect restores current state and nothing else. A command queued while
 *   a device was away is sent only if it has not expired AND is not
 *   consequential. "Send the message" from before a radio dropout is not
 *   something to do silently three minutes later; the wearer is asked again.
 *
 * Process death and phone reboot are modelled by `snapshot()` / `restore()`:
 * after one, every link is treated as disconnected until the device says
 * otherwise, because the old link state describes a radio that no longer
 * exists.
 */

import type {DeviceHello, DeviceKind, DeviceRegistry} from "./registry"

export type LinkState = "unpaired" | "paired" | "connecting" | "connected" | "degraded" | "disconnected" | "revoked" | "updating"

export type SessionState = "none" | "establishing" | "ready" | "partial" | "suspended" | "recovering" | "ended"

/** What works right now, in the terms the wearer would use. */
export type Mode = "full" | "ring_only" | "glasses_only" | "phone_only"

export interface LinkHealth {
  rssi?: number
  batteryPercent?: number
  firmwareVersion?: string
  lastSeenAt: number
}

export interface PendingCommand {
  id: string
  deviceId: string
  /** Sending it changes something outside the conversation. Never replayed. */
  consequential: boolean
  expiresAt: number
  payload: unknown
}

export interface RestoreResult {
  send: PendingCommand[]
  dropped: {id: string; reason: "expired" | "consequential"}[]
}

interface Link {
  deviceId: string
  kind: DeviceKind
  state: LinkState
  health: LinkHealth
  attempts: number
  nextAttemptAt: number
}

export interface SessionOptions {
  registry: DeviceRegistry
  now: () => number
  /** First reconnect delay; doubles per attempt. One second by default. */
  backoffBaseMs?: number
  /** Ceiling on the reconnect delay. One minute by default. */
  backoffMaxMs?: number
  /** RSSI below this is "degraded". -85 dBm by default. */
  weakRssi?: number
  /** Battery at or below this is "degraded". 10% by default. */
  lowBattery?: number
}

export class SessionManager {
  private links = new Map<string, Link>()
  private active: Partial<Record<"ring" | "glasses", string>> = {}
  private pending: PendingCommand[] = []
  private state: SessionState = "none"
  private wasReady = false
  private sessionId: string | null = null
  private n = 0

  constructor(private readonly opts: SessionOptions) {}

  // ---- devices ---------------------------------------------------------

  /** A device enrolled in the registry becomes a link we manage. */
  addDevice(deviceId: string, kind: DeviceKind): void {
    if (!this.links.has(deviceId)) {
      this.links.set(deviceId, {deviceId, kind, state: "paired", health: {lastSeenAt: 0}, attempts: 0, nextAttemptAt: 0})
    }
    // The first device of a role becomes active; any later one needs choosing.
    if ((kind === "ring" || kind === "glasses") && !this.active[kind]) this.active[kind] = deviceId
  }

  /** Explicit choice between several glasses profiles. Never automatic. */
  setActive(role: "ring" | "glasses", deviceId: string): void {
    const l = this.links.get(deviceId)
    if (!l || l.kind !== role) throw new Error(`${deviceId} is not a ${role}`)
    if (l.state === "revoked") throw new Error(`${deviceId} has been revoked`)
    this.active[role] = deviceId
    this.recompute()
  }

  activeDevice(role: "ring" | "glasses"): string | undefined {
    return this.active[role]
  }

  // ---- session ---------------------------------------------------------

  start(): string {
    this.sessionId = `sess-${this.opts.now().toString(36)}-${(++this.n).toString(36)}`
    this.state = "establishing"
    this.wasReady = false
    this.recompute()
    return this.sessionId
  }

  /** The phone is going to sleep, or the app to the background. */
  suspend(): void {
    if (this.state !== "none" && this.state !== "ended") this.state = "suspended"
  }

  wake(): void {
    if (this.state === "suspended") {
      this.state = "recovering"
      this.recompute()
    }
  }

  /** Teardown. Pending commands are dropped: a new session starts clean. */
  end(_reason: "user" | "phone_replaced" | "signed_out" = "user"): void {
    this.state = "ended"
    this.pending = []
    this.sessionId = null
    for (const l of this.links.values()) if (l.state !== "revoked") l.state = "paired"
  }

  get id(): string | null {
    return this.sessionId
  }

  // ---- link events -----------------------------------------------------

  connecting(deviceId: string): void {
    const l = this.must(deviceId)
    if (l.state === "revoked") return
    l.state = "connecting"
  }

  /** The device said hello. Capabilities are negotiated afresh, every time. */
  connected(hello: DeviceHello): {ok: true} | {ok: false; reason: string} {
    const l = this.must(hello.descriptor.deviceId)
    const r = this.opts.registry.negotiate(hello)
    if (!r.ok) {
      l.state = r.reason === "revoked" ? "revoked" : "disconnected"
      this.recompute()
      return {ok: false, reason: r.reason}
    }
    l.state = "connected"
    l.attempts = 0
    l.nextAttemptAt = 0
    l.health = {...l.health, firmwareVersion: hello.descriptor.firmwareVersion, lastSeenAt: this.opts.now()}
    this.recompute()
    return {ok: true}
  }

  health(deviceId: string, h: Omit<Partial<LinkHealth>, "lastSeenAt">): void {
    const l = this.must(deviceId)
    l.health = {...l.health, ...h, lastSeenAt: this.opts.now()}
    this.opts.registry.seen(deviceId)
    if (l.state === "connected" || l.state === "degraded") {
      const weak = (h.rssi ?? l.health.rssi ?? 0) < (this.opts.weakRssi ?? -85)
      const low = (l.health.batteryPercent ?? 100) <= (this.opts.lowBattery ?? 10)
      l.state = weak || low ? "degraded" : "connected"
    }
    this.recompute()
  }

  disconnected(deviceId: string): void {
    const l = this.must(deviceId)
    if (l.state === "revoked") return
    l.state = "disconnected"
    l.attempts = 0
    l.nextAttemptAt = this.opts.now()
    this.opts.registry.markStale(deviceId)
    this.recompute()
  }

  /** Firmware update in progress: the device is deliberately away. */
  updating(deviceId: string): void {
    const l = this.must(deviceId)
    l.state = "updating"
    this.opts.registry.markStale(deviceId)
    this.recompute()
  }

  revoked(deviceId: string): void {
    const l = this.must(deviceId)
    l.state = "revoked"
    this.opts.registry.revoke(deviceId)
    this.pending = this.pending.filter(p => p.deviceId !== deviceId)
    for (const role of ["ring", "glasses"] as const) if (this.active[role] === deviceId) delete this.active[role]
    this.recompute()
  }

  linkState(deviceId: string): LinkState | undefined {
    return this.links.get(deviceId)?.state
  }

  // ---- reconnect -------------------------------------------------------

  /**
   * Which disconnected devices to try now, in priority order: the active
   * glasses first (they hold the display the wearer is looking at), then the
   * active ring, then inactive profiles. Each attempt pushes that device's
   * next attempt out by doubling backoff.
   */
  reconnectDue(): string[] {
    const now = this.opts.now()
    const rank = (l: Link) =>
      l.deviceId === this.active.glasses ? 0 : l.deviceId === this.active.ring ? 1 : 2
    const due = [...this.links.values()]
      .filter(l => l.state === "disconnected" && l.nextAttemptAt <= now)
      .sort((a, b) => rank(a) - rank(b))
    for (const l of due) {
      const base = this.opts.backoffBaseMs ?? 1000
      const max = this.opts.backoffMaxMs ?? 60_000
      l.nextAttemptAt = now + Math.min(max, base * 2 ** l.attempts)
      l.attempts++
    }
    return due.map(l => l.deviceId)
  }

  // ---- commands --------------------------------------------------------

  /** A command for a device that is away. Kept only so it can be judged on reconnect. */
  hold(cmd: PendingCommand): void {
    this.pending.push(cmd)
  }

  /** On reconnect: what may be sent now. Expired and consequential commands never are. */
  restore(deviceId: string): RestoreResult {
    const now = this.opts.now()
    const mine = this.pending.filter(p => p.deviceId === deviceId)
    this.pending = this.pending.filter(p => p.deviceId !== deviceId)
    const out: RestoreResult = {send: [], dropped: []}
    for (const p of mine) {
      if (p.expiresAt <= now) out.dropped.push({id: p.id, reason: "expired"})
      else if (p.consequential) out.dropped.push({id: p.id, reason: "consequential"})
      else out.send.push(p)
    }
    return out
  }

  // ---- status ----------------------------------------------------------

  get sessionState(): SessionState {
    return this.state
  }

  mode(): Mode {
    const up = (role: "ring" | "glasses") => {
      const id = this.active[role]
      const s = id ? this.links.get(id)?.state : undefined
      return s === "connected" || s === "degraded"
    }
    const ring = up("ring")
    const glasses = up("glasses")
    if (ring && glasses) return "full"
    if (glasses) return "glasses_only"
    if (ring) return "ring_only"
    return "phone_only"
  }

  /** One line for the wearer, saying what works. */
  status(): {state: SessionState; mode: Mode; message: string} {
    const mode = this.mode()
    const degraded = [...this.links.values()].some(l => l.state === "degraded" && Object.values(this.active).includes(l.deviceId))
    const message =
      this.state === "none" || this.state === "ended" ? "Not connected."
        : this.state === "suspended" ? "Paused."
          : mode === "full" ? (degraded ? "Connected, weak signal or low battery." : "Ready.")
            : mode === "glasses_only" ? "Glasses only: ring not connected."
              : mode === "ring_only" ? "Ring only: glasses not connected."
                : "Phone only: no devices connected."
    return {state: this.state, mode, message}
  }

  // ---- process death ---------------------------------------------------

  /** What survives the app being killed. Pending commands do not: they are not current state. */
  snapshot(): {version: 1; links: {deviceId: string; kind: DeviceKind; revoked: boolean}[]; active: SessionManager["active"]; sessionId: string | null} {
    return {
      version: 1,
      links: [...this.links.values()].map(l => ({deviceId: l.deviceId, kind: l.kind, revoked: l.state === "revoked"})),
      active: {...this.active},
      sessionId: this.sessionId,
    }
  }

  static restore(snap: ReturnType<SessionManager["snapshot"]>, opts: SessionOptions): SessionManager {
    if (snap.version !== 1) throw new Error("Unknown session snapshot version")
    const s = new SessionManager(opts)
    for (const l of snap.links) {
      s.addDevice(l.deviceId, l.kind)
      const link = s.links.get(l.deviceId)!
      link.state = l.revoked ? "revoked" : "disconnected"
      link.nextAttemptAt = opts.now()
      opts.registry.markStale(l.deviceId)
    }
    s.active = {...snap.active}
    s.sessionId = snap.sessionId
    s.state = snap.sessionId ? "recovering" : "none"
    s.wasReady = true
    s.recompute()
    return s
  }

  private must(deviceId: string): Link {
    const l = this.links.get(deviceId)
    if (!l) throw new Error(`Unknown device ${deviceId}`)
    return l
  }

  private recompute(): void {
    if (this.state === "none" || this.state === "ended" || this.state === "suspended") return
    const roles = (["ring", "glasses"] as const).filter(r => this.active[r])
    const ups = roles.filter(r => {
      const s = this.links.get(this.active[r]!)?.state
      return s === "connected" || s === "degraded"
    })
    if (roles.length > 0 && ups.length === roles.length) {
      this.state = "ready"
      this.wasReady = true
    } else if (this.wasReady) {
      this.state = ups.length ? "partial" : "recovering"
    } else {
      this.state = ups.length ? "partial" : "establishing"
    }
  }
}
