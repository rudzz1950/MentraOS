/**
 * @fileoverview Asking about the thing in front of you. ANI-236, with the session part of ANI-237.
 *
 * One capture, one or more questions about it ("what's the sugar?", "and the
 * ingredients?"), until the capture expires. Each question goes to the vision
 * model with the label text read by OCR (ANI-235); the answer comes back
 * through the closed contract in answer.ts or not at all.
 *
 * A photo is captured data. It leaves the phone only if its consent scope
 * reaches the model's locality — the same rule the text tiers follow
 * (egress.ts) — so a hosted model never sees a capture whose scope says
 * device-only, however useful it would have been.
 *
 * Nothing here writes memory. Remembering a product is a separate action the
 * wearer takes, through the memory store's own approval path.
 */

import {allows, DEVICE_ONLY, type ConsentPolicy} from "../agent/egress"
import {ANSWER_JSON_SCHEMA, buildPrompt, present, validateAnswer, type OcrLine, type Spoken} from "./answer"
import {VisionUnavailableError, type VisionImage, type VisionModel} from "./ports"

export interface Capture {
  image: VisionImage
  /** Consent scope of the capture (ANI-169). */
  scopeId: string
  ocr: OcrLine[]
  takenAt: number
}

export type QaResult =
  | (Spoken & {ok: true; via: string})
  | {ok: false; reason: "no_capture" | "expired" | "not_permitted" | "unavailable" | "invalid_answer"; text: string; detail?: string}

export class ProductQa {
  private capture: Capture | null = null
  private n = 0

  constructor(
    private readonly opts: {
      model: VisionModel
      consent?: ConsentPolicy
      now: () => number
      /** Follow-ups are answered against the same capture for this long. Two minutes by default. */
      captureTtlMs?: number
      /** Packaged products (the default), or any document, object or scene (ANI-168). */
      mode?: "product" | "scene"
    },
  ) {}

  /** A new capture replaces the old one: follow-ups refer to what is in front of the wearer now. */
  setCapture(c: Capture): void {
    this.capture = c
  }

  /** Forget the capture, e.g. when the wearer walks away or capture consent ends. */
  clear(): void {
    this.capture = null
  }

  /** The schema the model is asked to fit, for the provider's structured-output mode. */
  static readonly responseSchema = ANSWER_JSON_SCHEMA

  async ask(question: string, signal?: AbortSignal): Promise<QaResult> {
    const c = this.capture
    if (!c) return {ok: false, reason: "no_capture", text: "Look at the product and take a picture first."}
    if (this.opts.now() - c.takenAt > (this.opts.captureTtlMs ?? 120_000)) {
      this.capture = null
      return {ok: false, reason: "expired", text: "That picture has expired. Take a new one."}
    }

    const reach = (this.opts.consent ?? DEVICE_ONLY).reach(c.scopeId) ?? "device"
    if (!allows(reach, this.opts.model.locality)) {
      return {ok: false, reason: "not_permitted", text: "This picture can't be sent off your phone, so I can't answer about it here."}
    }

    let raw: unknown
    try {
      raw = await this.opts.model.ask(
        {requestId: `qa-${c.image.captureId}-${++this.n}`, image: c.image, prompt: buildPrompt(question, c.image.captureId, c.ocr, this.opts.mode)},
        signal,
      )
    } catch (err) {
      if (err instanceof VisionUnavailableError) {
        const text = err.kind === "quota" || err.kind === "rate_limited"
          ? "Too many questions just now. Try again in a minute."
          : "Can't reach the product assistant right now."
        return {ok: false, reason: "unavailable", text, detail: err.kind}
      }
      throw err
    }

    const v = validateAnswer(raw, {captureId: c.image.captureId, ocr: c.ocr})
    if (!v.ok) {
      // A malformed or ungrounded answer is not shown, not even in part. The
      // wearer is told what to do instead of being told a guess.
      return {ok: false, reason: "invalid_answer", text: "I couldn't read that reliably from the label. Try again closer, or check the package.", detail: v.reason}
    }
    return {ok: true, via: this.opts.model.name, ...present(v.answer)}
  }
}
