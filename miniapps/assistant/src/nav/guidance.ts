/**
 * @fileoverview Turn-by-turn guidance on the glasses, from the phone's navigation feed. ANI-241, ANI-243.
 *
 * Google's Navigation SDK on the phone is the route authority (ANI-239). This
 * file never plans, corrects or guesses a route; it decides what the glasses
 * SHOW and SAY from what the SDK reports, and above all what they must not:
 *
 *   NEVER A STALE TURN. Every instruction carries the route generation and
 *   step it belongs to. Anything from an older generation is dropped, a reroute
 *   clears the HUD and voids every queued prompt, and nothing is spoken again
 *   until the SDK delivers a valid instruction on the new route. "Turn right"
 *   from the route the wearer just left is worse than silence: they will turn.
 *
 *   PROMPTS AT THRESHOLDS, ONCE. Each step is announced as the distance
 *   crosses set marks (far, near, now), each mark once. When the step changes
 *   the wearer has acted, so the old step's remaining prompts are cancelled.
 *
 *   GPS NOISE IS NOT A REROUTE. A poor or lost fix says so once and suppresses
 *   the distance-based "now" prompt, whose distance can no longer be trusted.
 *   Deviation is the SDK's call, not this file's.
 *
 *   THE CAMERA ONLY CORROBORATES. A road sign or lane seen by the camera can
 *   agree with the route or raise a doubt. It can never issue a turn.
 *
 *   RECONNECT RESTORES, IT DOES NOT REPLAY. After a disconnect the current
 *   step is shown, and prompts whose marks were passed while disconnected are
 *   not spoken late.
 *
 * Output is a list of effects for the caller to apply (HUD lines, speech, a
 * cancel of queued speech), so the rules test without a phone or glasses.
 */

export type Maneuver =
  | "turn_left"
  | "turn_right"
  | "slight_left"
  | "slight_right"
  | "sharp_left"
  | "sharp_right"
  | "keep_left"
  | "keep_right"
  | "u_turn"
  | "roundabout"
  | "straight"
  | "merge"
  | "ramp_left"
  | "ramp_right"
  | "destination"
  | "unknown"

/** What the SDK adapter produces from each turn-by-turn feed update. */
export interface NavFeedUpdate {
  /** "enroute" while guiding; "rerouting" while the SDK recomputes; "stopped" when the trip ends. */
  state: "enroute" | "rerouting" | "stopped"
  /** Increments every time the SDK produces a new route, including a new trip after one stopped. */
  routeGeneration: number
  /** Index of the current step on that route. */
  step: number
  maneuver?: Maneuver
  /** Exit number for a roundabout. */
  roundaboutExit?: number
  roadName?: string
  distanceToManeuverM?: number
  etaSeconds?: number
  /** Recommended lanes, left to right; true where the wearer should be. */
  lanes?: boolean[]
  /** When the phone received it, ms. */
  at: number
}

export interface PositionFix {
  /** Horizontal accuracy radius in metres, from the location provider. */
  accuracyM: number
  at: number
}

/** A camera observation that bears on the current step. Supplemental only. */
export interface CameraHint {
  routeGeneration: number
  step: number
  verdict: "agrees" | "conflicts"
  /** What was seen, for the uncertainty message. */
  description: string
}

export type Effect =
  | {kind: "hud"; lines: [string, string]}
  | {kind: "hud_clear"}
  | {kind: "speak"; text: string; priority: "imminent" | "normal"; routeGeneration: number; step: number}
  /** Drop anything queued for playback that belongs to an older route or step. */
  | {kind: "cancel_speech"; olderThan: {routeGeneration: number; step: number}}

export interface GuidanceOptions {
  /** Distance marks in metres, largest first. The last is "now". */
  thresholdsM?: number[]
  /** A fix worse than this is "poor". 50 m by default. */
  poorAccuracyM?: number
  /** No fix for this long is "lost". 10 s by default. */
  lostAfterMs?: number
  /** A feed update older than this is not current guidance. 5 s by default. */
  staleAfterMs?: number
}

const ARROW: Record<Maneuver, string> = {
  turn_left: "<-",
  turn_right: "->",
  slight_left: "<\\",
  slight_right: "/>",
  sharp_left: "<<",
  sharp_right: ">>",
  keep_left: "<|",
  keep_right: "|>",
  u_turn: "U",
  roundabout: "O",
  straight: "^",
  merge: "^",
  ramp_left: "<\\",
  ramp_right: "/>",
  destination: "*",
  unknown: "?",
}

