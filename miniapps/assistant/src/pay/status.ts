/**
 * @fileoverview What actually happened to a payment, and what the glasses may say about it. ANI-247.
 *
 * The rule: the glasses say "paid" only when the PSP or bank has said so,
 * through its callback or status API. Coming back from the payment app is a
 * HANDOFF signal, not proof — an app can return "SUCCESS" for a debit that is
 * still pending at the bank, and a deep link can be forged by anything else
 * on the phone. Announcing success early is the one mistake a payment surface
 * cannot take back: the wearer walks away from a merchant who was never paid.
 *
 * So the states are distinct and the announcements are honest:
 *   pending and unknown say "pending" or "not confirmed", never a guess;
 *   declined, failed and reversed are each named;
 *   a contradictory report (success, then failure without a reversal) does not
 *   pick a side — it becomes unknown and tells the wearer to check the app.
 *
 * Idempotency: one transaction per QR per session, however many times it is
 * scanned or the phone reconnects; duplicate callbacks are ignored by event id;
 * and the ledger serialises, so an app relaunch resumes rather than starting a
 * second transaction.
 */

import {formatInr} from "./upi"

export type PaymentState =
  | "created"
  | "handed_off"
  | "awaiting_authorization"
  | "pending"
  | "success"
  | "declined"
  | "failed"
  | "reversed"
  | "unknown"

const FINAL: ReadonlySet<PaymentState> = new Set<PaymentState>(["declined", "failed", "reversed"])

/** An authoritative report from the PSP or bank. */
export interface PspStatusReport {
  /** Unique per report, for dropping duplicates. */
  eventId: string
  status: "awaiting_authorization" | "pending" | "success" | "declined" | "failed" | "reversed"
  /** The PSP/bank transaction reference. */
  reference: string
  at: number
  /** Where it came from. A client return code is not one of these on purpose. */
  source: "psp_callback" | "psp_status_api"
  /** Amount and payee as the PSP confirms them, when it says. */
  confirmedAmountPaise?: number
  confirmedPayee?: string
}

export interface PaymentRecord {
  key: string
  state: PaymentState
  createdAt: number
  handedOffAt?: number
  /** What the payment app said on return. Shown as "your app says…", never as the outcome. */
  clientResult?: string
  reference?: string
  confirmedAmountPaise?: number
  confirmedPayee?: string
  settledAt?: number
  seenEvents: string[]
  /** Reports that did not fit: a different reference, a contradiction. For support, never spoken. */
  anomalies: string[]
}

export class PaymentLedger {
  private records = new Map<string, PaymentRecord>()

  constructor(
    private readonly opts: {
      /** No authoritative status within this long after handoff means unknown. Three minutes by default. */
      timeoutMs?: number
    } = {},
  ) {}

  /** The idempotency key for a scan: the QR's digest within one owner session. */
  static key(qrDigest: string, sessionId: string): string {
    return `${sessionId}:${qrDigest}`
  }

  /**
   * Start a transaction, or return the one this key already has.
   *
   * A repeated scan of the same code returns the existing record and
   * `duplicate: true`, so the caller can say "already in progress" or
   * "already paid" instead of handing off a second debit.
   */
  begin(key: string, now: number): {record: PaymentRecord; duplicate: boolean} {
    const existing = this.records.get(key)
    if (existing && !FINAL.has(existing.state)) return {record: existing, duplicate: true}
    if (existing && existing.state === "success") return {record: existing, duplicate: true}
    // Declined, failed or reversed: a fresh attempt is legitimate.
    const record: PaymentRecord = {key, state: "created", createdAt: now, seenEvents: [], anomalies: []}
    this.records.set(key, record)
    return {record, duplicate: false}
  }

  get(key: string): PaymentRecord | undefined {
    return this.records.get(key)
  }

  /** The PSP app was opened with the payload. */
  handedOff(key: string, now: number): PaymentRecord {
    const r = this.must(key)
    if (r.state === "created") {
      r.state = "handed_off"
      r.handedOffAt = now
    }
    return r
  }

  /**
   * The payment app came back. Its result is recorded and NEVER makes the
   * payment successful: at most it moves a handed-off payment to pending,
   * waiting on the PSP.
   */
  appReturned(key: string, clientResult: string): PaymentRecord {
    const r = this.must(key)
    r.clientResult = clientResult.slice(0, 64)
    if (r.state === "handed_off" || r.state === "awaiting_authorization") r.state = "pending"
    return r
  }

