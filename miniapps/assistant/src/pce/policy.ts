/**
 * @fileoverview Every action, data read, model route and write, authorised in one place. ANI-206.
 *
 * Decisions: allow, deny, require_confirmation, redact, degrade or defer —
 * each with a reason and the policy version that produced it, and each
 * leaving an audit record with no personal content in it.
 *
 * THE RULES THAT DO NOT BEND:
 *
 *   Fail closed. If evaluating a rule throws, the answer is deny. A policy
 *   engine that allows on error is a bypass with extra steps.
 *
 *   Revocation is terminal and wins. Once a scope is revoked, a grant for it
 *   that arrives later — delayed in a queue, replayed, or issued before the
 *   revocation and delivered after — changes nothing. The ledger orders by
 *   meaning, not by arrival.
 *
 *   Consent events are verified. A grant that fails signature verification is
 *   ignored, so a forged "the user agreed" event on the bus grants nothing.
 *   A replayed event id is ignored too.
 *
 *   A confirmation is for one payload. It is bound to the action and a hash of
 *   its exact arguments, it is single-use, and it expires. "Yes" to sending
 *   one message is not "yes" to the edited version.
 *
 *   Speaker identity is denied outright, whatever any grant says, until ANI-91
 *   and ANI-251 are decided. There is no grant shape that can enable it.
 *
 * The engine implements the ConsentPolicy port the model router already uses
 * (agent/egress.ts), so the routing rules from ANI-25 read from this ledger
 * instead of a second source of truth.
 *
 * Nothing here is a claim of legal compliance. It enforces what it is told;
 * whether what it is told satisfies DPDP or anything else is reviewed
 * separately.
 */

import {allows, type ConsentPolicy, type Locality} from "../agent/egress"

export const POLICY_VERSION = "pce-policy-1"

export type DataCategory =
  | "transcript"
  | "audio"
  | "image"
  | "sensor"
  | "wellness"
  | "location"
  | "memory"
  | "contacts"
  | "calendar"
  | "message"
  /** Anything that identifies a person by their voice. Always denied; see above. */
  | "voice_identity"

export type Purpose = "assistant_answer" | "vision_qa" | "memory_write" | "embedding" | "analytics" | "navigation" | "sharing"

export interface ConsentGrant {
  kind: "grant"
  eventId: string
  scopeId: string
  purposes: Purpose[]
  categories: DataCategory[]
  /** Farthest the scope's data may travel. */
  maxReach: Locality
  issuedAt: number
  expiresAt: number
  signature: string
}

export interface ConsentRevocation {
  kind: "revoke"
  eventId: string
  scopeId: string
  issuedAt: number
  signature: string
}

export type ConsentEvent = ConsentGrant | ConsentRevocation

export type Decision = "allow" | "deny" | "require_confirmation" | "redact" | "degrade" | "defer"

export interface PolicyDecision {
  decision: Decision
  reason: string
  policyVersion: string
}

export interface AuditEvent {
  at: number
  subject: "data" | "action" | "consent"
  decision: Decision | "accepted" | "ignored"
  reason: string
  policyVersion: string
  /** Opaque references only: an action id, a scope id, a category. Never content. */
  ref?: string
}

export interface DeviceContext {
  driving: boolean
  inMeeting: boolean
  doNotDisturb: boolean
  /** Minutes since local midnight. */
  localMinutes: number
  /** Quiet hours as [start, end) in minutes since midnight; may wrap past midnight. */
  quietHours?: [number, number]
}

export type ActionRisk = "observe" | "state_change" | "consequential"

export interface ActionRequest {
  actionId: string
  risk: ActionRisk
  /** Hash of the exact arguments, from the action registry. */
  payloadHash: string
  /** "interrupt" outputs (a card, a sound) respect quiet hours and driving; "silent" ones do not. */
  output: "interrupt" | "silent"
  /** Safety-critical outputs (stop capture, navigation "turn now") are never deferred. */
  urgent?: boolean
  /** Data the action reads or sends, for the egress check. */
  data?: {scopeId?: string; category: DataCategory; purpose: Purpose; destination: Locality}[]
  confirmationToken?: string
  /** Whether the target device is trusted (ANI-198). */
  deviceTrusted: boolean
}

