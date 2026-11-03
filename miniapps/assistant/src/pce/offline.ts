/**
 * @fileoverview Useful and safe with no internet. ANI-210.
 *
 * Every action has an offline class, decided when it is registered, not
 * guessed when the network drops:
 *
 *   device_local    runs on the ring or glasses (mute, stop capture, HUD nav)
 *   phone_local     runs on the phone (timers, memory, policy, cached context)
 *   queued_sync     may wait for the network: non-consequential uploads only
 *   cloud_required  needs a hosted service; offline it is refused, plainly
 *   unavailable     not part of this deployment
 *
 * Two rules from the issue are structural here:
 *
 *   A consequential action is never queued. Offline, it is refused and the
 *   wearer is told to try again; nothing sends itself silently when the
 *   signal returns. `enqueue` throws for one, so it cannot be done by accident.
 *
 *   Nothing revoked waits in a queue. Queued work and cached context carry
 *   their scope; a revocation purges both immediately (PolicyEngine.onRevoke),
 *   and the scope is checked again at flush time in case the revocation
 *   arrived while the item was in flight.
 *
 * Model routing is NOT re-implemented: the existing ModelRouter keeps its
 * tiers and its consent rules. `availableTiers` decides which configured
 * tiers are reachable in the current connectivity and says, in the wearer's
 * terms, what is degraded.
 */

import type {Locality} from "../agent/egress"
import type {ModelClient} from "../agent/ports"
import type {PolicyEngine, Purpose} from "./policy"

export type OfflineClass = "device_local" | "phone_local" | "queued_sync" | "cloud_required" | "unavailable"

export type Connectivity = "online" | "site_only" | "offline"

/** The classes for the built-in actions, and the essentials that must work with no network. */
export const OFFLINE_CLASS: Record<string, OfflineClass> = {
  "hud.show_card": "device_local",
  "hud.navigate": "device_local",
  "ring.haptic": "device_local",
  "audio.play": "device_local",
  "camera.request_capture": "device_local",
  "capture.stop": "device_local",
  "audio.mute": "device_local",
  "timer.set": "phone_local",
  "memory.note": "phone_local",
  "calendar.read_next": "phone_local",
  "task.create": "queued_sync",
  "message.draft": "phone_local",
  "message.send": "cloud_required",
  "vision.ask": "cloud_required",
  "app.open": "phone_local",
}

export type Submit =
  | {run: "now"}
  /** Allowed to wait for the network: the caller enqueues it. */
  | {run: "queue"}
  | {run: "refused"; reason: "needs_network" | "not_in_deployment" | "consequential_not_queued"; message: string}

export interface QueuedItem {
  id: string
  actionId: string
  payload: unknown
  scopeId?: string
  purpose?: Purpose
  enqueuedAt: number
  attempts: number
}

export class OfflineCoordinator {
  private queue: QueuedItem[] = []
  private cache = new Map<string, {value: unknown; scopeId?: string; expiresAt: number}>()
  private n = 0

  constructor(
    private readonly deps: {
      policy: PolicyEngine
      now: () => number
      connectivity: () => Connectivity
      /** Bound on queued items. 100 by default. */
      maxQueue?: number
      /** Attempts before an item is dropped as failed. 5 by default. */
      maxAttempts?: number
    },
  ) {
    deps.policy.onRevoke(scopeId => this.purge(scopeId))
  }

  /** What happens to an action submitted now. */
  submit(actionId: string, consequential: boolean): Submit {
    const cls = OFFLINE_CLASS[actionId] ?? "unavailable"
    const net = this.deps.connectivity()
    if (cls === "unavailable") return {run: "refused", reason: "not_in_deployment", message: "That isn't available on this device."}
    if (cls === "device_local" || cls === "phone_local") return {run: "now"}
    if (net === "online") return {run: "now"}
    if (consequential || cls === "cloud_required") {
      return {
        run: "refused",
        reason: consequential ? "consequential_not_queued" : "needs_network",
        message: consequential ? "No connection. Nothing was sent; try again when you're back online." : "That needs a connection. Try again when you're back online.",
      }
    }
    return {run: "queue"}
  }

