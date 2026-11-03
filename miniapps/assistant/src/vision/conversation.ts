/**
 * @fileoverview Product questions as one voice conversation. ANI-237.
 *
 * Capture, then ask, then ask again about the same thing — "what's the
 * sugar?", "and the ingredients?" — without saying "look at this" each time.
 * This sits between the voice input (PerceptionHub's final transcripts) and
 * ProductQa, and adds what a conversation needs:
 *
 *   - Follow-ups against the active capture until it expires or a new one
 *     replaces it; ProductQa owns that expiry, so there is one rule.
 *   - "Stop", "repeat" and "mute" handled here, before anything reaches a
 *     model; stop also cancels a question in flight.
 *   - Output to the glasses speaker, falling back to the phone speaker when the
 *     glasses audio is unavailable or fails mid-answer, and saying so once.
 *   - A HUD card of at most two short lines, which always says where the
 *     answer came from: the label, or not the label.
 *
 * It keeps only the last answer, for "repeat". There is no conversation store
 * here; the session and memory are where state lives (ANI-199, ANI-203).
 */

import type {Hud, Voice} from "../agent/ports"
import type {ProductQa, QaResult} from "./product"

export type Turn =
  | {kind: "answered"; result: QaResult; output: "glasses" | "phone" | "muted"}
  | {kind: "stopped"}
  | {kind: "repeated"; output: "glasses" | "phone" | "muted"}
  | {kind: "muted" | "unmuted"}
  | {kind: "ignored"}

const STOP = /^(stop|cancel|never mind|be quiet|shut up)$/i
const REPEAT = /^(repeat( that)?|say (that|it) again|what\??)$/i
const MUTE = /^(mute|quiet)$/i
const UNMUTE = /^(unmute|speak again)$/i

export class ProductConversation {
  private last: {text: string; hud: [string, string]} | null = null
  private inflight: AbortController | null = null
  private muted = false
  private toldFallback = false

  constructor(
    private readonly deps: {
      qa: ProductQa
      hud: Hud
      glassesVoice: Voice
      phoneVoice: Voice
      /** Whether the glasses speaker is usable right now (DeviceRegistry: "speaker" supported). */
      glassesAudio: () => boolean
    },
  ) {}

  /** One final transcript, already addressed to the assistant. */
  async onUtterance(text: string): Promise<Turn> {
    const t = text.trim().replace(/[.!]+$/, "")
    if (!t) return {kind: "ignored"}
    if (STOP.test(t)) {
      this.inflight?.abort()
      this.inflight = null
      await Promise.allSettled([this.deps.glassesVoice.stop(), this.deps.phoneVoice.stop()])
      return {kind: "stopped"}
    }
    if (MUTE.test(t)) {
      this.muted = true
      await Promise.allSettled([this.deps.glassesVoice.stop(), this.deps.phoneVoice.stop()])
      return {kind: "muted"}
    }
    if (UNMUTE.test(t)) {
      this.muted = false
      return {kind: "unmuted"}
    }
    if (REPEAT.test(t)) {
      if (!this.last) return {kind: "ignored"}
      await this.deps.hud.show(this.last.hud)
      return {kind: "repeated", output: await this.say(this.last.text)}
    }

    this.inflight?.abort()
    const ctrl = new AbortController()
    this.inflight = ctrl
    let result: QaResult
    try {
      result = await this.deps.qa.ask(t, ctrl.signal)
    } catch (e) {
      if (ctrl.signal.aborted) return {kind: "stopped"}
      throw e
    } finally {
      if (this.inflight === ctrl) this.inflight = null
    }
    // Spoken over while the model was thinking: do not answer the old question.
    if (ctrl.signal.aborted) return {kind: "stopped"}

    const hud: [string, string] = result.ok ? result.hud : [short(result.text), ""]
    this.last = {text: result.text, hud}
    await this.deps.hud.show(hud)
    return {kind: "answered", result, output: await this.say(result.text)}
  }

  /** Speak on the glasses; on failure or absence, the phone, and say so once. */
  private async say(text: string): Promise<"glasses" | "phone" | "muted"> {
    if (this.muted) return "muted"
    if (this.deps.glassesAudio()) {
      try {
        await this.deps.glassesVoice.speak([text])
        this.toldFallback = false
        return "glasses"
      } catch {
        // Fall through to the phone: disconnected mid-answer, or the codec failed.
      }
    }
    const lead = this.toldFallback ? [] : ["Glasses audio isn't available, using the phone."]
    this.toldFallback = true
    await this.deps.phoneVoice.speak([...lead, text])
    return "phone"
  }
}

function short(s: string): string {
  return s.length > 22 ? s.slice(0, 21) + "…" : s
}
