/**
 * @fileoverview Timers and alarms, answered without a network.
 *
 * ANI-58 specified "rules and on-device for timers and the clock (under
 * 300 ms)". The clock was done; timers were not, so "set a timer for ten
 * minutes" went to a cloud model, which is absurd for the single most common
 * thing anyone asks a wearable. It is also the request most likely to be made
 * where there is no signal — a kitchen, a basement gym, a train.
 *
 * So this parses and runs entirely on the phone. No model, no network, and it
 * keeps working when everything else here has failed.
 *
 * PARSING IS DELIBERATELY NARROW. It recognises the shapes people actually say
 * and refuses everything else, returning null so the request falls through to a
 * model rather than being half-understood. A timer set for the wrong duration
 * is worse than one that was not set, because the wearer believes it is
 * running. There is no "best guess" path here on purpose.
 *
 * Firing is the caller's job: this owns the parsing, the state and the "what is
 * due" question, and takes a clock, so it is testable without waiting.
 */

import type {Clock} from "./ports"

export interface Timer {
  id: string
  /** What the wearer called it, when they named it. "pasta", "laundry". */
  label?: string
  /** Epoch milliseconds when it is due. */
  dueAt: number
  /** The original duration, so a repeat can be offered without re-parsing. */
  durationMs?: number
  kind: "timer" | "alarm"
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  seconds: 1000,
  sec: 1000,
  secs: 1000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, forty_five: 45, fifty: 50, sixty: 60, ninety: 90,
  half: 0.5, a: 1, an: 1,
}

/** A duration in milliseconds, or null when the text does not state one. */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase()
  const num = (w: string) => WORD_NUMBERS[w] ?? Number(w)
  const NUM = "\\d+|one|two|three|four|five|six|seven|eight|nine|ten|an?"

  /*
   * Halves come in three word orders and people use all of them. The unit can
   * come AFTER the half ("one and a half hours") or BEFORE it ("an hour and a
   * half"), and "half an hour" puts it last. Getting this wrong is not
   * harmless: "an hour and a half" previously matched the plain
   * number-plus-unit path and silently became ONE hour, which is exactly the
   * wrong-duration failure this parser exists to avoid.
   */

  // "an hour and a half", "two hours and a half"
  const unitFirst = t.match(new RegExp(`\\b(${NUM})\\s+(hours?|hrs?|minutes?|mins?)\\s+and\\s+a\\s+half\\b`))
  if (unitFirst) {
    const base = num(unitFirst[1])
    const unit = UNIT_MS[unitFirst[2]]
    if (unit && Number.isFinite(base)) return Math.round((base + 0.5) * unit)
  }

  // "one and a half hours"
  const unitLast = t.match(new RegExp(`\\b(${NUM})\\s+and\\s+a\\s+half\\s+(hours?|hrs?|minutes?|mins?)\\b`))
  if (unitLast) {
    const base = num(unitLast[1])
    const unit = UNIT_MS[unitLast[2]]
    if (unit && Number.isFinite(base)) return Math.round((base + 0.5) * unit)
  }

  // "half an hour", "half a minute"
  const halfOnly = t.match(/\bhalf\s+an?\s+(hour|hr|minute|min)\b/)
  if (halfOnly) {
    const unit = UNIT_MS[halfOnly[1]]
    if (unit) return Math.round(0.5 * unit)
  }

  // "10 minutes", "ten minutes", "1 hour 30 minutes", "90 seconds"
  const parts = [...t.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|an?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/g)]
  if (parts.length === 0) return null

  let total = 0
  for (const p of parts) {
    const n = WORD_NUMBERS[p[1]] ?? Number(p[1])
    const unit = UNIT_MS[p[2]]
    if (!Number.isFinite(n) || !unit) return null
    total += n * unit
  }
  // A zero or negative duration is not a timer.
  return total > 0 ? total : null
}

/**
 * A clock time, as milliseconds from `now` to the next occurrence.
 * "7am", "6:30", "half past six" is NOT handled — see the narrowness note.
 */
