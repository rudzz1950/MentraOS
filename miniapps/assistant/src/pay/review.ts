/**
 * @fileoverview What the wearer is shown and told before a payment leaves the glasses. ANI-246.
 *
 * Three rules, each of which exists because the alternative is paying the
 * wrong person or the wrong amount:
 *
 *   1. Every field says where it came from. The name printed in a QR is the
 *      cheapest thing in the world to fake, so it is labelled "from the QR"
 *      until the PSP has resolved the VPA, and never presented as verified.
 *   2. Any change invalidates the confirmation. A different payee, a different
 *      amount, a re-scan of a different code or simply too much time passing
 *      and the wearer must confirm again. The confirmation is bound to a
 *      fingerprint of exactly what was shown.
 *   3. Nothing here authorises anything. Saying "continue" opens the trusted
 *      review in the PSP app; the debit is authorised there, with the UPI PIN
 *      or the issuer's own method, and never by voice. Every readback says
 *      the payment has NOT been made, so silence after it is not mistaken for
 *      success.
 */

import {formatInr, type UpiPaymentRequest} from "./upi"

export type FieldSource =
  /** Printed in the QR. Untrusted. */
  | "qr"
  /** Resolved by the PSP/bank from the VPA. */
  | "psp"
  /** Typed by the wearer in the trusted phone surface. */
  | "user"

export interface Sourced<T> {
  value: T
  source: FieldSource
}

/** What the PSP said when asked to resolve the VPA. */
export interface PayeeVerification {
  vpa: string
  /** The account holder's name as the PSP/bank reports it. */
  verifiedName: string
  /** When it was checked. A stale verification is not a verification. */
  at: number
}

export interface PaymentReview {
  vpa: Sourced<string>
  payee: Sourced<string> | null
  amountPaise: Sourced<number> | null
  merchant: boolean
  note?: string
  /** What the wearer must still do before handoff is possible. Empty means reviewable. */
  missing: ("amount" | "payee_verification")[]
  /** Binds a confirmation to exactly this content. */
  fingerprint: string
  createdAt: number
}

export interface ReviewOptions {
  /** A review older than this is stale and must be rebuilt. Two minutes by default. */
  maxAgeMs?: number
  /**
   * Whether the PSP must have resolved the payee before handoff. True by
   * default; the trusted PSP surface shows the verified name anyway, but
   * requiring it here means the glasses never read out an unverified name as
   * if it were the recipient.
   */
  requireVerification?: boolean
}

export function buildReview(
  req: UpiPaymentRequest,
  now: number,
  opts: {verification?: PayeeVerification; enteredAmountPaise?: number} = {},
): PaymentReview {
  const v = opts.verification
  // A verification for a different VPA is evidence about someone else.
  const verified = v && v.vpa.toLowerCase() === req.vpa ? v : undefined

  const payee: Sourced<string> | null = verified
    ? {value: verified.verifiedName, source: "psp"}
    : req.qrPayeeName
      ? {value: req.qrPayeeName, source: "qr"}
      : null

  let amount: Sourced<number> | null = null
  if (req.kind === "dynamic" && req.amountPaise !== undefined) {
    amount = {value: req.amountPaise, source: "qr"}
  } else if (opts.enteredAmountPaise !== undefined && Number.isInteger(opts.enteredAmountPaise) && opts.enteredAmountPaise > 0) {
    // A static QR's amount is typed by the wearer, not spoken: a misheard
    // "fifteen" for "fifty" is exactly the error a readback cannot catch.
    if (req.minAmountPaise === undefined || opts.enteredAmountPaise >= req.minAmountPaise) {
      amount = {value: opts.enteredAmountPaise, source: "user"}
    }
  }

  const missing: PaymentReview["missing"] = []
  if (!amount) missing.push("amount")
  if (!verified) missing.push("payee_verification")

  return {
    vpa: {value: req.vpa, source: "qr"},
    payee,
    amountPaise: amount,
    merchant: req.merchantCode !== undefined,
    note: req.note,
    missing,
    fingerprint: fingerprint(req.vpa, payee, amount, req.digest),
    createdAt: now,
  }
}

/** The payee as the wearer should hear it: verified, or plainly marked as not. */
export function payeeLabel(r: PaymentReview): string {
  if (!r.payee) return `${r.vpa.value}, name not verified`
  if (r.payee.source === "psp") return r.payee.value
  return `${r.payee.value} (name from the QR code, not verified)`
}

/**
 * The spoken readback. Payee and exact amount, and an explicit statement that
 * nothing has been paid. Rupees and paise are said in words-friendly form.
 */
export function readback(r: PaymentReview): string {
  const amount = r.amountPaise ? formatInr(r.amountPaise.value) : "an amount you will enter on your phone"
  return `Pay ${payeeLabel(r)}, ${amount}. Not paid yet. Say continue to review it on your phone.`
}

/** The HUD: two short lines, the key fields only. */
export function hudLines(r: PaymentReview): [string, string] {
  const who = r.payee ? (r.payee.source === "psp" ? r.payee.value : `${r.payee.value}?`) : r.vpa.value
  const amount = r.amountPaise ? formatInr(r.amountPaise.value) : "amount on phone"
  return [`Pay ${who}`, `${amount} - not paid`]
}

export type ConfirmResult =
  | {ok: true; action: "open_trusted_review"; fingerprint: string}
  | {ok: false; reason: "stale" | "changed" | "unverified"}

/**
 * The wearer said "continue" (or tapped) after hearing the readback.
 *
 * `heardFingerprint` is the fingerprint of the review that was READ OUT. If the
 * review has changed since — a new scan, a different amount, a different
 * resolved name — the confirmation was for something else and is refused.
 *
 * The only thing this can return is "open the trusted review". It cannot
 * authorise a debit; there is no code path here that does.
 */
export function confirmContinue(
  current: PaymentReview,
  heardFingerprint: string,
  now: number,
  opts: ReviewOptions = {},
): ConfirmResult {
  if (now - current.createdAt > (opts.maxAgeMs ?? 120_000)) return {ok: false, reason: "stale"}
  if (heardFingerprint !== current.fingerprint) return {ok: false, reason: "changed"}
  // A static QR can still be opened for the wearer to type the amount in the
  // PSP app; what it cannot be is confirmed as a specific amount here.
  if ((opts.requireVerification ?? true) && current.missing.includes("payee_verification")) {
    return {ok: false, reason: "unverified"}
  }
  return {ok: true, action: "open_trusted_review", fingerprint: current.fingerprint}
}

function fingerprint(vpa: string, payee: Sourced<string> | null, amount: Sourced<number> | null, qr: string): string {
  return [vpa, payee?.source ?? "-", payee?.value ?? "-", amount?.value ?? "-", qr].join("|")
}
