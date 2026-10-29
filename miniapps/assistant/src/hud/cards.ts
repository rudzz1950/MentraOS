/**
 * @fileoverview The cards, and what each one is allowed to do.
 *
 * A card is data plus three policies: how long it stays up, what outranks it,
 * and what it becomes while the wearer is driving. Rendering is the easy part;
 * those three are the design.
 *
 * Driving is the constraint that shapes the set. A HUD that shows a message
 * body to someone doing 60 is worse than no HUD, so each card declares its
 * driving behaviour and the reduced form is written out rather than derived —
 * "show less" is a design decision per card, not a text transform.
 */

import type {PanelProfile} from "./panel"
import {layout, type CardLine} from "./text"

export type CardKind =
  | "listening"
  | "thinking"
  | "answer"
  | "confirm"
  | "noted"
  | "error"
  | "call"
  | "message"
  | "navigation"
  | "reminder"
  | "home"

/** How a card behaves when the wearer is driving. */
export type DrivingBehaviour =
  /** Shown as-is: already glanceable, no reading required. */
  | "full"
  /** Shown in a cut-down form: who or where, never the content. */
  | "reduced"
  /** Not shown at all until the wearer stops. */
  | "suppressed"

/**
 * Who wins when two cards want the panel. Higher outranks lower.
 * Navigation beats an answer because missing a turn costs more than a late
 * reply; a call beats navigation because the wearer will act on it either way.
 */
export const PRIORITY: Record<CardKind, number> = {
  call: 90,
  navigation: 80,
  confirm: 70,
  reminder: 60,
  message: 50,
  answer: 40,
  error: 40,
  noted: 30,
  thinking: 20,
  listening: 20,
  home: 0,
}

export interface Card {
  kind: CardKind
  /** Rendered rows, already fitted to the panel. */
  rows: string[]
  /**
   * The rows to show while driving, when they differ. Carried on the card so
   * `gate` is the only place the driving policy is applied — a card built in
   * one mode and gated in another would otherwise show the wrong content.
   */
  drivingRows?: string[]
  /** Milliseconds to hold the card, or null to hold until replaced. */
  ttlMs: number | null
  priority: number
  driving: DrivingBehaviour
}

export interface CardContext {
  panel: PanelProfile
}

function make(
  kind: CardKind,
  lines: CardLine[],
  ttlMs: number | null,
  driving: DrivingBehaviour,
  ctx: CardContext,
  drivingLines?: CardLine[],
): Card {
  return {
    kind,
    rows: layout(lines, ctx.panel),
    ...(drivingLines ? {drivingRows: layout(drivingLines, ctx.panel)} : {}),
    ttlMs,
    priority: PRIORITY[kind],
    driving,
  }
}

// ---------------------------------------------------------------------------
// Assistant states
// ---------------------------------------------------------------------------

/** Held until the utterance ends. The partial transcript is the feedback. */
export function listening(partial: string, ctx: CardContext): Card {
  return make(
    "listening",
    [
      {text: "Listening", fit: "keep"},
      {text: partial, fit: "wrap"},
    ],
    null,
    "suppressed",
    ctx,
  )
}

/** No spinner: an animation in the periphery pulls the eye off the road. */
export function thinking(ctx: CardContext): Card {
  return make("thinking", [{text: "Thinking", fit: "keep"}], null, "suppressed", ctx)
}

export function answer(text: string, ctx: CardContext): Card {
  return make("answer", [{text, fit: "wrap"}], 8000, "suppressed", ctx)
}

/**
 * The ask is "keep": it is the whole point of the card and must never be the
 * part that falls off. The summary of what will happen is what gives way.
 */
export function confirm(summary: string, ctx: CardContext): Card {
  return make(
    "confirm",
    [
      {text: summary, fit: "clip"},
      {text: "Say send to confirm", fit: "keep"},
    ],
    null,
    "suppressed",
    ctx,
  )
}

export function noted(ctx: CardContext): Card {
  return make("noted", [{text: "Noted", fit: "keep"}], 2000, "suppressed", ctx)
}

export function error(message: string, ctx: CardContext): Card {
  return make("error", [{text: message, fit: "wrap"}], 5000, "suppressed", ctx)
}

// ---------------------------------------------------------------------------
// Interruptions
// ---------------------------------------------------------------------------

/**
 * A call is the one card that is identical while driving: the name is all it
 * ever shows, and the wearer is going to decide either way.
 */
export function call(caller: string, ctx: CardContext): Card {
  return make(
    "call",
    [
      {text: "Call", fit: "keep"},
      {text: caller, fit: "clip"},
      {text: "Tap to answer", fit: "drop"},
    ],
    null,
    "full",
    ctx,
  )
}

/**
 * Message body is dropped while driving — sender only. Reading a sentence at
 * speed is the thing this HUD must not invite.
 */
export function message(sender: string, body: string, ctx: CardContext): Card {
  return make(
    "message",
    [
      {text: sender, fit: "clip"},
      {text: body, fit: "wrap"},
      {text: "Say reply to answer", fit: "drop"},
    ],
    6000,
    "reduced",
    ctx,
    [
      {text: sender, fit: "clip"},
      {text: "Message", fit: "keep"},
    ],
  )
}

/**
 * The only card designed for driving first. Distance and direction, nothing
 * else, and it holds until the turn is taken.
 */
export function navigation(distance: string, instruction: string, ctx: CardContext): Card {
  return make(
    "navigation",
    [
      {text: distance, fit: "keep"},
      {text: instruction, fit: "clip"},
    ],
    null,
    "full",
    ctx,
  )
}

export function reminder(when: string, what: string, ctx: CardContext): Card {
  return make(
    "reminder",
    [
      {text: when, fit: "keep"},
      {text: what, fit: "wrap"},
    ],
    6000,
    "reduced",
    ctx,
    [
      {text: when, fit: "keep"},
      {text: "Reminder", fit: "keep"},
    ],
  )
}

/** What the panel shows with nothing to say and no network. */
export function home(time: string, battery: string, ctx: CardContext): Card {
  return make(
    "home",
    [
      {text: time, fit: "keep"},
      {text: battery, fit: "drop"},
      {text: "Offline", fit: "drop"},
    ],
    null,
    "full",
    ctx,
  )
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Apply the driving policy — the ONE place it is applied.
 *
 * Returns null when the card must not be shown. What the caller does with that
 * depends on the card: a confirmation is mid-interaction and waits, whereas a
 * notification is perishable and is dropped outright (see notify.ts). Nothing
 * here queues anything. A "reduced" card comes back carrying its cut-down rows.
 */
export function gate(card: Card, driving: boolean): Card | null {
  if (!driving) return card
  if (card.driving === "suppressed") return null
  if (card.driving === "reduced" && card.drivingRows) {
    return {...card, rows: card.drivingRows}
  }
  return card
}