export function parseAlarmTime(text: string, now: number): number | null {
  const m = text.toLowerCase().match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  if (hour < 1 || hour > 12 || minute > 59) return null
  if (m[3] === "pm" && hour !== 12) hour += 12
  if (m[3] === "am" && hour === 12) hour = 0

  const d = new Date(now)
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  // Already gone today means tomorrow, which is what "set an alarm for 7am" at
  // midnight-plus-one means.
  if (target.getTime() <= d.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime() - now
}

/** A label, when the wearer gave one: "a timer for the pasta". */
export function parseLabel(text: string): string | undefined {
  const m = text.toLowerCase().match(/\bfor (?:the |my )?([a-z][a-z ]{1,24}?)\s*(?:$|,|\.|\bfor\b|\bin\b)/)
  if (!m) return undefined
  const label = m[1].trim()
  // "for 10 minutes" is a duration, not a label.
  if (/\d/.test(label) || Object.keys(UNIT_MS).some(u => label.endsWith(u))) return undefined
  if (Object.keys(WORD_NUMBERS).includes(label)) return undefined
  return label.length >= 2 ? label : undefined
}

export class TimerStore {
  private timers: Timer[] = []
  private seq = 0

  constructor(private readonly clock: Clock) {}

  /**
   * Try to handle an utterance entirely on-device. Returns what to say, or
   * null when this is not a timer request at all and should go to a model.
   */
  handle(text: string): string | null {
    const t = text.toLowerCase().trim()

    // Plural matters: "cancel all timers" is the common phrasing and a
    // singular-only pattern silently fell through to the model.
    if (/\b(cancel|stop|clear|delete)\b.*\b(timers?|alarms?)\b/.test(t)) {
      return this.cancel(t)
    }
    if (/\b(how (long|much time)|what('s| is) left|time left|remaining)\b/.test(t)) {
      return this.remaining()
    }
    if (/\b(what|list|any)\b.*\b(timers?|alarms?)\b/.test(t) && !/\bset\b/.test(t)) {
      return this.list()
    }

    const wantsAlarm = /\balarm\b/.test(t)
    const wantsTimer = /\b(timer|remind me in|wake me in)\b/.test(t)
    if (!wantsAlarm && !wantsTimer) return null

    if (wantsAlarm) {
      const ms = parseAlarmTime(t, this.clock.now())
      if (ms === null) {
        // Say what is missing rather than guessing a time.
        return "What time should the alarm be?"
      }
      const timer = this.add("alarm", ms, parseLabel(t))
      return `Alarm set for ${formatClock(timer.dueAt)}.`
    }

    const ms = parseDuration(t)
    if (ms === null) return "How long should the timer be?"
    const timer = this.add("timer", ms, parseLabel(t))
    return `Timer set for ${formatDuration(ms)}${timer.label ? ` for the ${timer.label}` : ""}.`
  }

  add(kind: "timer" | "alarm", ms: number, label?: string): Timer {
    const timer: Timer = {
      id: `t${++this.seq}`,
      label,
      dueAt: this.clock.now() + ms,
      durationMs: kind === "timer" ? ms : undefined,
      kind,
    }
    this.timers.push(timer)
    return timer
  }

  /** Everything now due, removed from the store as it is returned. */
  due(): Timer[] {
    const now = this.clock.now()
    const fired = this.timers.filter(t => t.dueAt <= now)
    this.timers = this.timers.filter(t => t.dueAt > now)
    return fired
  }

  active(): Timer[] {
    const now = this.clock.now()
    return this.timers.filter(t => t.dueAt > now).sort((a, b) => a.dueAt - b.dueAt)
  }

  /** When the next one is due, for scheduling one timer rather than polling. */
  nextDueAt(): number | null {
    const next = this.active()[0]
    return next ? next.dueAt : null
  }

  private cancel(t: string): string {
    const active = this.active()
    if (active.length === 0) return "Nothing to cancel."

    // A named one, if the name is in the utterance.
    const named = active.find(x => x.label && t.includes(x.label))
    if (named) {
      this.timers = this.timers.filter(x => x.id !== named.id)
      return `Cancelled the ${named.label} timer.`
    }
    if (active.length === 1) {
      this.timers = this.timers.filter(x => x.id !== active[0].id)
      return "Cancelled."
    }
    if (/\ball\b/.test(t)) {
      this.timers = []
      return "Cancelled all of them."
    }
    // Several, and no clue which. Do not pick one.
    return `There are ${active.length}: ${active.map(describe).join(", ")}. Which one?`
  }

  private remaining(): string {
    const active = this.active()
    if (active.length === 0) return "No timers running."
    const next = active[0]
    const left = next.dueAt - this.clock.now()
    return `${formatDuration(left)} left${next.label ? ` on the ${next.label}` : ""}.`
  }

  private list(): string {
    const active = this.active()
    if (active.length === 0) return "No timers or alarms set."
    return active.map(describe).join(", ") + "."
  }
}

function describe(t: Timer): string {
  if (t.kind === "alarm") return `alarm at ${formatClock(t.dueAt)}`
  return t.label ? `${t.label}` : "a timer"
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const bits: string[] = []
  if (h) bits.push(`${h} hour${h === 1 ? "" : "s"}`)
  if (m) bits.push(`${m} minute${m === 1 ? "" : "s"}`)
  // Seconds are only worth saying when they are the whole story, or close to it.
  if (s && !h) bits.push(`${s} second${s === 1 ? "" : "s"}`)
  return bits.length ? bits.join(" ") : "0 seconds"
}

export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = d.getHours() % 12 || 12
  const mm = d.getMinutes().toString().padStart(2, "0")
  return `${hh}:${mm} ${d.getHours() < 12 ? "am" : "pm"}`
}
