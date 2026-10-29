/**
 * @fileoverview Stopping the assistant when the wearer speaks over it.
 *
 * The constraint is 300 ms from the first syllable to silence, which rules out
 * waiting for speech recognition: an ASR partial takes several hundred
 * milliseconds on its own. So barge-in triggers on the VAD onset the firmware
 * already sends (vad.c, ~2 frames of attack = 20 ms plus BLE latency), and the
 * transcript is only a fallback for the case below.
 *
 * The case below: there is no acoustic echo cancellation anywhere in this
 * system. The glasses have no speaker (the capability profile says so), so
 * speech comes out of the phone or paired earbuds. On earbuds the mic never
 * hears it and VAD onset is safe. On a phone speaker the mic hears every word
 * the assistant says, VAD fires continuously, and VAD-triggered barge-in would
 * cut the assistant off mid-sentence, every sentence. That is why the trigger
 * is a configured mode rather than a default: "vad" where the audio path is
 * private, "transcript" where it is not. Choosing wrong is not a subtle bug,
 * it is an assistant that cannot finish a sentence.
 *
 * A minimum voiced duration guards against a cough, a door, or a single noisy
 * frame ending an answer. It is spent from the 300 ms budget deliberately.
 */

import {RollingWindow} from "../util/window"
import type {Clock} from "./ports"

export type BargeInTrigger =
  /** Voice activity onset. Fast, needs a private audio path or AEC. */
  | "vad"
  /** A non-trivial recognition partial. Slower, survives an open speaker. */
  | "transcript"
  /** Never interrupt. For a demo, or a platform with neither signal. */
  | "off"

export interface BargeInOptions {
  clock: Clock
  trigger?: BargeInTrigger
  /** Continuous voice needed before this counts as the wearer speaking. */
  minVoicedMs?: number
  /** Characters of recognised speech needed in "transcript" mode. */
  minChars?: number
  /** Called to stop playback and cancel generation. */
  onInterrupt: () => void
}

export interface BargeInState {
  speaking: boolean
  /** When playback started, for measuring the stop latency. */
  startedAt: number | null
}

/**
 * Tracks whether the assistant is talking and decides when to cut it off.
 *
 * Deliberately has no timers of its own: it is driven by the events it is
 * given, so a test can assert the 300 ms budget against a fake clock instead
 * of sleeping.
 */
export class BargeIn {
  private readonly clock: Clock
  private readonly trigger: BargeInTrigger
  private readonly minVoicedMs: number
  private readonly minChars: number
  private readonly onInterrupt: () => void

  private speaking = false
  private startedAt: number | null = null
  /** When the current run of voice began, or null between runs. */
  private voicedSince: number | null = null
  private interruptedAt: number | null = null

  constructor(opts: BargeInOptions) {
    this.clock = opts.clock
    this.trigger = opts.trigger ?? "transcript"
    this.minVoicedMs = opts.minVoicedMs ?? 120
    this.minChars = opts.minChars ?? 3
    this.onInterrupt = opts.onInterrupt
  }

  get state(): BargeInState {
    return {speaking: this.speaking, startedAt: this.startedAt}
  }

  /** Playback has begun. */
  beganSpeaking(): void {
    this.speaking = true
    this.startedAt = this.clock.now()
    this.voicedSince = null
    this.interruptedAt = null
  }

  /** Playback finished on its own. */
  finishedSpeaking(): void {
    this.speaking = false
    this.startedAt = null
    this.voicedSince = null
  }

  /**
   * A VAD transition from the glasses. `voiced` is the new state.
   *
   * Returns true when this ended the assistant's turn.
   */
  onVoice(voiced: boolean): boolean {
    if (!voiced) {
      this.voicedSince = null
      return false
    }
    if (this.voicedSince === null) this.voicedSince = this.clock.now()
    if (this.trigger !== "vad" || !this.speaking) return false
    if (this.clock.now() - this.voicedSince < this.minVoicedMs) return false
    return this.interrupt()
  }

  /**
   * A recognition partial. Used as the trigger in "transcript" mode and
   * ignored otherwise, so the two paths cannot both fire for one utterance.
   */
  onTranscript(text: string): boolean {
    if (this.trigger !== "transcript" || !this.speaking) return false
    if (text.trim().length < this.minChars) return false
    return this.interrupt()
  }

  /** The wearer tapped. Always stops, in every mode, including "off". */
  onTap(): boolean {
    if (!this.speaking) return false
    return this.interrupt()
  }

  /**
   * Milliseconds between playback starting and the interrupt landing, or null
   * if nothing was interrupted. The 300 ms requirement is measured from the
   * voice onset, which `voicedSince` holds; this is the figure to log.
   */
  lastLatencyMs(): number | null {
    if (this.interruptedAt === null || this.voicedSince === null) return null
    return this.interruptedAt - this.voicedSince
  }

  private interrupt(): boolean {
    this.interruptedAt = this.clock.now()
    this.speaking = false
    this.startedAt = null
    this.onInterrupt()
    return true
  }
}

/** What the outbound limiter wants before an action goes ahead. */
export type OutboundVerdict =
  /** Within the limit: the normal single confirmation is enough. */
  | {allow: true; reconfirm: false}
  /** Over the limit: ask again, explicitly, before it goes. */
  | {allow: true; reconfirm: true; sentInWindow: number; msUntilFree: number}

/**
 * The outbound limit: at most five messages in ten minutes before the
 * assistant stops acting on one confirmation alone.
 *
 * Deliberately NOT the same thing as the inbound interruption budget in
 * hud/notify.ts, and never to be merged with it. That one protects the
 * wearer's attention and drops what it refuses. This one protects everybody
 * else's inbox and refuses nothing outright — it escalates to a second
 * confirmation, because the wearer may well have five things to send, and a
 * hard block on a legitimate sixth message is its own failure.
 *
 * What it bounds is the runaway case: a misheard transcript, a tool that
 * retries, a loop that keeps confirming itself. Five in ten minutes is a
 * person; fifty is a bug, and the second confirmation is where a person
 * notices.
 */
export class OutboundLimit {
  private readonly window: RollingWindow

  constructor(clock: Clock, limit = 5, windowMs = 10 * 60 * 1000) {
    this.window = new RollingWindow(clock, limit, windowMs)
  }

  /** Does not spend anything; call `record` when the action actually happens. */
  check(): OutboundVerdict {
    if (!this.window.exhausted()) return {allow: true, reconfirm: false}
    return {
      allow: true,
      reconfirm: true,
      sentInWindow: this.window.limit,
      msUntilFree: this.window.msUntilFree(),
    }
  }

  /**
   * Record an action that went ahead. Recorded even when it needed a second
   * confirmation, so the window keeps growing and the eighth message asks
   * again rather than the limit quietly ceasing to apply.
   */
  record(): void {
    if (!this.window.tryTake()) this.window.forceTake()
  }

  remaining(): number {
    return this.window.remaining()
  }
}
