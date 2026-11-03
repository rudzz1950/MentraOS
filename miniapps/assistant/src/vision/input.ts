/**
 * @fileoverview A captured frame, into the existing assistant. ANI-168.
 *
 * Not a second agent. A capture arrives as an authenticated media reference
 * (the transfer completed and verified for this session, ANI-167, and the
 * media stored under its scope, ANI-169). This resolves the reference, gates
 * it, prepares it (ANI-235) and hands it to the existing ProductQa — whose
 * model comes from the existing provider configuration and whose answers go
 * through the closed, grounded contract — and to the conversation layer that
 * speaks and shows the answer (ANI-237).
 *
 * Every failure has an honest sentence: an expired or unknown reference, an
 * empty or oversized capture, a photo too poor to read, a model that is
 * unavailable. None of them is a guess.
 */

import type {GrayImage, OcrEngine, OcrLine} from "./prepare"
import {prepare} from "./prepare"
import type {MediaStore} from "./media"
import {MAX_MEDIA_BYTES} from "./media"
import type {ProductQa} from "./product"

export interface CaptureRef {
  ref: string
  /** The session the transfer was authenticated on. */
  sessionId: string
  mimeType: "image/jpeg" | "image/png" | "image/webp"
  exif?: number
  width: number
  height: number
}

export type InputResult =
  | {ok: true; captureId: string; lines: number}
  | {ok: false; reason: "wrong_session" | "unknown" | "expired" | "empty" | "too_large" | "quality"; text: string}

export class VisionInput {
  constructor(
    private readonly deps: {
      media: MediaStore
      qa: ProductQa
      ocr: OcrEngine
      /** Luma plane for quality checks, decoded on the phone. */
      decodeGray: (bytes: Uint8Array, mime: CaptureRef["mimeType"]) => Promise<GrayImage>
      /** A quick first OCR pass, to plan crops. */
      firstPass: (ref: string) => Promise<OcrLine[]>
      sessionId: () => string
      now: () => number
    },
  ) {}

  /** A new capture becomes the active one for questions. */
  async accept(c: CaptureRef): Promise<InputResult> {
    if (c.sessionId !== this.deps.sessionId()) return {ok: false, reason: "wrong_session", text: "That picture didn't come from your glasses. Take a new one."}
    const meta = this.deps.media.meta(c.ref)
    if (!meta) return {ok: false, reason: "unknown", text: "I don't have that picture any more. Take a new one."}
    const bytes = await this.deps.media.get(c.ref)
    if (!bytes) return {ok: false, reason: "expired", text: "That picture has expired. Take a new one."}
    if (bytes.length === 0) return {ok: false, reason: "empty", text: "The picture came through empty. Try again."}
    if (bytes.length > MAX_MEDIA_BYTES) return {ok: false, reason: "too_large", text: "That picture is too large to use. Try again."}

    const prepared = await prepare({
      captureRef: c.ref,
      originalRef: c.ref,
      scopeId: meta.scopeId,
      expiresAt: meta.expiresAt,
      now: this.deps.now(),
      image: await this.deps.decodeGray(bytes, c.mimeType),
      exif: c.exif,
      firstPass: await this.deps.firstPass(c.ref),
      ocr: this.deps.ocr,
    })
    if (!prepared.ok) return {ok: false, reason: prepared.reason === "expired" ? "expired" : "quality", text: prepared.advice}

    // OCR text is a governed derivative of the capture, under its scope.
    this.deps.media.ocr.put(c.ref, prepared.capture.lines.map(l => l.text).join("\n"), meta)
    this.deps.qa.setCapture({
      image: {captureId: c.ref, mimeType: c.mimeType, bytes},
      scopeId: meta.scopeId,
      ocr: prepared.capture.lines.map(l => ({text: l.text, region: l.region})),
      takenAt: this.deps.now(),
    })
    return {ok: true, captureId: c.ref, lines: prepared.capture.lines.length}
  }
}
