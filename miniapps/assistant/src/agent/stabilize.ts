/**
 * @fileoverview Between the recogniser and everything that reacts to it.
 *
 * ANI-87. A streaming recogniser revises itself: "send" becomes "send the",
 * then "set the", then "send the deck". Two things go wrong if its partials
 * are used raw:
 *
 *   - The HUD flickers through every reading of the sentence. On a two-line
 *     panel in the corner of someone's eye, that reads as a fault.
 *   - Barge-in in "transcript" mode fires on a partial that is about to be
 *     retracted — a cough heard as "uh" stops the answer, and then the word
 *     disappears.
 *
 * So partials pass through here first. A word is COMMITTED once two
 * consecutive partials agree on it, and on everything before it (the
 * LocalAgreement policy streaming ASR systems use). Committed text never
 * changes, so the HUD only ever grows and barge-in only ever acts on words
 * that will still be there.
 *
 * ENDPOINTING is a separate decision, and the two signals disagree. The
 * firmware VAD knows when sound stopped; the recogniser knows when a sentence
 * is finished. The recogniser's final is authoritative. When the VAD says
 * speech ended and no final follows within a grace period, the last partial
 * becomes the final — in full, including its unconfirmed tail, since nothing
 * more is coming to confirm it. Ending on the VAD alone, with no grace, is
 * what clips the last word: the recogniser is still decoding it when the VAD
 * has already gone quiet.
 *
 * No timers of its own: injected clock, explicit `tick()`, and `nextDeadline()`
 * so the caller schedules one timer, the same as the button gestures.
 */

import type {Clock, Transcript, TranscriptSource, Unsubscribe} from "./ports"

export interface StabilizerOptions {
  clock: Clock
  /**
   * How long after the VAD reports the end of speech to wait for the
   * recogniser's own final before using the last partial. Long enough for the
   * decoder to flush its last word; short enough that a turn does not hang
   * when the recogniser never sends a final at all.
   */
  finalGraceMs?: number
  /** Committed text grew. For the HUD and for barge-in. Never shrinks within an utterance. */
  onCommitted?: (text: string) => void
  /** The utterance is over. Exactly once per utterance. */
  onFinal?: (text: string, via: "recognizer" | "vad_timeout") => void
}

/** Words compared without case or trailing punctuation, so "Send," agrees with "send". */
function key(word: string): string {
  return word.toLowerCase().replace(/[\p{P}]+$/u, "")
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

export class TranscriptStabilizer {
  private readonly clock: Clock
  private readonly finalGraceMs: number
  private committed: string[] = []
  private previous: string[] = []
  private latest = ""
  private vadEndedAt: number | null = null
  private active = false

  constructor(private readonly opts: StabilizerOptions) {
    this.clock = opts.clock
    this.finalGraceMs = opts.finalGraceMs ?? 800
  }

  /** Subscribe to a recogniser. Returns the unsubscribe. */
  attach(source: TranscriptSource): Unsubscribe {
    return source.on(t => this.onTranscript(t))
  }

  onTranscript(t: Transcript): void {
    if (t.isFinal) this.final(t.text)
    else this.partial(t.text)
  }

  partial(text: string): void {
    const next = words(text)
    if (next.length === 0) return
    this.active = true
    this.latest = text.trim()
    // New audio arrived after the VAD said it stopped, so the VAD was early.
    // Do not end the utterance underneath the recogniser.
    this.vadEndedAt = null

    // Longest prefix the last two partials agree on, never shorter than what
    // is already committed: once shown, a word stays.
    let agree = 0
    while (agree < next.length && agree < this.previous.length && key(next[agree]) === key(this.previous[agree])) {
      agree++
    }
    this.previous = next
    if (agree > this.committed.length && this.prefixHolds(next)) {
      this.committed = next.slice(0, agree)
      this.opts.onCommitted?.(this.committed.join(" "))
    }
  }

  /** The recogniser's own end of sentence. Authoritative. */
  final(text: string): void {
    const t = text.trim()
    if (!this.active && t === "") return
    this.finish(t || this.latest, "recognizer")
  }

  /** The firmware VAD reported the end of speech. */
  vadEnd(): void {
    if (this.active) this.vadEndedAt = this.clock.now()
  }

  /** The firmware VAD reported speech again; any pending VAD endpoint is void. */
  vadStart(): void {
    this.vadEndedAt = null
  }

  /** Epoch ms when `tick()` next has something to do, or null. */
  nextDeadline(): number | null {
    return this.vadEndedAt === null ? null : this.vadEndedAt + this.finalGraceMs
  }

  tick(): void {
    const due = this.nextDeadline()
    if (due === null || this.clock.now() < due) return
    // The recogniser never closed the sentence. Use everything it heard.
    this.finish(this.latest, "vad_timeout")
  }

  /** Committed text of the utterance in progress. */
  get stableText(): string {
    return this.committed.join(" ")
  }

  /**
   * True when the committed words are still a prefix of this partial. A
   * recogniser can revise a word that two partials agreed on; when it does,
   * the committed text is left alone rather than retracted, and nothing more
   * is committed until the partials agree past it again.
   */
  private prefixHolds(next: string[]): boolean {
    return this.committed.every((w, i) => next[i] !== undefined && key(next[i]) === key(w))
  }

  private finish(text: string, via: "recognizer" | "vad_timeout") {
    const done = text.trim()
    this.reset()
    if (done) this.opts.onFinal?.(done, via)
  }

  private reset() {
    this.committed = []
    this.previous = []
    this.latest = ""
    this.vadEndedAt = null
    this.active = false
  }
}