export interface PolicyOptions {
  now: () => number
  /** Verifies a consent event came from the trusted consent UI. */
  verify: (e: ConsentEvent) => boolean
  /** How long a confirmation stays valid. Sixty seconds by default. */
  confirmationTtlMs?: number
}

interface Scope {
  grants: ConsentGrant[]
  revokedAt?: number
}

export class PolicyEngine implements ConsentPolicy {
  private scopes = new Map<string, Scope>()
  private seen = new Set<string>()
  private confirmations = new Map<string, {actionId: string; payloadHash: string; expiresAt: number}>()
  private readonly log: AuditEvent[] = []
  private n = 0

  constructor(private readonly opts: PolicyOptions) {}

  // ---- the consent ledger ------------------------------------------------

  /** Apply a consent event. Returns whether it changed anything. */
  apply(e: ConsentEvent): boolean {
    const now = this.opts.now()
    const ignore = (reason: string) => {
      this.audit({at: now, subject: "consent", decision: "ignored", reason, ref: e.scopeId})
      return false
    }
    let valid = false
    try {
      valid = this.opts.verify(e)
    } catch {
      valid = false
    }
    if (!valid) return ignore("signature_invalid")
    if (this.seen.has(e.eventId)) return ignore("replayed")
    this.seen.add(e.eventId)

    const s = this.scopes.get(e.scopeId) ?? {grants: []}
    this.scopes.set(e.scopeId, s)
    if (e.kind === "revoke") {
      if (s.revokedAt === undefined) s.revokedAt = e.issuedAt
      s.grants = []
      this.audit({at: now, subject: "consent", decision: "accepted", reason: "revoked", ref: e.scopeId})
      return true
    }
    // Terminal: nothing re-opens a revoked scope. A new consent is a new scope.
    if (s.revokedAt !== undefined) return ignore("scope_revoked")
    if (e.expiresAt <= e.issuedAt) return ignore("grant_malformed")
    if (e.categories.includes("voice_identity")) return ignore("voice_identity_not_grantable")
    s.grants.push(e)
    this.audit({at: now, subject: "consent", decision: "accepted", reason: "granted", ref: e.scopeId})
    return true
  }

  isRevoked(scopeId: string): boolean {
    return this.scopes.get(scopeId)?.revokedAt !== undefined
  }

  // ---- data ----------------------------------------------------------------

  /**
   * May this data, for this purpose, go to this destination?
   *
   * Data without a scope is the wearer's own (self-reported) and is allowed,
   * as it always has been, except for the categories nobody may grant.
   */
  authorizeData(req: {scopeId?: string; category: DataCategory; purpose: Purpose; destination: Locality}): PolicyDecision {
    return this.guard("data", req.scopeId ?? req.category, () => {
      if (req.category === "voice_identity") return this.d("deny", "voice_identity_forbidden")
      if (!req.scopeId) return this.d("allow", "self_reported")
      const s = this.scopes.get(req.scopeId)
      if (!s) return this.d("deny", "scope_unknown")
      if (s.revokedAt !== undefined) return this.d("deny", "scope_revoked")
      const now = this.opts.now()
      const live = s.grants.filter(g => g.expiresAt > now)
      if (!live.length) return this.d("deny", "scope_expired")
      const fit = live.filter(g => g.purposes.includes(req.purpose) && g.categories.includes(req.category))
      if (!fit.length) return this.d("deny", "purpose_or_category_not_granted")
      if (!fit.some(g => allows(g.maxReach, req.destination))) {
        // The data could be used closer to home. Callers that can strip it and
        // carry on (the per-tier prompt builder) treat this as "leave it out".
        return this.d("redact", "destination_beyond_consent")
      }
      return this.d("allow", "granted")
    })
  }

