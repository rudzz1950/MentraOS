/**
 * @fileoverview Which notifications are allowed to interrupt a face.
 *
 * The phone already has every notification. So the only question here is
 * whether one earns the wearer's eye, and the default answer is no. A HUD that
 * mirrors a phone's notification shade is the single fastest way to make
 * glasses unwearable.
 *
 * Three decisions worth stating:
 *
 * 1. Over-budget notifications are DROPPED, never queued. A notification is
 *    perishable: shown twenty minutes late it is noise with no context, and a
 *    backlog that fires when the budget frees up is worse than silence. The
 *    phone still has it, so nothing is lost by not showing it.
 *
 * 2. The allow-list is the mechanism, not a mute-list. A sender or app has to
 *    be named to interrupt. Filtering by Android's own priority field alone
 *    would let every app that sets `high` through, which is most of them.
 *
 * 3. Reposts never re-interrupt. Android reposts a notification on every
 *    update — progress bars, ongoing media, a message thread gaining a line —
 *    and each repost arrives as a fresh event with the same key.
 *
 * Platform limits are respected rather than fought. Android reads notifications
 * through NotificationListenerService under a user-granted special access, and
 * a reply can only go back through the notification's own reply action; there
 * is no general message-sending API, and direct SMS needs to be the default SMS
 * app. iOS exposes notifications to accessories over ANCS read-only, and
 * interactive forwarding to third-party wearables is EU-only from iOS 26.5,
 * which excludes India. So `canReply` is a property of the notification the
 * platform handed us, never an assumption.
 */

import type {Clock} from "../agent/ports"
import {RollingWindow} from "../util/window"

/** Mirrors the SDK's PhoneNotificationData. */
export interface PhoneNotification {
  notificationId: string
  /** Human app name, e.g. "Messages". */
  app: string
  title: string
  content: string
  /** Android priority string: min, low, default, high, max. Empty on iOS. */
  priority: string
  timestamp: number
  /** Reverse-DNS package or bundle id. */
  packageName: string
  /** Android NotificationKey — more stable than notificationId across reposts. */
  notificationKey?: string
  /** True only when the platform gave us a reply action to invoke. */
  canReply?: boolean
  /** Ongoing notifications (media, navigation, downloads) never interrupt. */
  ongoing?: boolean
}

export type NotifyDecision =
  /** Show it. */
  | {show: true; reason: "priority_app" | "priority_sender"}
  /** Do not show it, and do not keep it: see note 1 above. */
  | {
      show: false
      reason: "dnd" | "not_priority" | "low_priority" | "ongoing" | "repost" | "over_budget"
    }

export interface NotifyPolicyOptions {
  clock: Clock
  /** Package ids allowed to interrupt. Matched exactly. */
  priorityApps?: string[]
  /**
   * Sender names allowed to interrupt, matched case-insensitively against the
   * notification title, which is where every platform puts the sender.
   */
  prioritySenders?: string[]
  /** Interruptions allowed per rolling hour. */
  hourlyBudget?: number
  /** Silences everything, including priority senders. The wearer's switch. */
  doNotDisturb?: boolean
  /** How long a repost of the same notification stays suppressed. */
  repostWindowMs?: number
}

const HOUR_MS = 60 * 60 * 1000

/** Android priorities that never interrupt, whatever the allow-list says. */
const NEVER_INTERRUPT = new Set(["min", "low"])

export class NotifyPolicy {
  private readonly clock: Clock
  private priorityApps: Set<string>
  private prioritySenders: string[]
  private repostWindowMs: number
  private dnd: boolean
  /** Interruptions shown, over the rolling hour. */
  private readonly budget: RollingWindow
  /** Key -> when it was last shown, for repost suppression. */
  private lastSeen = new Map<string, number>()

  constructor(opts: NotifyPolicyOptions) {
    this.clock = opts.clock
    this.priorityApps = new Set(opts.priorityApps ?? [])
    this.prioritySenders = (opts.prioritySenders ?? []).map(s => s.toLowerCase())
    this.budget = new RollingWindow(this.clock, opts.hourlyBudget ?? 6, HOUR_MS)
    this.repostWindowMs = opts.repostWindowMs ?? 5 * 60 * 1000
    this.dnd = opts.doNotDisturb ?? false
  }

  get doNotDisturb(): boolean {
    return this.dnd
  }

  setDoNotDisturb(on: boolean): void {
    this.dnd = on
  }

  /** Interruptions still available this hour. */
  remainingBudget(): number {
    return this.budget.remaining()
  }

  /**
   * Decide, and record the decision. Calling this twice for one notification
   * would spend two interruptions, so the caller calls it once.
   */
  decide(n: PhoneNotification): NotifyDecision {
    // Do-not-disturb is checked first and overrides the allow-list: it is the
    // wearer's own switch, and a priority sender punching through it would make
    // the switch a lie.
    if (this.dnd) return {show: false, reason: "dnd"}

    if (n.ongoing) return {show: false, reason: "ongoing"}
    if (NEVER_INTERRUPT.has(n.priority.toLowerCase())) return {show: false, reason: "low_priority"}

    const match = this.priorityMatch(n)
    if (!match) return {show: false, reason: "not_priority"}

    const key = this.keyOf(n)
    const now = this.clock.now()
    const seen = this.lastSeen.get(key)
    if (seen !== undefined && now - seen < this.repostWindowMs) {
      return {show: false, reason: "repost"}
    }

    this.pruneSeen()
    if (!this.budget.tryTake()) {
      return {show: false, reason: "over_budget"}
    }

    this.lastSeen.set(key, now)
    return {show: true, reason: match}
  }

  private priorityMatch(n: PhoneNotification): "priority_app" | "priority_sender" | null {
    if (this.priorityApps.has(n.packageName)) return "priority_app"
    const title = n.title.toLowerCase()
    // Substring rather than equality: a title is often "Amma (3 messages)".
    if (this.prioritySenders.some(s => s.length > 0 && title.includes(s))) return "priority_sender"
    return null
  }

  /**
   * Android's NotificationKey is stable across reposts where notificationId is
   * not, so it is preferred. Falling back to the id alone would let a reposted
   * notification through, so the app is folded in to keep ids from colliding
   * across apps.
   */
  private keyOf(n: PhoneNotification): string {
    return n.notificationKey ?? `${n.packageName}:${n.notificationId}`
  }

  private pruneSeen(): void {
    const cutoff = this.clock.now() - HOUR_MS
    for (const [key, at] of this.lastSeen) {
      if (at <= cutoff) this.lastSeen.delete(key)
    }
  }
}

/** The sender as the HUD should name them: the title, trimmed of its counter. */
export function senderOf(n: PhoneNotification): string {
  return n.title.replace(/\s*\(\d+[^)]*\)\s*$/, "").trim() || n.app
}
