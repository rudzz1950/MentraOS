/**
 * @fileoverview One turn, start to finish.
 *
 * Wake or tap opens a turn; speech accumulates; the final transcript is
 * classified, given context from memory, answered, shown and spoken. The loop
 * owns the order of those steps and nothing else — every capability it uses is
 * a port, so it runs in a test with no phone, no model and no glasses.
 */

import type {MemoryStore} from "../memory/memory"
import type {Memory} from "../memory/types"
import * as cards from "../hud/cards"
import {STANDIN_OLED, type PanelProfile} from "../hud/panel"
import {Addressing} from "./addressing"
import {BargeIn, OutboundLimit} from "./bargein"
import {allows, DEVICE_ONLY, memoryReach, narrower, type ConsentPolicy, type Locality} from "./egress"
import {CancelledError, ModelRouter, ModelsUnavailableError, rulesAnswer, type PromptFor} from "./model"
import {unavailableMessage} from "./providers"
import {classify, type Intent} from "./router"
import {TimerStore} from "./timers"
import type {Clock, Hud, Tool, TranscriptSource, Voice} from "./ports"

export interface TurnResult {
  intent: Intent
  /** What was said back, if anything. */
  answer?: string
  via?: string
  /** Set when the turn needs the user to confirm before anything happens. */
  pendingConfirmation?: {tool: string; args: string; summary: string}
  /** True when the turn deliberately did nothing. */
  ignored?: boolean
  /** True when the wearer spoke over the assistant and the turn was cut short. */
  interrupted?: boolean
  error?: string
  /**
   * Context items the answering tier was not allowed to see (egress.ts), for
   * the "why" view. Absent when nothing was withheld.
   */
  withheld?: number
}

export interface AssistantOptions {
  transcripts: TranscriptSource
  hud: Hud
  voice: Voice
  memory: MemoryStore
  router: ModelRouter
  clock: Clock
  tools?: Tool[]
  /** Memories to put in front of the model. Small: the panel and the budget are both small. */
  maxMemories?: number
  /** Which panel to lay cards out for. Defaults to the dev-board OLED. */
  panel?: PanelProfile
  /** True while the wearer is driving; see hud/cards.ts for what that changes. */
  driving?: () => boolean
  /** Barge-in. Omitted means the assistant cannot be spoken over. */
  bargeIn?: BargeIn
  /** Outbound rate limit. Omitted means five per ten minutes. */
  outbound?: OutboundLimit
  /** Timers and alarms, answered on-device. Omitted means one is created. */
  timers?: TimerStore
  /**
   * How many previous exchanges to put in front of the model, so a follow-up
   * like "what about tomorrow" has something to refer to. Zero disables it.
   */
  historyTurns?: number
  /** Opens and closes the floor. Omitted means `handle` is told directly. */
  addressing?: Addressing
  /**
   * Whether a heavy tier exists in this deployment. Changes what the wearer is
   * told when nothing answers: a site with no heavy tier is working as
   * specified, not broken, and should not be invited to retry. Defaults to
   * true, because that is the hosted case and the pessimistic default would
   * tell a normal user a capability is missing when it is merely offline.
   */
  hasHeavyTier?: boolean
  /**
   * How far each consent scope's captured data may travel. Omitted means
   * captured memories never leave the device. See egress.ts.
   */
  consent?: ConsentPolicy
}

/**
 * Kept as thin wrappers over hud/cards so there is ONE layout engine. The two
 * used to be separate and drifted: the turn loop assumed 21 columns and two
 * rows no matter which panel was attached.
 */
export function confirmationCard(summary: string, panel: PanelProfile = STANDIN_OLED): string[] {
  return cards.confirm(summary, {panel}).rows
}

export function fitToHud(text: string, panel: PanelProfile = STANDIN_OLED): string[] {
  return cards.answer(text, {panel}).rows
}

