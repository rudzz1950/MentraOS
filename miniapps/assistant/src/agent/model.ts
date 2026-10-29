/**
 * @fileoverview Model routing and the rules path.
 *
 * Three tiers, cheapest first. Most of what a wearable assistant is asked is
 * the time, a timer, or a one-line fact, and none of that should wait on a
 * network round trip. What reaches a model reaches the smallest one that can
 * answer it.
 */

import type {Clock, ModelClient} from "./ports"

export interface RouteResult {
  text: string
  /** Which path answered: useful in tests and in the "why" view. */
  via: "rules" | string
}

/** Answers that need no model at all. Returns null when it cannot help. */
export function rulesAnswer(text: string, clock: Clock): string | null {
  const t = text.trim().toLowerCase()
  if (/\b(what('s| is)? the )?time\b/.test(t) && !t.includes("time to")) {
    const d = new Date(clock.now())
    const hh = d.getHours() % 12 || 12
    const mm = d.getMinutes().toString().padStart(2, "0")
    return `${hh}:${mm} ${d.getHours() < 12 ? "am" : "pm"}`
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
   */
  async complete(prompt: string, onChunk?: (s: string) => void): Promise<RouteResult> {
    const failures: string[] = []

    for (const tier of this.tiers) {
      const ctrl = new AbortController()
      const timer = this.setTimer(() => ctrl.abort(), this.timeoutMs)
      let out = ""
      try {
        for await (const chunk of tier.complete(prompt, ctrl.signal)) {
          out += chunk
          onChunk?.(chunk)
        }
        clearTimeout(timer)
        return {text: out, via: tier.name}
      } catch (err) {
        clearTimeout(timer)
        failures.push(`${tier.name}: ${err instanceof Error ? err.message : String(err)}`)
        // Fall through. A partial answer from a failed tier is discarded rather
        // than shown: half an answer read as whole is worse than none.
      }
    }
    throw new ModelsUnavailableError(failures)
  }
}

export class ModelsUnavailableError extends Error {
  constructor(readonly failures: string[]) {
    super(`No model answered. Tried: ${failures.join("; ")}`)
    this.name = "ModelsUnavailableError"
  }
}
