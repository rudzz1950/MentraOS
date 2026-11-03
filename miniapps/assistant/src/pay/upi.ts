/**
 * @fileoverview Turning a scanned QR payload into a UPI payment request, or refusing to. ANI-245.
 *
 * The glasses are a capture surface, not a payment authority (ANI-233). What a
 * QR contains is UNTRUSTED: anybody can print one, stick it over a shop's real
 * code, or show it on a screen. This parser's job is narrow — decide whether
 * the payload is a well-formed `upi://pay` request and, if so, type it — and
 * it does nothing else. Parsing never opens an app, never contacts anyone and
 * never starts a payment.
 *
 * STRICT ON PURPOSE. Each refusal below is a real attack shape or a real way
 * for the wearer to pay the wrong amount:
 *
 *   - any scheme but upi, any action but pay (a QR can carry `intent://`,
 *     `https://`, or `upi://mandate` — a standing debit authority)
 *   - a parameter given twice (`am=10&am=10000`: which one does the PSP read?)
 *   - an amount that is not plain decimal rupees with at most two places
 *   - a currency other than INR
 *   - control, bidi-override and zero-width characters in display fields,
 *     which make "Sharma Stores" render over a different VPA
 *   - oversize payloads and fields
 *   - parameters this parser does not know, by default, because a field the
 *     review screen does not show is a field the wearer cannot check
 *
 * The raw payload is kept only for the handoff to the PSP app, inside an
 * object that refuses to print itself, so it cannot reach a log by accident.
 */

/** Largest payload considered. A QR's byte-mode capacity is ~2.9 KB; real UPI codes are a few hundred bytes. */
export const MAX_PAYLOAD_BYTES = 2048

/**
 * Field length limits. Conservative and configurable: they will be set to the
 * chosen PSP's documented limits once ANI-244 picks one.
 */
export const DEFAULT_LIMITS = {
  pa: 255,
  pn: 100,
  tn: 100,
  tr: 35,
  tid: 35,
  /** Digits of the rupee part of an amount. 9,99,99,999 is far beyond any UPI limit. */
  amountDigits: 8,
}

/**
 * Parameters from the UPI linking spec that are understood. `pa`..`cu` are
 * surfaced; the rest are carried to the PSP untouched and never shown or
 * acted on. In particular `url` is NEVER opened.
 */
const SURFACED = ["pa", "pn", "am", "mam", "cu", "tn", "tr", "tid", "mc"] as const
const CARRIED = ["url", "mode", "purpose", "orgid", "sign", "mid", "msid", "mtid", "qrmedium", "invoiceno", "invoicedate", "gstin", "gstbrkup", "category"] as const

export type UpiQrKind =
  /** No amount in the code: the wearer enters it in the trusted PSP surface. */
  | "static"
  /** The amount is encoded. It is still only a SUGGESTION until the PSP shows it. */
  | "dynamic"

export interface UpiPaymentRequest {
  kind: UpiQrKind
  /** Payee virtual payment address, lower-cased. */
  vpa: string
  /** The name printed in the QR. Untrusted until the PSP verifies the VPA. */
  qrPayeeName?: string
  /** Amount in paise, integer, so no float ever touches money. Absent on a static QR. */
  amountPaise?: number
  /** Minimum amount, in paise, when the code allows the payer to choose above it. */
  minAmountPaise?: number
  currency: "INR"
  note?: string
  /** Merchant's transaction reference. */
  reference?: string
  transactionId?: string
  /** Merchant category code, four digits. Present means a merchant QR. */
  merchantCode?: string
  /** Names of carried parameters present, for the audit view. Values are not exposed. */
  carried: string[]
  /** A stable digest of the payload, for idempotency and audit. Not reversible to the payload. */
  digest: string
}

export type UpiRejection =
  | "not_upi"
  | "not_pay"
  | "too_large"
  | "malformed"
  | "duplicate_param"
  | "unknown_param"
  | "missing_vpa"
  | "bad_vpa"
  | "bad_amount"
  | "conflicting_amount"
  | "bad_currency"
  | "unsafe_text"
  | "field_too_long"
  | "bad_merchant_code"

export type UpiParseResult =
  | {ok: true; request: UpiPaymentRequest; handoff: HandoffPayload}
  | {ok: false; reason: UpiRejection; detail: string}

/**
 * The raw payload, held for the PSP handoff and nothing else.
 *
 * Every way an object normally becomes text is overridden, so `console.log`,
 * string interpolation and JSON serialization all print "[redacted]". The
 * value is reachable only through `reveal()`, which the handoff calls once.
 */
export class HandoffPayload {
  #raw: string | null
  constructor(raw: string) {
    this.#raw = raw
  }
  /** The payload, once. Later calls return null: retained only as long as needed. */
  reveal(): string | null {
    const r = this.#raw
    this.#raw = null
    return r
  }
  get spent(): boolean {
    return this.#raw === null
  }
  toString() {
    return "[redacted UPI payload]"
  }
  toJSON() {
    return "[redacted UPI payload]"
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "[redacted UPI payload]"
  }
}

export interface ParseOptions {
  limits?: Partial<typeof DEFAULT_LIMITS>
  /**
   * What to do with a parameter this parser does not know. "reject" by
   * default: once ANI-244 picks a PSP, its documented extras get added to the
   * carried list rather than this being relaxed.
   */
  unknownParams?: "reject" | "carry"
}