export class Assistant {
  private readonly tools: Map<string, Tool>
  private pending: {tool: Tool; args: string} | null = null
  private readonly panel: PanelProfile
  private readonly outbound: OutboundLimit
  private readonly timers: TimerStore
  /** Recent exchanges, oldest first. Capped; see historyTurns. */
  private history: {question: string; answer: string; reach: Locality}[] = []
  /** Cancels the model and the voice for the turn in flight. */
  private inflight: AbortController | null = null
  private reconfirming = false

  constructor(private readonly opts: AssistantOptions) {
    this.tools = new Map((opts.tools ?? []).map(t => [t.name, t]))
    this.panel = opts.panel ?? STANDIN_OLED
    this.outbound = opts.outbound ?? new OutboundLimit(opts.clock)
    this.timers = opts.timers ?? new TimerStore(opts.clock)
  }

  /**
   * True when a registered tool names itself in this utterance.
   *
   * The built-in timer store is a DEFAULT, not a hijack. A host that registers
   * a tool called "timer" or "alarm" meant it to be used — probably because it
   * integrates with the phone's own clock app — and silently shadowing it would
   * be the kind of surprise that takes an afternoon to find. Registering such a
   * tool is how a caller opts out of the on-device path, at the cost of its
   * offline behaviour.
   */
  private toolClaims(text: string): boolean {
    const lower = text.toLowerCase()
    return [...this.tools.values()].some(t => lower.includes(t.name.toLowerCase()))
  }

  /** The on-device timer store, for the caller that fires them. */
  get timerStore(): TimerStore {
    return this.timers
  }

  /**
   * Stop talking and cancel whatever is being generated. Called by barge-in;
   * safe to call when nothing is running.
   */
  interrupt(): void {
    this.inflight?.abort()
    this.inflight = null
    void this.opts.voice.stop()
  }

  /**
   * Show a card, applying the driving policy. A suppressed card leaves the
   * panel as it was rather than blanking it — a blank HUD at speed reads as a
   * dead device. Nothing is queued for later: see hud/notify.ts on why.
   */
  private async present(card: cards.Card): Promise<void> {
    const shown = cards.gate(card, this.opts.driving?.() ?? false)
    if (shown) await this.opts.hud.show(shown.rows)
  }

  /**
   * Run one turn over a final transcript.
   *
   * @param addressed whether the wake word fired or the user tapped. Overheard
   *   speech never acts; see router.ts.
   */
  async handle(text: string, addressed: boolean): Promise<TurnResult> {
    // A pending confirmation swallows the next utterance: "send it" means the
    // thing just proposed, not a fresh request.
    if (this.pending) {
      return this.resolveConfirmation(text)
    }

    const intent = classify(text, addressed)
    if (intent === "not_for_me") {
      return {intent, ignored: true}
    }

    /*
     * Timers and alarms are handled here, after the addressed check and before
     * the intent dispatch.
     *
     * They had to move. "set a timer for ten minutes" opens with an action
     * verb, so the router classifies it as an action — correctly — and it never
     * reached a check living in the question path. It then fell through to "I
     * can't do that yet", which is the single most common thing anyone asks a
     * wearable.
     *
     * It must stay AFTER the not_for_me check, though: someone else in the room
     * saying "set a timer for the pasta" must not set one. And before the note
     * check, so "remember that..." is still a note.
     */
    if (intent !== "note" && !this.toolClaims(text)) {
      const timed = this.timers.handle(text)
      if (timed !== null) {
        await this.say(timed)
        return {intent, answer: timed, via: "timers"}
      }
    }

    if (intent === "note") {
      await this.opts.memory.add({
        class: "episodic",
        text: stripNotePrefix(text),
        source: {turnId: `t${this.opts.clock.now()}`, turnAt: this.opts.clock.now(), utterance: text},
      })
      await this.present(cards.noted({panel: this.panel}))
      await this.opts.voice.speak(["Noted."])
      return {intent, answer: "Noted."}
    }

    if (intent === "action") {
      return this.proposeAction(text)
    }

    return this.answerQuestion(text)
  }

