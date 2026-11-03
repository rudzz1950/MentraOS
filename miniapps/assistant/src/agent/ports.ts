/**
 * @fileoverview What the turn loop needs from the world, and nothing more.
 *
 * Each port is the slice of a Mentra Miniapp SDK module the loop actually uses,
 * so the real session satisfies them structurally and the tests can supply
 * fakes without a phone, a model or a pair of glasses.
 */

/** Mirrors the SDK's TranscriptionData. */
export interface Transcript {
  text: string
  isFinal: boolean
  language?: string
}

export type Unsubscribe = () => void

export interface TranscriptSource {
  on(handler: (t: Transcript) => void): Unsubscribe
}

/** Two lines is what the panel holds; the loop never assumes more. */
export interface Hud {
  show(lines: string[]): Promise<void>
  clear(): Promise<void>
}

export interface Voice {
  speak(sentences: string[]): Promise<void>
  /** Stop mid-sentence. Barge-in (ANI-64) calls this. */
  stop(): Promise<void>
}

/** One model, streaming. Routing across several lives in model.ts. */
export interface ModelClient {
  readonly name: string
  /**
   * Where this model runs: "device", "site" or "cloud". Decides which context
   * it may be shown (see egress.ts). Absent is read as "cloud", the farthest.
   */
  readonly locality?: "device" | "site" | "cloud"
  /** Yields the answer in pieces. Throws to signal failure or timeout. */
  complete(prompt: string, signal: AbortSignal): AsyncIterable<string>
}

/** A thing the assistant can do, as opposed to say. */
export interface Tool {
  name: string
  /**
   * True when running it changes something outside the conversation: sending a
   * message, creating an event, sharing data. These never run unconfirmed.
   */
  consequential: boolean
  run(args: string): Promise<string>
}

export interface Clock {
  now(): number
}
