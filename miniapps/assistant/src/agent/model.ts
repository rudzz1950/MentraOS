/**
 * @fileoverview Model routing and the rules path.
 *
 * Three tiers, cheapest first. Most of what a wearable assistant is asked is
 * the time, a timer, or a one-line fact, and none of that should wait on a
 * network round trip. What reaches a model reaches the smallest one that can
 * answer it.
 */

import type {Clock, ModelClient} from "./ports"
import {formatClock} from "./timers"

export interface RouteResult {
  text: string
  /** Which path answered: useful in tests and in the "why" view. */
  via: "rules" | string
}

/**
 * A prompt built for the tier about to receive it. Consent decides what each
 * tier may be shown (egress.ts), so one string for every tier would be either
 * a leak or the most restrictive tier's context everywhere.
 */
export type PromptFor = (tier: ModelClient) => string

/** Answers that need no model at all. Returns null when it cannot help. */
export function rulesAnswer(text: string, clock: Clock): string | null {
  const t = text.trim().toLowerCase()
  if (/\b(what('s| is)? the )?time\b/.test(t) && !t.includes("time to")) {
    return formatClock(clock.now())
  }
  return null
}

export class ModelRouter {
  /**
   * @param tiers smallest first. The router tries the first, and falls to the
   *   next only on failure — not on a poor answer, which it cannot judge.
   * @param timeoutMs per tier. A wearable that pauses for eight seconds has
   *   already failed, whatever it eventually says.
   */
  constructor(
    private readonly tiers: ModelClient[],
    private readonly timeoutMs = 4000,
    private readonly setTimer: typeof setTimeout = setTimeout,
  ) {
    if (tiers.length === 0) throw new Error("ModelRouter needs at least one model")
  }

  /**
   * Streams the answer, falling through the tiers on failure. `onChunk` fires
   * as text arrives so the display and the voice can start before the whole
   * answer exists.
   *
   * `signal` is the caller's own cancellation — barge-in. It is NOT a failure,
   * so it must not fall through to the next tier: the router used to retry on
   * any throw, which meant a user speaking over the assistant cancelled tier
   * one and immediately started tier two. Cancellation ends the turn.
   */
  async complete(
    prompt: string | PromptFor,
    opts: {onChunk?: (s: string) => void; signal?: AbortSignal} = {},
  ): Promise<RouteResult> {
    const {onChunk, signal} = opts
    const failures: string[] = []

    if (signal?.aborted) throw new CancelledError()

    for (const tier of this.tiers) {
      const ctrl = new AbortController()
      const timer = this.setTimer(() => ctrl.abort(), this.timeoutMs)
      const relay = () => ctrl.abort()
      signal?.addEventListener("abort", relay, {once: true})
      let out = ""
      try {
        const input = typeof prompt === "string" ? prompt : prompt(tier)
        for await (const chunk of tier.complete(input, ctrl.signal)) {
          // Checked between chunks as well as on abort: a generator that
          // ignores its signal would otherwise keep streaming into a HUD the
          // user has already spoken over.
          if (signal?.aborted) throw new CancelledError()
          out += chunk
          onChunk?.(chunk)
        }
        // Checked again after the stream ends: a cancellation that lands on
        // the last chunk would otherwise return a complete answer, which then
        // gets spoken over the person who just interrupted.
        if (signal?.aborted) throw new CancelledError()
        return {text: out, via: tier.name}
      } catch (err) {
        if (signal?.aborted) throw new CancelledError()
        failures.push(`${tier.name}: ${err instanceof Error ? err.message : String(err)}`)
        // Fall through. A partial answer from a failed tier is discarded rather
        // than shown: half an answer read as whole is worse than none.
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", relay)
      }
    }
    throw new ModelsUnavailableError(failures)
  }
}

/** The caller cancelled. Distinct from failure: nothing is retried. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled")
    this.name = "CancelledError"
  }
}

export class ModelsUnavailableError extends Error {
  constructor(readonly failures: string[]) {
    super(`No model answered. Tried: ${failures.join("; ")}`)
    this.name = "ModelsUnavailableError"
  }
}