  private async answerQuestion(text: string): Promise<TurnResult> {
    const quick = rulesAnswer(text, this.opts.clock)
    if (quick !== null) {
      await this.say(quick)
      return {intent: "question", answer: quick, via: "rules"}
    }

    const context = await this.buildContext(text)
    await this.present(cards.thinking({panel: this.panel}))

    const ctrl = new AbortController()
    this.inflight = ctrl
    try {
      const result = await this.opts.router.complete(context.promptFor, {signal: ctrl.signal})
      const shown = context.shownTo.get(result.via)
      // The answer carries the reach of what it was built from: an answer
      // drawn from a device-only memory is itself device-only, and must not
      // ride into a later cloud prompt as "recent conversation".
      this.remember(text, result.text, shown?.reach ?? "cloud")
      await this.say(result.text)
      return {
        intent: "question",
        answer: result.text,
        via: result.via,
        ...(shown?.withheld ? {withheld: shown.withheld} : {}),
      }
    } catch (err) {
      // Cancellation is the wearer speaking over the assistant. Nothing is
      // retried and nothing is shown: they are already talking.
      if (err instanceof CancelledError) {
        return {intent: "question", interrupted: true}
      }
      if (err instanceof ModelsUnavailableError) {
        // Say so plainly. Silence reads as a broken device — and say WHICH
        // thing is wrong, because "not set up here" and "can't reach it" call
        // for different reactions from the wearer.
        const msg = unavailableMessage(this.opts.hasHeavyTier ?? true)
        await this.present(cards.error(msg, {panel: this.panel}))
        return {intent: "question", error: msg}
      }
      throw err
    } finally {
      if (this.inflight === ctrl) this.inflight = null
    }
  }

  /**
   * Build the model's input: stable preferences, the memories that match, then
   * the question. Memory is capped — the panel is small, the budget is small,
   * and a long context buys little on a two-line answer.
   */
  private async buildContext(text: string): Promise<{
    promptFor: PromptFor
    /** Per tier name, what it was shown: the narrowest reach included, and how much was held back. */
    shownTo: Map<string, {reach: Locality; withheld: number}>
  }> {
    const k = this.opts.maxMemories ?? 5
    const policy = this.opts.consent ?? DEVICE_ONLY
    const hits = await this.opts.memory.search(text, k)
    const preferences = await this.opts.memory.list({classes: ["stable_preference"]})
    const keep = this.opts.historyTurns ?? 3
    const recent = keep > 0 ? this.history.slice(-keep) : []

    const prefs = preferences.map(m => ({line: bullet(m), reach: memoryReach(m, policy)}))
    const mems = hits.map(h => ({line: bullet(h.memory), reach: memoryReach(h.memory, policy)}))
    const turns = recent.map(h => ({line: `- Asked: ${h.question}\n  Answered: ${h.answer}`, reach: h.reach}))
    const shownTo = new Map<string, {reach: Locality; withheld: number}>()

    const promptFor: PromptFor = tier => {
      const where: Locality = tier.locality ?? "cloud"
      let reach: Locality = "cloud"
      let withheld = 0
      const fit = (items: {line: string; reach: Locality}[]) =>
        items.filter(i => {
          if (!allows(i.reach, where)) {
            withheld++
            return false
          }
          reach = narrower(reach, i.reach)
          return true
        })

      const parts: string[] = []
      const p = fit(prefs)
      if (p.length) parts.push("Preferences:\n" + p.map(i => i.line).join("\n"))
      const m = fit(mems)
      if (m.length) parts.push("Relevant memories:\n" + m.map(i => i.line).join("\n"))
      // Recent exchanges, so "what about tomorrow" has an antecedent. Without
      // these every utterance was a cold start and no follow-up could resolve.
      const t = fit(turns)
      if (t.length) parts.push("Recent conversation:\n" + t.map(i => i.line).join("\n"))
      parts.push(`Question: ${text}`)
      shownTo.set(tier.name, {reach, withheld})
      return parts.join("\n\n")
    }
    return {promptFor, shownTo}
  }

