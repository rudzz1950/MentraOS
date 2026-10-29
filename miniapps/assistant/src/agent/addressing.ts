/**
 * @fileoverview When the assistant is being spoken to.
 *
 * `classify(text, addressed)` has always taken an `addressed` flag, and until
 * now nothing produced one. The router's whole protection against acting on
 * overheard speech rested on a parameter no caller could set, which means the
 * voice entry point did not exist.
 *
 * This is the state machine that produces it. Two ways in:
 *
 *   wake()  the keyword spotter fired ("Hey Mentra"). The model itself runs on
 *           audio and needs the microphone; this is the window it opens.
 *   tap()   the button. Always trusted — a deliberate press is unambiguous in a
 *           way that a keyword match never is.
 *
 * THE FOLLOW-UP WINDOW IS THE INTERESTING PART. Requiring the wake word before
 * every single utterance makes a conversation unbearable: "Hey Mentra, what's
 * the weather" / "Hey Mentra, what about tomorrow". So after the assistant
 * finishes speaking, a shorter window opens in which the next utterance is
 * treated as addressed without the wake word.
 *
 * That window is a liability, because a microphone on someone's face hears the
 * room. Someone else speaking during it would be taken as a follow-up. Three
 * things bound the exposure:
 *
 *   1. It is SHORT — much shorter than the window a wake word opens, because
 *      the wearer who just got an answer either replies quickly or has moved
 *      on.
 *   2. It is CONSUMED by one utterance, not rolling. One follow-up per answer.
 *      A rolling window would stay open through a whole conversation across
 *      the table.
 *   3. It never opens while the assistant is still speaking, so its own speech
 *      coming back through an open phone speaker cannot hold it open (see
 *      bargein.ts on why there is no echo cancellation here).
 *
 * Consecutive false wakes are also bounded. A keyword spotter in a noisy room
 * fires on things that are not the keyword, and each false fire holds a
 * recognition window open. After a few in a row with nothing said, the wake
 * word is ignored for a cool-off, because a spotter misfiring every few
 * seconds drains the battery and streams a stranger's conversation.
 */

import type {Clock} from "./ports"

export type AddressReason = "wake" | "tap" | "follow_up" | "not_addressed"

export interface AddressingOptions {
  clock: Clock
  /** How long a wake word or tap keeps the floor open, waiting for speech. */
  windowMs?: number
  /** The follow-up window after an answer. Deliberately shorter. */
  followUpMs?: number
  /** False wakes in a row before the wake word is ignored for a while. */
  falseWakeLimit?: number
  /** How long the wake word stays ignored after that. */
  coolOffMs?: number
}

const DEFAULTS = {
  windowMs: 8000,
  followUpMs: 5000,
  falseWakeLimit: 3,
  coolOffMs: 30_000,
}

export class Addressing {
  private readonly clock: Clock
  private readonly o: typeof DEFAULTS

  /** When the current window closes, or null when the floor is shut. */
  private openUntil: number | null = null
  private openedBy: "wake" | "tap" | "follow_up" | null = null
  /** True while the assistant is speaking; the follow-up window waits. */
  private speaking = false
  private consecutiveFalseWakes = 0
  private coolOffUntil = 0

  constructor(opts: AddressingOptions) {
    this.clock = opts.clock
    this.o = {
      windowMs: opts.windowMs ?? DEFAULTS.windowMs,
      followUpMs: opts.followUpMs ?? DEFAULTS.followUpMs,
      falseWakeLimit: opts.falseWakeLimit ?? DEFAULTS.falseWakeLimit,
      coolOffMs: opts.coolOffMs ?? DEFAULTS.coolOffMs,
    }
  }

  /**
   * The keyword spotter fired. Ignored during a cool-off.
   * Returns whether the floor actually opened.
   */
  wake(): boolean {
    const now = this.clock.now()
    if (now < this.coolOffUntil) return false
    // A wake during an open window is the same window, not a new one; the
    // wearer saying the keyword twice should not reset their own clock.
    if (this.isOpen()) return true
    this.openUntil = now + this.o.windowMs
    this.openedBy = "wake"
    return true
  }

  /**
   * The button. Always opens the floor, even mid cool-off — a deliberate press
   * is not a misfire, and refusing it would leave the wearer with no way in.
   */
  tap(): boolean {
    this.coolOffUntil = 0
    this.consecutiveFalseWakes = 0
    this.openUntil = this.clock.now() + this.o.windowMs
    this.openedBy = "tap"
    return true
  }

  /** The assistant started talking. */
  beganSpeaking(): void {
    this.speaking = true
  }

  /**
   * The assistant finished talking, so the follow-up window opens. Called
   * after playback, not when the answer was generated — otherwise the window
   * would be spent while the wearer was still listening to the reply.
   */
  finishedSpeaking(): void {
    this.speaking = false
    this.openUntil = this.clock.now() + this.o.followUpMs
    this.openedBy = "follow_up"
  }

  /** The turn ended without the assistant saying anything. */
  endTurn(): void {
    this.openUntil = null
    this.openedBy = null
  }

  /**
   * Is this utterance addressed to us, and why.
   *
   * CONSUMES the window: calling this with speech closes the floor, so one
   * utterance gets one answer. A window that survived the utterance it was
   * opened for would keep listening to the room.
   */
  consider(text: string): AddressReason {
    if (!this.isOpen()) {
      // Nothing said within the window that was opened for it.
      this.noteSilenceIfExpired()
      return "not_addressed"
    }
    if (text.trim().length === 0) return "not_addressed"

    const reason = this.openedBy!
    // Real speech inside a window means the wake was not a false one.
    this.consecutiveFalseWakes = 0
    this.openUntil = null
    this.openedBy = null
    return reason
  }

  /** The boolean the router wants. */
  isAddressed(text: string): boolean {
    return this.consider(text) !== "not_addressed"
  }

  /** True while the floor is open and not yet consumed. */
  isOpen(): boolean {
    if (this.openUntil === null) return false
    if (this.openedBy === "follow_up" && this.speaking) return false
    return this.clock.now() < this.openUntil
  }

  /**
   * Advance time with nothing said. Call on a timer so an unused window is
   * counted as a false wake rather than lingering until the next utterance.
   */
  tick(): void {
    this.noteSilenceIfExpired()
  }

  private noteSilenceIfExpired(): void {
    if (this.openUntil === null) return
    if (this.clock.now() < this.openUntil) return

    const was = this.openedBy
    this.openUntil = null
    this.openedBy = null
    // Only a wake can be false. A tap was deliberate, and a follow-up window
    // closing unused is the normal end of a conversation, not a misfire.
    if (was !== "wake") return

    this.consecutiveFalseWakes++
    if (this.consecutiveFalseWakes >= this.o.falseWakeLimit) {
      this.coolOffUntil = this.clock.now() + this.o.coolOffMs
      this.consecutiveFalseWakes = 0
    }
  }

  get coolingOff(): boolean {
    return this.clock.now() < this.coolOffUntil
  }

  get falseWakes(): number {
    return this.consecutiveFalseWakes
  }
}