  /** Queue non-consequential work for later. Throws for anything consequential. */
  enqueue(item: {actionId: string; payload: unknown; consequential: boolean; scopeId?: string; purpose?: Purpose}): string {
    if (item.consequential) throw new Error("A consequential action is never queued for later execution")
    if (item.scopeId && this.deps.policy.isRevoked(item.scopeId)) throw new Error("Scope is revoked; not queued")
    const max = this.deps.maxQueue ?? 100
    if (this.queue.length >= max) this.queue.shift()
    const id = `q${++this.n}`
    this.queue.push({id, actionId: item.actionId, payload: item.payload, scopeId: item.scopeId, purpose: item.purpose, enqueuedAt: this.deps.now(), attempts: 0})
    return id
  }

  get pending(): readonly QueuedItem[] {
    return this.queue
  }

  /**
   * Send what is queued, once the network is back. Each item's scope is
   * checked again here: a revocation may have landed while it waited.
   */
  async flush(send: (item: QueuedItem) => Promise<void>): Promise<{sent: number; dropped: number; failed: number}> {
    if (this.deps.connectivity() === "offline") return {sent: 0, dropped: 0, failed: 0}
    let sent = 0
    let dropped = 0
    let failed = 0
    const keep: QueuedItem[] = []
    for (const item of this.queue) {
      if (item.scopeId && this.deps.policy.isRevoked(item.scopeId)) {
        dropped++
        continue
      }
      try {
        await send(item)
        sent++
      } catch {
        item.attempts++
        if (item.attempts >= (this.deps.maxAttempts ?? 5)) failed++
        else keep.push(item)
      }
    }
    this.queue = keep
    return {sent, dropped, failed}
  }

  // ---- cache -------------------------------------------------------------

  /** Cache context for offline use. Only with an expiry; revocation clears it. */
  cachePut(key: string, value: unknown, opts: {ttlMs: number; scopeId?: string}): void {
    if (!(opts.ttlMs > 0)) throw new Error("Cached context needs an expiry")
    if (opts.scopeId && this.deps.policy.isRevoked(opts.scopeId)) return
    this.cache.set(key, {value, scopeId: opts.scopeId, expiresAt: this.deps.now() + opts.ttlMs})
  }

  cacheGet(key: string): unknown | undefined {
    const e = this.cache.get(key)
    if (!e) return undefined
    if (e.expiresAt <= this.deps.now() || (e.scopeId && this.deps.policy.isRevoked(e.scopeId))) {
      this.cache.delete(key)
      return undefined
    }
    return e.value
  }

  private purge(scopeId: string): void {
    this.queue = this.queue.filter(i => i.scopeId !== scopeId)
    for (const [k, e] of this.cache) if (e.scopeId === scopeId) this.cache.delete(k)
  }
}

/**
 * Which configured model tiers can be reached now, and what the wearer
 * should be told is missing. The router is given only these; it still
 * applies its own consent rules per tier.
 */
export function availableTiers(tiers: ModelClient[], net: Connectivity): {tiers: ModelClient[]; degraded: string | null} {
  const reachable = (l: Locality) => l === "device" || (l === "site" && net !== "offline") || (l === "cloud" && net === "online")
  const up = tiers.filter(t => reachable(t.locality ?? "cloud"))
  if (up.length === tiers.length) return {tiers: up, degraded: null}
  if (up.length === 0) return {tiers: up, degraded: "No assistant model is reachable offline. Timers, notes and the clock still work."}
  return {tiers: up, degraded: net === "offline" ? "Offline: short answers only." : "Hosted model unreachable: answering on the site model."}
}

/** The capability matrix ANI-210 asks to be documented, as data the settings centre can show. */
export const CAPABILITY_MATRIX: {capability: string; publicCloud: boolean; onPrem: boolean; disconnected: boolean}[] = [
  {capability: "Ring controls, HUD navigation, mute, stop capture", publicCloud: true, onPrem: true, disconnected: true},
  {capability: "Timers, alarms, clock, notes", publicCloud: true, onPrem: true, disconnected: true},
  {capability: "Memory search (keywords; semantic when embeddings are local)", publicCloud: true, onPrem: true, disconnected: true},
  {capability: "Permission and consent checks", publicCloud: true, onPrem: true, disconnected: true},
  {capability: "Short answers (device/puck model)", publicCloud: true, onPrem: true, disconnected: true},
  {capability: "Detailed answers (heavy tier)", publicCloud: true, onPrem: true, disconnected: false},
  {capability: "Product questions (vision model)", publicCloud: true, onPrem: true, disconnected: false},
  {capability: "Sending messages, payments", publicCloud: true, onPrem: true, disconnected: false},
  {capability: "Turn-by-turn navigation", publicCloud: true, onPrem: false, disconnected: false},
]