  /** The ConsentPolicy port, for the purpose the turn loop uses. */
  reach(scopeId: string): Locality | null {
    return this.reachFor(scopeId, "assistant_answer")
  }

  /** A ConsentPolicy for one purpose: vision Q&A, navigation, and so on. */
  forPurpose(purpose: Purpose): ConsentPolicy {
    return {reach: scopeId => this.reachFor(scopeId, purpose)}
  }

  private reachFor(scopeId: string, purpose: Purpose): Locality | null {
    try {
      const s = this.scopes.get(scopeId)
      if (!s || s.revokedAt !== undefined) return null
      const now = this.opts.now()
      const live = s.grants.filter(g => g.expiresAt > now && g.purposes.includes(purpose))
      if (!live.length) return null
      return live.some(g => g.maxReach === "cloud") ? "cloud" : live.some(g => g.maxReach === "site") ? "site" : "device"
    } catch {
      return null
    }
  }

  // ---- actions -------------------------------------------------------------

  authorizeAction(req: ActionRequest, ctx: DeviceContext): PolicyDecision {
    return this.guard("action", req.actionId, () => {
      if (!req.deviceTrusted) return this.d("deny", "device_not_trusted")

      for (const item of req.data ?? []) {
        const dd = this.authorizeData(item)
        if (dd.decision !== "allow") return this.d("deny", `data_${dd.reason}`)
      }

      if (req.risk === "consequential") {
        if (!req.confirmationToken) return this.d("require_confirmation", "consequential_needs_confirmation")
        const c = this.confirmations.get(req.confirmationToken)
        if (!c) return this.d("require_confirmation", "confirmation_unknown_or_used")
        this.confirmations.delete(req.confirmationToken)
        if (c.expiresAt <= this.opts.now()) return this.d("require_confirmation", "confirmation_expired")
        if (c.actionId !== req.actionId || c.payloadHash !== req.payloadHash) {
          return this.d("require_confirmation", "confirmation_for_other_payload")
        }
      }

      if (req.output === "interrupt" && !req.urgent) {
        if (ctx.driving) return this.d("degrade", "driving")
        if (ctx.doNotDisturb) return this.d("defer", "do_not_disturb")
        if (ctx.inMeeting) return this.d("defer", "in_meeting")
        if (ctx.quietHours && inWindow(ctx.localMinutes, ctx.quietHours)) return this.d("defer", "quiet_hours")
      }
      return this.d("allow", "ok")
    })
  }

  /**
   * The wearer said yes to exactly this. Returns a single-use token bound to
   * the action and the hash of its arguments.
   */
  confirm(actionId: string, payloadHash: string): string {
    const token = `cf-${this.opts.now().toString(36)}-${(++this.n).toString(36)}`
    this.confirmations.set(token, {actionId, payloadHash, expiresAt: this.opts.now() + (this.opts.confirmationTtlMs ?? 60_000)})
    return token
  }

  audits(): readonly AuditEvent[] {
    return this.log
  }

  // ---- internals -----------------------------------------------------------

  private d(decision: Decision, reason: string): PolicyDecision {
    return {decision, reason, policyVersion: POLICY_VERSION}
  }

  private guard(subject: "data" | "action", ref: string, rule: () => PolicyDecision): PolicyDecision {
    let out: PolicyDecision
    try {
      out = rule()
    } catch {
      out = this.d("deny", "evaluation_error")
    }
    if (out.decision !== "allow") this.audit({at: this.opts.now(), subject, decision: out.decision, reason: out.reason, ref})
    return out
  }

  private audit(e: Omit<AuditEvent, "policyVersion">) {
    this.log.push({...e, policyVersion: POLICY_VERSION})
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500)
  }
}

function inWindow(m: number, [start, end]: [number, number]): boolean {
  return start <= end ? m >= start && m < end : m >= start || m < end
}
