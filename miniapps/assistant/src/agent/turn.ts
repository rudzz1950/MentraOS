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
import {ModelRouter, ModelsUnavailableError, rulesAnswer} from "./model"
import {classify, type Intent} from "./router"
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
  error?: string
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

  constructor(private readonly opts: AssistantOptions) {
    this.tools = new Map((opts.tools ?? []).map(t => [t.name, t]))
    this.panel = opts.panel ?? STANDIN_OLED
  }

  /**
   * Show a card, applying the driving policy. A suppressed card means the
   * panel keeps whatever it had rather than going blank — a blank HUD at speed
   * reads as a dead device.
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

    try {
      const result = await this.opts.router.complete(context)
      await this.say(result.text)
      return {intent: "question", answer: result.text, via: result.via}
    } catch (err) {
      if (err instanceof ModelsUnavailableError) {
        // Say so plainly. Silence reads as a broken device.
        const msg = "Can't reach the assistant right now."
        await this.present(cards.error(msg, {panel: this.panel}))
        return {intent: "question", error: msg}
      }
      throw err
    }
  }

  /**
   * Build the model's input: stable preferences, the memories that match, then
   * the question. Memory is capped — the panel is small, the budget is small,
   * and a long context buys little on a two-line answer.
   */
  private async buildContext(text: string): Promise<string> {
    const k = this.opts.maxMemories ?? 5
    const hits = await this.opts.memory.search(text, k)
    const preferences = await this.opts.memory.list({classes: ["stable_preference"]})

    const parts: string[] = []
    if (preferences.length) {
      parts.push("Preferences:\n" + preferences.map(bullet).join("\n"))
    }
    if (hits.length) {
      parts.push("Relevant memories:\n" + hits.map(h => bullet(h.memory)).join("\n"))
    }
    parts.push(`Question: ${text}`)
    return parts.join("\n\n")
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

    this.pending = {tool, args: text}
    const summary = `${tool.name}: ${text}`
    await this.present(cards.confirm(summary, {panel: this.panel}))
    return {intent: "action", pendingConfirmation: {tool: tool.name, args: text, summary}}
  }

  private async resolveConfirmation(reply: string): Promise<TurnResult> {
    const p = this.pending!
    this.pending = null
    const yes = /^(yes|yeah|yep|send|confirm|do it|go ahead|ok|okay)\b/i.test(reply.trim())
    if (!yes) {
      await this.say("Cancelled.")
      return {intent: "action", answer: "Cancelled."}
    }
    const out = await p.tool.run(p.args)
    await this.say(out)
    return {intent: "action", answer: out, via: `tool:${p.tool.name}`}
  }

  private async say(text: string): Promise<void> {
    await this.present(cards.answer(text, {panel: this.panel}))
    await this.opts.voice.speak(splitSentences(text))
  }

  /** True while a confirmation is outstanding. */
  get awaitingConfirmation(): boolean {
    return this.pending !== null
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