  /**
   * Consequential tools never fire on the strength of a transcript. The user
   * sees exactly what will happen and says yes first — speech recognition is
   * wrong often enough that sending a message on one pass is indefensible.
   */
  private async proposeAction(text: string): Promise<TurnResult> {
    const tool = [...this.tools.values()].find(t => text.toLowerCase().includes(t.name.toLowerCase()))
    if (!tool) {
      const msg = "I can't do that yet."
      await this.say(msg)
      return {intent: "action", answer: msg}
    }

    if (!tool.consequential) {
      const out = await tool.run(text)
      await this.say(out)
      return {intent: "action", answer: out, via: `tool:${tool.name}`}
    }

    // Over the outbound limit the assistant asks a second time rather than
    // refusing: the wearer may legitimately have six things to send, and the
    // runaway case is what the second ask catches.
    const verdict = this.outbound.check()
    this.reconfirming = verdict.reconfirm
    this.pending = {tool, args: text}
    const summary = verdict.reconfirm ? `Again? ${tool.name}: ${text}` : `${tool.name}: ${text}`
    await this.present(cards.confirm(summary, {panel: this.panel}))
    return {intent: "action", pendingConfirmation: {tool: tool.name, args: text, summary}}
  }

  private async resolveConfirmation(reply: string): Promise<TurnResult> {
    const p = this.pending!
    this.pending = null
    const wasReconfirming = this.reconfirming
    this.reconfirming = false
    // A second ask takes an explicit word. "ok" is what someone says while
    // thinking, and it should not be what sends the sixth message.
    const yes = wasReconfirming
      ? /^(yes|send|confirm)\b/i.test(reply.trim())
      : /^(yes|yeah|yep|send|confirm|do it|go ahead|ok|okay)\b/i.test(reply.trim())
    if (!yes) {
      await this.say("Cancelled.")
      return {intent: "action", answer: "Cancelled."}
    }
    if (p.tool.consequential) this.outbound.record()
    const out = await p.tool.run(p.args)
    await this.say(out)
    return {intent: "action", answer: out, via: `tool:${p.tool.name}`}
  }

  private async say(text: string): Promise<void> {
    await this.present(cards.answer(text, {panel: this.panel}))
    await this.opts.voice.speak(splitSentences(text))
  }

  /**
   * Keep the exchange for the next turn's context. Only successful answers:
   * recording an error as an answer would have the model treat "can't reach
   * the assistant" as a fact about the world.
   */
  private remember(question: string, answer: string, reach: Locality): void {
    const keep = this.opts.historyTurns ?? 3
    if (keep <= 0) return
    this.history.push({question, answer, reach})
    // Bounded: a wearable conversation is short and the panel is two lines.
    while (this.history.length > keep) this.history.shift()
  }

  /** Drop the conversation. Call when the wearer walks away or a topic ends. */
  clearHistory(): void {
    this.history = []
  }

  get historyLength(): number {
    return this.history.length
  }

  /** True while a confirmation is outstanding. */
  get awaitingConfirmation(): boolean {
    return this.pending !== null
  }

  /** True when the outstanding confirmation is a second ask past the limit. */
  get awaitingReconfirmation(): boolean {
    return this.pending !== null && this.reconfirming
  }

  /** Outbound actions left before the assistant starts asking twice. */
  get outboundRemaining(): number {
    return this.outbound.remaining()
  }
}

function bullet(m: Memory): string {
  return `- ${m.text}`
}

function stripNotePrefix(text: string): string {
  return text.replace(/^.*?\b(remember that|remember this|note that|make a note( of)?|don't forget)\b:?\s*/i, "").trim() || text
}

/** Sentence at a time, so speech can start before the answer is complete. */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
}
