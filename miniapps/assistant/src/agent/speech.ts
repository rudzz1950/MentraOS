/**
 * @fileoverview Speaking an answer while it is still being written. ANI-175.
 *
 * The turn loop used to wait for the whole answer, then speak it. On a
 * wearable that is the difference between an assistant and a pause. Now
 * model chunks go in as they arrive, come out as complete sentences, and the
 * first sentence plays as soon as it is complete.
 *
 * Kept behind the existing Voice port; no TTS vendor is named here.
 *
 * WHAT HAPPENS WHEN A MODEL FAILS HALFWAY. The router discards a failed
 * tier's partial answer and tries the next one, because half an answer read
 * as whole is worse than none. Streaming makes that impossible to honour
 * silently: words already spoken cannot be unsaid. So the rule is: if the
 * failed tier had already been heard, playback stops and the wearer is told
 * "That answer was cut off." before the next tier's answer starts from the
 * beginning. Nothing is stitched together. This is a product decision made
 * for ANI-175 and is easy to change here.
 *
 * Barge-in: `stop()` cancels the sentence playing and drops everything
 * queued; chunks that arrive afterwards for the same answer are ignored. It
 * reports how long the stop took, for the interruption budget.
 *
 * Output goes to the glasses when they can play it and falls back to the
 * phone otherwise, mid-answer if needed, saying so once.
 */

import type {Clock, Voice} from "./ports"

export type SpeechState = "idle" | "buffering" | "speaking" | "paused" | "muted"

/** Splits streamed text into sentences without breaking "Dr. Rao" or "3.5 g". */
export class SentenceSplitter {
  private buf = ""

  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []
    const re = /[.!?।]+["')\]]?\s+/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(this.buf))) {
      const end = m.index + m[0].length
      const candidate = this.buf.slice(last, end).trim()
      const before = this.buf.slice(Math.max(0, m.index - 3), m.index + 1)
      // "Dr." "Mr." "e.g." "3." before a digit: not the end of a sentence.
      if (/\b(Dr|Mr|Mrs|Ms|St|vs|e\.g|i\.e|No)\.$/i.test(before) || (/\d\.$/.test(before) && /^\d/.test(this.buf.slice(end)))) continue
      if (candidate) out.push(candidate)
      last = end
    }
    this.buf = this.buf.slice(last)
    return out
  }

  flush(): string[] {
    const rest = this.buf.trim()
    this.buf = ""
    return rest ? [rest] : []
  }
}

export class StreamingSpeaker {
  private splitter = new SentenceSplitter()
  private queue: string[] = []
  /** False after stop() until the next begin(): a chunk racing in after a barge-in is dropped. */
  private accepting = false
  private speaking = false
  private state: SpeechState = "idle"
  private paused: string | null = null
  private muted = false
  private spokeThisAnswer = false
  private toldFallback = false
  private firstAudioAt: number | null = null
  private startedAt = 0
  private output: "glasses" | "phone" = "glasses"

  constructor(
    private readonly deps: {
      glasses: Voice
      phone: Voice
      glassesAvailable: () => boolean
      clock: Clock
      onState?: (s: SpeechState) => void
    },
  ) {}

  /** A new answer begins. Anything still queued from an older one is dropped. */
  begin(): void {
    this.accepting = true
    this.queue = []
    this.splitter = new SentenceSplitter()
    this.spokeThisAnswer = false
    this.paused = null
    this.firstAudioAt = null
    this.startedAt = this.deps.clock.now()
    this.setState(this.muted ? "muted" : "buffering")
  }

  push(chunk: string): void {
    for (const s of this.splitter.push(chunk)) this.enqueue(s)
  }

  /** The model finished: speak whatever is left. Resolves when everything has been said. */
  async finish(): Promise<void> {
    for (const s of this.splitter.flush()) this.enqueue(s)
    await this.drain()
  }