const VPA = /^[a-z0-9][a-z0-9._-]{0,253}@[a-z][a-z0-9.-]{1,63}$/
const AMOUNT = (digits: number) => new RegExp(`^(\\d{1,${digits}})(?:\\.(\\d{1,2}))?$`)
/**
 * Control characters, bidi overrides and isolates, zero-width characters, the
 * BOM and the replacement character. Each lets a display string look like
 * something other than what it is.
 */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿�]/

function reject(reason: UpiRejection, detail: string): UpiParseResult {
  return {ok: false, reason, detail}
}

export function parseUpiQr(payload: string, opts: ParseOptions = {}): UpiParseResult {
  const limits = {...DEFAULT_LIMITS, ...opts.limits}
  if (new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES) {
    return reject("too_large", `payload over ${MAX_PAYLOAD_BYTES} bytes`)
  }
  const text = payload.trim()

  // Scheme and action, case-insensitive (some printers upper-case the whole code).
  const head = /^([a-z][a-z0-9+.-]*):\/\/([^?#/]*)\/?(\?[^#]*)?$/i.exec(text)
  if (!head) return reject(/^upi:/i.test(text) ? "malformed" : "not_upi", "not a upi:// link")
  if (head[1].toLowerCase() !== "upi") return reject("not_upi", `scheme ${head[1]}`)
  if (head[2].toLowerCase() !== "pay") return reject("not_pay", `upi action ${head[2] || "(none)"}`)
  const query = (head[3] ?? "").slice(1)
  if (!query) return reject("missing_vpa", "no parameters")

  const params = new Map<string, string>()
  for (const part of query.split("&")) {
    if (part === "") continue
    const eq = part.indexOf("=")
    if (eq <= 0) return reject("malformed", "parameter without a name or value")
    const name = part.slice(0, eq).toLowerCase()
    let value: string
    try {
      value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "))
    } catch {
      return reject("malformed", `bad percent-encoding in ${name}`)
    }
    // Compared after lower-casing, so `am` and `AM` are the same parameter.
    if (params.has(name)) return reject("duplicate_param", name)
    params.set(name, value)
  }

  const known = new Set<string>([...SURFACED, ...CARRIED])
  const carried: string[] = []
  for (const name of params.keys()) {
    if ((SURFACED as readonly string[]).includes(name)) continue
    if (known.has(name) || opts.unknownParams === "carry") carried.push(name)
    else return reject("unknown_param", name)
  }

  const vpa = params.get("pa")?.trim().toLowerCase()
  if (!vpa) return reject("missing_vpa", "pa absent")
  if (vpa.length > limits.pa || !VPA.test(vpa)) return reject("bad_vpa", "pa is not a payment address")

  for (const field of ["pn", "tn", "tr", "tid"] as const) {
    const v = params.get(field)
    if (v === undefined) continue
    if (UNSAFE_TEXT.test(v)) return reject("unsafe_text", field)
    if ([...v].length > limits[field]) return reject("field_too_long", field)
  }

  const cu = params.get("cu")
  if (cu !== undefined && cu.toUpperCase() !== "INR") return reject("bad_currency", cu)

  const amount = parseAmount(params.get("am"), limits.amountDigits)
  if (amount === "bad") return reject("bad_amount", "am")
  const minAmount = parseAmount(params.get("mam"), limits.amountDigits)
  if (minAmount === "bad") return reject("bad_amount", "mam")
  if (amount !== undefined && minAmount !== undefined && minAmount > amount) {
    return reject("conflicting_amount", "minimum above the amount")
  }

  const mc = params.get("mc")
  if (mc !== undefined && !/^\d{4}$/.test(mc)) return reject("bad_merchant_code", "mc")

  const clean = (s: string | undefined) => (s === undefined ? undefined : s.trim() || undefined)
  const request: UpiPaymentRequest = {
    kind: amount === undefined ? "static" : "dynamic",
    vpa,
    qrPayeeName: clean(params.get("pn")),
    amountPaise: amount,
    minAmountPaise: minAmount,
    currency: "INR",
    note: clean(params.get("tn")),
    reference: clean(params.get("tr")),
    transactionId: clean(params.get("tid")),
    merchantCode: mc,
    carried: carried.sort(),
    digest: digest(text),
  }
  return {ok: true, request, handoff: new HandoffPayload(text)}
}

/** Paise, undefined when absent, "bad" when present and not a positive plain decimal. */
function parseAmount(v: string | undefined, digits: number): number | undefined | "bad" {
  if (v === undefined) return undefined
  const m = AMOUNT(digits).exec(v.trim())
  if (!m) return "bad"
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"))
  return paise > 0 ? paise : "bad"
}

/** FNV-1a 64-bit as hex. An idempotency key, not a security boundary. */
function digest(s: string): string {
  let h = 0xcbf29ce484222325n
  for (const b of new TextEncoder().encode(s)) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, "0")
}

/** "₹1,23,456.50": Indian digit grouping, always two decimals. */
export function formatInr(paise: number): string {
  const rupees = Math.floor(paise / 100)
  const p = (paise % 100).toString().padStart(2, "0")
  const s = rupees.toString()
  const last3 = s.slice(-3)
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")
  return `₹${rest ? rest + "," : ""}${last3}.${p}`
}