  /** An authoritative report. Duplicates are ignored; contradictions become unknown. */
  report(key: string, rep: PspStatusReport): PaymentRecord {
    const r = this.must(key)
    if (r.seenEvents.includes(rep.eventId)) return r
    r.seenEvents.push(rep.eventId)

    if (r.reference && rep.reference !== r.reference) {
      r.anomalies.push(`report for reference ${rep.reference}, expected ${r.reference}`)
      return r
    }
    if (r.state === "created") {
      r.anomalies.push("status before handoff")
      return r
    }
    if (FINAL.has(r.state)) {
      if (rep.status !== r.state) r.anomalies.push(`${rep.status} after final ${r.state}`)
      return r
    }
    if (r.state === "success") {
      if (rep.status === "reversed") {
        r.state = "reversed"
        r.settledAt = rep.at
      } else if (rep.status !== "success") {
        // Success then failure, with no reversal, is a contradiction. Picking
        // either side could be wrong; say it is unclear.
        r.anomalies.push(`${rep.status} after success`)
        r.state = "unknown"
      }
      return r
    }

    r.reference = rep.reference
    if (rep.confirmedAmountPaise !== undefined) r.confirmedAmountPaise = rep.confirmedAmountPaise
    if (rep.confirmedPayee !== undefined) r.confirmedPayee = rep.confirmedPayee
    if (rep.status === "reversed") {
      r.anomalies.push("reversal of a payment never confirmed")
      r.state = "unknown"
      return r
    }
    r.state = rep.status
    if (rep.status === "success" || FINAL.has(rep.status)) r.settledAt = rep.at
    return r
  }

  /** Move payments with no authoritative word to unknown. Call from the maintenance tick. */
  expire(now: number): PaymentRecord[] {
    const timeout = this.opts.timeoutMs ?? 180_000
    const out: PaymentRecord[] = []
    for (const r of this.records.values()) {
      const waiting = r.state === "handed_off" || r.state === "awaiting_authorization" || r.state === "pending"
      if (waiting && r.handedOffAt !== undefined && now - r.handedOffAt > timeout) {
        r.state = "unknown"
        out.push(r)
      }
    }
    return out
  }

  /** For persisting across an app relaunch. Contains no payload and no credential. */
  toJSON(): {version: 1; records: PaymentRecord[]} {
    return {version: 1, records: [...this.records.values()].map(r => ({...r, seenEvents: [...r.seenEvents], anomalies: [...r.anomalies]}))}
  }

  static fromJSON(dump: {version: 1; records: PaymentRecord[]}, opts?: {timeoutMs?: number}): PaymentLedger {
    if (dump.version !== 1) throw new Error(`Unknown ledger version ${String(dump.version)}`)
    const l = new PaymentLedger(opts)
    for (const r of dump.records) l.records.set(r.key, {...r, seenEvents: [...r.seenEvents], anomalies: [...r.anomalies]})
    return l
  }

  private must(key: string): PaymentRecord {
    const r = this.records.get(key)
    if (!r) throw new Error("No payment for this key; call begin() first")
    return r
  }
}

/**
 * What the glasses say. "Paid" appears in exactly one branch, and only for a
 * state that only an authoritative PSP report can produce.
 */
export function announcement(r: PaymentRecord): string {
  const amount = r.confirmedAmountPaise !== undefined ? ` ${formatInr(r.confirmedAmountPaise)}` : ""
  const to = r.confirmedPayee ? ` to ${r.confirmedPayee}` : ""
  const ref = r.reference ? ` Reference ending ${r.reference.slice(-4)}.` : ""
  switch (r.state) {
    case "success":
      return `Paid${amount}${to}.${ref}`
    case "pending":
    case "awaiting_authorization":
    case "handed_off":
      return r.clientResult
        ? `Payment status pending. Your app reported "${r.clientResult}", waiting for the bank to confirm.`
        : "Payment status pending."
    case "declined":
      return `Payment declined.${ref} Check your payment app.`
    case "failed":
      // Not "nothing was paid": a UPI failure can follow a debit that the
      // bank then reverses, and this surface cannot tell which.
      return `Payment failed.${ref} Check your payment app before paying again.`
    case "reversed":
      return `Payment reversed${amount}.${ref}`
    case "unknown":
      return "Payment not confirmed. Check your payment app before paying again."
    case "created":
      return "Payment not started."
  }
}