  /**
   * The tier that was answering failed and the router is trying the next one.
   * If any of the failed answer was heard, playback stops and the new answer
   * opens with "That answer was cut off." Returns whether anything was heard.
   */
  restartAfterFailure(): boolean {
    const heard = this.spokeThisAnswer
    void Promise.allSettled([this.deps.glasses.stop(), this.deps.phone.stop()])
    this.begin()
    if (heard && !this.muted) {
      this.queue.push("That answer was cut off.")
      void this.drain()
    }
    return heard
  }

  /** Barge-in. Returns how long stopping took, in ms. */
  async stop(): Promise<number> {
    const t = this.deps.clock.now()
    this.accepting = false
    this.queue = []
    this.paused = null
    this.splitter = new SentenceSplitter()
    await Promise.allSettled([this.deps.glasses.stop(), this.deps.phone.stop()])
    this.speaking = false
    this.setState(this.muted ? "muted" : "idle")
    return this.deps.clock.now() - t
  }

  /** Pause: the sentence in progress is cut and will be said again from its start on resume. */
  async pause(): Promise<void> {
    if (this.state !== "speaking" && this.state !== "buffering") return
    this.paused = this.current ?? null
    this.setState("paused")
    await Promise.allSettled([this.deps.glasses.stop(), this.deps.phone.stop()])
    this.speaking = false
  }

  resume(): void {
    if (this.state !== "paused") return
    if (this.paused) this.queue.unshift(this.paused)
    this.paused = null
    this.setState("buffering")
    void this.drain()
  }

  async setMuted(m: boolean): Promise<void> {
    this.muted = m
    if (m) await this.stop()
    else this.setState("idle")
  }

  /** Milliseconds from begin() to the first sentence starting to play, or null. */
  timeToFirstAudio(): number | null {
    return this.firstAudioAt === null ? null : this.firstAudioAt - this.startedAt
  }

  get current(): string | undefined {
    return this.playing
  }

  get speechState(): SpeechState {
    return this.state
  }

  get outputDevice(): "glasses" | "phone" {
    return this.output
  }

  private playing: string | undefined
  private drainPromise: Promise<void> | null = null

  private enqueue(s: string): void {
    if (!this.accepting || this.muted) return
    this.queue.push(s)
    if (this.state !== "paused") void this.drain()
  }

  private drain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = (async () => {
        try {
          await this.run()
        } finally {
          this.drainPromise = null
        }
        // Something was queued (a resume, a restart) after the loop had
        // already decided to stop: start again rather than strand it.
        if (this.queue.length && this.state !== "paused" && !this.muted) await this.drain()
      })()
    }
    return this.drainPromise
  }

  /*
   * One loop drains the queue. Whoever changes the queue (stop, restart,
   * pause) changes it in place, and the loop simply looks again after each
   * sentence, so a new answer queued while the old sentence was finishing is
   * picked up rather than stranded.
   */
  private async run(): Promise<void> {
    while (this.queue.length && this.state !== "paused" && !this.muted) {
      const s = this.queue.shift()!
      this.playing = s
      this.speaking = true
      this.setState("speaking")
      if (this.firstAudioAt === null) this.firstAudioAt = this.deps.clock.now()
      this.spokeThisAnswer = true
      await this.say(s)
      this.playing = undefined
    }
    this.speaking = false
    if (this.state === "speaking") this.setState("idle")
  }

  private async say(s: string): Promise<void> {
    if (this.output === "glasses" && this.deps.glassesAvailable()) {
      try {
        await this.deps.glasses.speak([s])
        return
      } catch {
        // Disconnected or codec failure mid-answer: the rest goes to the phone.
      }
    }
    this.output = "phone"
    const lead = this.toldFallback ? [] : ["Glasses audio isn't available, using the phone."]
    this.toldFallback = true
    await this.deps.phone.speak([...lead, s])
  }

  /** The glasses came back: future sentences go there again. */
  glassesRestored(): void {
    this.output = "glasses"
    this.toldFallback = false
  }

  private setState(s: SpeechState): void {
    if (s === this.state) return
    this.state = s
    this.deps.onState?.(s)
  }
}
