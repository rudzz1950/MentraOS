/**
 * @fileoverview Whether this person, on this device, right now, may hand a payment to the PSP. ANI-250.
 *
 * The threat is not exotic: a stranger wearing borrowed or lost glasses, a TV
 * in the background saying "pay", a recording of the owner's voice, or text in
 * a QR note written to look like an instruction. None of those can pass here,
 * because the only things this gate accepts as a deliberate confirmation are
 * actions in the TRUSTED PHONE UI — never a transcript, a model's output, a
 * voice, the glasses camera or a ring gesture.
 *
 * And even passing this gate authorises nothing. It permits the HANDOFF; the
 * debit itself is authenticated inside the PSP or issuer surface, with the UPI
 * PIN or the issuer's own method. No PIN ever passes through this code, the
 * glasses, a model or our UI, and this module has nowhere to put one.
 *
 * Decisions are allow, step_up (send the wearer to the PSP's stronger
 * authentication, and do not proceed on our side until it is done) or block.
 * Every decision carries its reasons and an audit record with nothing
 * sensitive in it.
 */

/** How the "go ahead" arrived. Only "phone_ui" is a deliberate confirmation. */
export type ConfirmationSource = "phone_ui" | "voice" | "transcript" | "model" | "ring_gesture" | "glasses_tap"

export interface PaymentContext {
  now: number
  /** The phone is paired to this account (ANI-198), not merely nearby. */
  phoneAccountBound: boolean
  /** The glasses doing the scan are enrolled and not revoked. */
  glassesEnrolled: boolean
  glassesRevoked: boolean
  /** The owner has an authenticated session on the phone. */
  ownerSessionAuthenticated: boolean
  /** Last owner interaction with the phone, epoch ms. */
  ownerLastActiveAt: number
  phoneUnlocked: boolean
  /** Rooted, jailbroken or otherwise failing the platform's integrity check. */
  phoneCompromised: boolean
  /** Payment permission withdrawn in settings. */
  paymentPermissionRevoked: boolean
  /** How the confirmation for THIS review arrived, if it has. */
  confirmation?: {source: ConfirmationSource; reviewFingerprint: string; at: number}
  /** Fingerprint of the review currently on screen. */
  reviewFingerprint: string
  /** First payment to this VPA from this account. */
  newPayee: boolean
  /** The glasses were enrolled recently, or this is their first payment. */
  newDevice: boolean
  /** Failed handoffs or authentications in the recent window. */
  recentFailures: number
}

export interface GateOptions {
  /** Idle time after which the owner session no longer counts. Two minutes by default. */
  idleTimeoutMs?: number
  /** A confirmation older than this is not fresh. Sixty seconds by default. */
  confirmationMaxAgeMs?: number
  /** Failures at or above this block. Three by default. */
  maxFailures?: number
}

export type GateReason =
  | "phone_not_account_bound"
  | "glasses_not_enrolled"
  | "glasses_revoked"
  | "no_owner_session"
  | "owner_idle"
  | "phone_locked"
  | "phone_compromised"
  | "permission_revoked"
  | "too_many_failures"
  | "no_confirmation"
  | "confirmation_not_trusted"
  | "confirmation_for_other_review"
  | "confirmation_stale"
  | "new_payee"
  | "new_device"

export interface GateDecision {
  decision: "allow" | "step_up" | "block"
  reasons: GateReason[]
  /** Safe to log: no VPA, amount, name, payload or credential. */
  audit: {at: number; decision: string; reasons: GateReason[]}
}

const BLOCKING: ReadonlySet<GateReason> = new Set<GateReason>([
  "phone_not_account_bound",
  "glasses_not_enrolled",
  "glasses_revoked",
  "no_owner_session",
  "owner_idle",
  "phone_locked",
  "phone_compromised",
  "permission_revoked",
  "too_many_failures",
  "no_confirmation",
  "confirmation_not_trusted",
  "confirmation_for_other_review",
  "confirmation_stale",
])

export function evaluatePaymentGate(ctx: PaymentContext, opts: GateOptions = {}): GateDecision {
  const idle = opts.idleTimeoutMs ?? 120_000
  const fresh = opts.confirmationMaxAgeMs ?? 60_000
  const maxFailures = opts.maxFailures ?? 3
  const reasons: GateReason[] = []

  if (!ctx.phoneAccountBound) reasons.push("phone_not_account_bound")
  if (!ctx.glassesEnrolled) reasons.push("glasses_not_enrolled")
  if (ctx.glassesRevoked) reasons.push("glasses_revoked")
  if (!ctx.ownerSessionAuthenticated) reasons.push("no_owner_session")
  else if (ctx.now - ctx.ownerLastActiveAt > idle) reasons.push("owner_idle")
  if (!ctx.phoneUnlocked) reasons.push("phone_locked")
  if (ctx.phoneCompromised) reasons.push("phone_compromised")
  if (ctx.paymentPermissionRevoked) reasons.push("permission_revoked")
  if (ctx.recentFailures >= maxFailures) reasons.push("too_many_failures")

  const c = ctx.confirmation
  if (!c) reasons.push("no_confirmation")
  else if (c.source !== "phone_ui") reasons.push("confirmation_not_trusted")
  else if (c.reviewFingerprint !== ctx.reviewFingerprint) reasons.push("confirmation_for_other_review")
  else if (ctx.now - c.at > fresh || c.at > ctx.now) reasons.push("confirmation_stale")

  if (ctx.newPayee) reasons.push("new_payee")
  if (ctx.newDevice) reasons.push("new_device")

  const decision: GateDecision["decision"] = reasons.some(r => BLOCKING.has(r))
    ? "block"
    : reasons.length
      ? "step_up"
      : "allow"
  return {decision, reasons, audit: {at: ctx.now, decision, reasons: [...reasons]}}
}

/** What to tell the wearer, without revealing which check an attacker should work around. */
export function gateMessage(d: GateDecision): string {
  if (d.decision === "allow") return "Opening your payment app. Not paid yet."
  if (d.decision === "step_up") return "Your payment app will ask you to confirm it's you. Not paid yet."
  if (d.reasons.includes("phone_locked")) return "Unlock your phone to continue. Nothing was paid."
  return "Can't continue this payment from the glasses. Nothing was paid."
}
