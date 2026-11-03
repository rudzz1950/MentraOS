/**
 * @fileoverview The vision-model port. Provider-neutral on purpose (ANI-234).
 *
 * Nothing Gemini-specific crosses this line: a request is an image, a
 * question, some untrusted evidence and the schema the answer must fit; a
 * response is the model's JSON, unvalidated. Gemini, a customer-managed
 * Vertex deployment or an on-device model all implement the same thing, and
 * the product code never learns which one answered.
 */

import type {Locality} from "../agent/egress"

export interface VisionImage {
  /** Opaque reference to the capture in the media store (ANI-166). */
  captureId: string
  mimeType: "image/jpeg" | "image/png" | "image/webp"
  bytes: Uint8Array
}

export interface VisionRequest {
  /** Echoed into telemetry, never content. */
  requestId: string
  image: VisionImage
  /** The full prompt: instructions, quoted evidence, then the question. */
  prompt: string
}

export interface VisionModel {
  readonly name: string
  /** Where it runs, for the same consent check text models get (egress.ts). */
  readonly locality: Locality
  /** The model's answer as parsed JSON, or a throw. Validation is the caller's job. */
  ask(req: VisionRequest, signal?: AbortSignal): Promise<unknown>
}

export class VisionUnavailableError extends Error {
  constructor(readonly kind: "timeout" | "rate_limited" | "unavailable" | "blocked" | "bad_response" | "quota", detail: string) {
    super(`Vision model ${kind}: ${detail}`)
    this.name = "VisionUnavailableError"
  }
}
