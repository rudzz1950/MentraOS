/**
 * @fileoverview Tap, double tap and hold, timed from raw button edges.
 *
 * The custom glasses' capability profile advertises press, double_press and
 * long_press, but link contract v0 carries only ButtonEvent.State DOWN and UP.
 * The firmware deliberately does not invent gesture messages (see the
 * firmware's input/button.h), so the phone owns the timing. Richer events
 * belong in contract v1 if they are ever wanted.
 *
 * The one thing that makes this awkward: a single press cannot be reported the
 * moment the button comes up, because it might turn out to be the first half
 * of a double press. So a press is held for the double-tap window and emitted
 * late. A long press is the opposite — it is emitted while the button is still
 * down, as soon as the hold threshold passes, because waiting for the release
 * would make a deliberate hold feel broken.
 *
 * Driven by an injected clock and an explicit `tick`, with no timers of its
 * own, so the windows can be tested against a fake clock instead of sleeps.
 */

export type ButtonGesture = "press" | "double_press" | "long_press"

export interface ButtonGestureOptions {
  /** Two presses closer together than this are one double press. */
  doubleWindowMs?: number
  /** Held at least this long is a long press, not a press. */
  holdMs?: number
  /** Edges closer together than this are contact bounce and ignored. */
  debounceMs?: number
}

const DEFAULTS = {doubleWindowMs: 300, holdMs: 600, debounceMs: 30}

/**
 * Classifies raw DOWN/UP edges into gestures.
 *
 * Call `down`, `up` and `tick` with monotonic milliseconds. Each returns the
 * gestures that became certain at that moment — usually none or one.
 */
export class ButtonGestureRecognizer {
  private readonly doubleWindowMs: number
  private readonly holdMs: number
  private readonly debounceMs: number

  private isDown = false
  private downAt = 0
  private lastEdgeAt = Number.NEGATIVE_INFINITY
  /** Set once a long press has been emitted, so the release is not a press. */
  private holdEmitted = false
  /** A press waiting to see whether a second one arrives. */
  private pendingPressAt: number | null = null

  constructor(opts: ButtonGestureOptions = {}) {
    this.doubleWindowMs = opts.doubleWindowMs ?? DEFAULTS.doubleWindowMs
    this.holdMs = opts.holdMs ?? DEFAULTS.holdMs
    this.debounceMs = opts.debounceMs ?? DEFAULTS.debounceMs
  }

  /** Raw DOWN. */
  down(nowMs: number): ButtonGesture[] {
    if (this.isDown) return []
    if (nowMs - this.lastEdgeAt < this.debounceMs) return []
    this.lastEdgeAt = nowMs
    this.isDown = true
    this.downAt = nowMs
    this.holdEmitted = false
    return []
  }

  /** Raw UP. */
  up(nowMs: number): ButtonGesture[] {
    if (!this.isDown) return []
    if (nowMs - this.lastEdgeAt < this.debounceMs) return []
    this.lastEdgeAt = nowMs
    this.isDown = false

    // The hold already fired while the button was down; the release is not a
    // separate press.
    if (this.holdEmitted) {
      this.holdEmitted = false
      this.pendingPressAt = null
      return []
    }

    if (this.pendingPressAt !== null && nowMs - this.pendingPressAt <= this.doubleWindowMs) {
      this.pendingPressAt = null
      return ["double_press"]
    }

    // Might be the first of two. Held until the window closes in `tick`.
    this.pendingPressAt = nowMs
    return []
  }

  /**
   * Advance time with no edge. Emits the long press once the hold threshold
   * passes, and the single press once the double-tap window closes.
   *
   * Must be called often enough to resolve those two deadlines; `nextDeadline`
   * says when the next one is.
   */
  tick(nowMs: number): ButtonGesture[] {
    const out: ButtonGesture[] = []

    if (this.isDown && !this.holdEmitted && nowMs - this.downAt >= this.holdMs) {
      this.holdEmitted = true
      // A hold supersedes a press that was waiting to be confirmed: the user
      // tapped and then held, which is a hold, not a tap followed by one.
      this.pendingPressAt = null
      out.push("long_press")
    }

    if (this.pendingPressAt !== null && nowMs - this.pendingPressAt > this.doubleWindowMs) {
      this.pendingPressAt = null
      out.push("press")
    }

    return out
  }

  /**
   * When `tick` next has something to do, or null when idle. Lets the caller
   * schedule one timer rather than polling.
   */
  nextDeadline(): number | null {
    const deadlines: number[] = []
    if (this.isDown && !this.holdEmitted) deadlines.push(this.downAt + this.holdMs)
    if (this.pendingPressAt !== null) deadlines.push(this.pendingPressAt + this.doubleWindowMs + 1)
    return deadlines.length ? Math.min(...deadlines) : null
  }

  /** Drop any half-finished gesture. Call on disconnect. */
  reset(): void {
    this.isDown = false
    this.holdEmitted = false
    this.pendingPressAt = null
    this.lastEdgeAt = Number.NEGATIVE_INFINITY
  }

  get pressPending(): boolean {
    return this.pendingPressAt !== null
  }
}