const WORDS: Record<Maneuver, string> = {
  turn_left: "turn left",
  turn_right: "turn right",
  slight_left: "bear left",
  slight_right: "bear right",
  sharp_left: "turn sharp left",
  sharp_right: "turn sharp right",
  keep_left: "keep left",
  keep_right: "keep right",
  u_turn: "make a U-turn",
  roundabout: "at the roundabout",
  straight: "continue straight",
  merge: "merge",
  ramp_left: "take the ramp on the left",
  ramp_right: "take the ramp on the right",
  destination: "you will arrive",
  unknown: "continue",
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(Math.round(m / 100) / 10).toFixed(1)} km`
  if (m >= 100) return `${Math.round(m / 50) * 50} m`
  return `${Math.max(10, Math.round(m / 10) * 10)} m`
}

function instructionText(u: NavFeedUpdate): string {
  const m = u.maneuver ?? "unknown"
  let s = WORDS[m]
  if (m === "roundabout" && u.roundaboutExit) s += `, take exit ${u.roundaboutExit}`
  if (u.roadName && m !== "destination") s += ` onto ${u.roadName}`
  return s
}

function lanesText(lanes?: boolean[]): string {
  return lanes && lanes.length ? lanes.map(l => (l ? "|^|" : "| |")).join("") : ""
}

export class Guidance {
  private readonly thresholds: number[]
  private readonly poorAccuracyM: number
  private readonly lostAfterMs: number
  private readonly staleAfterMs: number

  private generation = -1
  private step = -1
  private current: NavFeedUpdate | null = null
  /** Marks already announced for the current step. */
  private spoken = new Set<number>()
  private rerouting = false
  private stopped = false
  private muted = false
  private lastFix: PositionFix | null = null
  private gpsWarned = false

  constructor(opts: GuidanceOptions = {}) {
    this.thresholds = [...(opts.thresholdsM ?? [1000, 200, 30])].sort((a, b) => b - a)
    this.poorAccuracyM = opts.poorAccuracyM ?? 50
    this.lostAfterMs = opts.lostAfterMs ?? 10_000
    this.staleAfterMs = opts.staleAfterMs ?? 5_000
  }

  /** One feed update. Returns what to do about it. */
  update(u: NavFeedUpdate, now: number): Effect[] {
    // Out of date, or from a route the SDK has already replaced: never acted on.
    if (u.routeGeneration < this.generation) return []
    if (u.routeGeneration === this.generation && u.step < this.step) return []
    if (now - u.at > this.staleAfterMs) return []

    if (u.state === "stopped") {
      if (this.stopped) return []
      this.stopped = true
      this.current = null
      // A late "enroute" from the trip just cancelled must not revive it: only
      // a newer generation, which is what a new trip gets, is accepted.
      this.generation = u.routeGeneration + 1
      this.step = -1
      return [{kind: "cancel_speech", olderThan: {routeGeneration: Infinity, step: Infinity}}, {kind: "hud_clear"}]
    }
    this.stopped = false

    if (u.state === "rerouting") {
      const effects: Effect[] = []
      if (!this.rerouting) {
        effects.push(
          {kind: "cancel_speech", olderThan: {routeGeneration: u.routeGeneration + 1, step: 0}},
          {kind: "hud", lines: ["Rerouting...", ""]},
        )
        if (!this.muted) effects.push({kind: "speak", text: "Rerouting.", priority: "normal", routeGeneration: u.routeGeneration, step: u.step})
      }
      this.rerouting = true
      this.current = null
      // Wait for a generation after this one before trusting any instruction.
      this.generation = u.routeGeneration + 1
      this.step = -1
      return effects
    }

    const effects: Effect[] = []
    const newStep = u.routeGeneration !== this.generation || u.step !== this.step
    if (newStep) {
      // The wearer has acted, or the route changed: the old step's prompts are void.
      effects.push({kind: "cancel_speech", olderThan: {routeGeneration: u.routeGeneration, step: u.step}})
      this.spoken.clear()
      this.generation = u.routeGeneration
      this.step = u.step
    }
    this.rerouting = false
    this.current = u
    effects.push({kind: "hud", lines: this.hudLines(u)})

    const d = u.distanceToManeuverM
    if (d !== undefined && !this.muted) {
      // The smallest mark already crossed. Earlier marks crossed at the same
      // time (a fast car, a late update) are not read out one after another.
      const crossed = this.thresholds.filter(t => d <= t)
      const mark = crossed[crossed.length - 1]
      const isNow = mark === this.thresholds[this.thresholds.length - 1]
      if (mark !== undefined && !this.spoken.has(mark) && !(isNow && this.gpsUnreliable(now))) {
        for (const t of crossed) this.spoken.add(t)
        const text = isNow ? capitalise(instructionText(u)) + " now." : `In ${formatDistance(d)}, ${instructionText(u)}.`
        effects.push({kind: "speak", text, priority: isNow ? "imminent" : "normal", routeGeneration: u.routeGeneration, step: u.step})
      }
    }
    return effects
  }

  /** A location fix. Says once when GPS turns poor or is lost. */
  position(fix: PositionFix | null, now: number): Effect[] {
    if (fix) this.lastFix = fix
    if (!this.current || this.muted) return []
    if (this.gpsUnreliable(now)) {
      if (this.gpsWarned) return []
      this.gpsWarned = true
      return [{kind: "speak", text: "GPS signal is weak. Check your phone before turning.", priority: "normal", routeGeneration: this.generation, step: this.step}]
    }
    this.gpsWarned = false
    return []
  }

  /**
   * A camera observation. Agreement changes nothing. A conflict states the
   * doubt and tells the wearer to check; it does not change the instruction.
   */
  camera(hint: CameraHint): Effect[] {
    if (!this.current || hint.routeGeneration !== this.generation || hint.step !== this.step) return []
    if (hint.verdict === "agrees" || this.muted) return []
    return [{
      kind: "speak",
      text: `Not sure: I can see ${hint.description}. Follow the route on your phone, and stop safely if unsure.`,
      priority: "normal",
      routeGeneration: this.generation,
      step: this.step,
    }]
  }

  /**
   * After the glasses reconnect: show where things stand now. Marks already
   * passed are recorded as spoken so they are not read out late.
   */
  restore(latest: NavFeedUpdate, now: number): Effect[] {
    this.generation = -1
    this.step = -1
    this.spoken.clear()
    const d = latest.distanceToManeuverM
    const effects = this.update({...latest, distanceToManeuverM: undefined}, now)
    if (d !== undefined && this.current) {
      for (const t of this.thresholds) if (d <= t) this.spoken.add(t)
      this.current = {...latest}
      return [...effects.filter(e => e.kind !== "hud"), {kind: "hud", lines: this.hudLines(latest)}]
    }
    return effects
  }

  /** "Repeat that." The current instruction, if there is one. */
  repeat(): string {
    const u = this.current
    if (this.rerouting) return "Rerouting."
    if (!u) return "No active route."
    const d = u.distanceToManeuverM
    return d !== undefined ? `In ${formatDistance(d)}, ${instructionText(u)}.` : `${capitalise(instructionText(u))}.`
  }

  eta(now: number): string {
    const u = this.current
    if (!u || u.etaSeconds === undefined) return this.rerouting ? "Rerouting, no arrival time yet." : "No active route."
    const at = new Date(now + u.etaSeconds * 1000)
    const mins = Math.round(u.etaSeconds / 60)
    const hh = at.getHours() % 12 || 12
    const mm = at.getMinutes().toString().padStart(2, "0")
    return `${mins} minute${mins === 1 ? "" : "s"}, arriving about ${hh}:${mm} ${at.getHours() < 12 ? "am" : "pm"}.`
  }

  setMuted(m: boolean): void {
    this.muted = m
  }

  get isMuted(): boolean {
    return this.muted
  }

  get active(): boolean {
    return this.current !== null || this.rerouting
  }

  private gpsUnreliable(now: number): boolean {
    if (!this.lastFix) return false
    return this.lastFix.accuracyM > this.poorAccuracyM || now - this.lastFix.at > this.lostAfterMs
  }

  private hudLines(u: NavFeedUpdate): [string, string] {
    const m = u.maneuver ?? "unknown"
    const arrow = m === "roundabout" && u.roundaboutExit ? `O${u.roundaboutExit}` : ARROW[m]
    const dist = u.distanceToManeuverM !== undefined ? formatDistance(u.distanceToManeuverM) : ""
    const first = [arrow, dist].filter(Boolean).join(" ")
    const second = lanesText(u.lanes) || u.roadName || ""
    return [first, second]
  }
}

/**
 * Whether the wearer speaking may cut this prompt off. An imminent turn is
 * not interrupted by speech — only by a tap — because a cough must not
 * swallow "turn right now".
 */
export function interruptibleBySpeech(e: Extract<Effect, {kind: "speak"}>): boolean {
  return e.priority !== "imminent"
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
