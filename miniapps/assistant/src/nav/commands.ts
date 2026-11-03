/**
 * @fileoverview Spoken navigation commands, as a closed set of typed values. ANI-242.
 *
 * Speech becomes one of these or nothing. There is no path from a model's
 * output to a Navigation SDK call: the SDK adapter accepts a
 * NavigationCommand, and NavigationCommand can only be built by `parseNavCommand`
 * from the wearer's own addressed utterance. "Natural language cannot cause an
 * unapproved route change" holds because natural language never reaches the
 * route; a parsed, confirmed command does.
 *
 * Starting a route when one is active REPLACES the destination, which is
 * consequential, so it is proposed and confirmed rather than executed. An
 * ambiguous place search is read back as a numbered list and the wearer picks
 * one; nothing starts until they do.
 */

export type NavigationCommand =
  | {kind: "start"; query: string}
  | {kind: "repeat"}
  | {kind: "next_step"}
  | {kind: "eta"}
  | {kind: "mute"}
  | {kind: "unmute"}
  | {kind: "pause"}
  | {kind: "resume"}
  | {kind: "cancel"}
  | {kind: "choose"; index: number}

const ORDINALS: Record<string, number> = {
  first: 1, one: 1, "1": 1, "1st": 1,
  second: 2, two: 2, "2": 2, "2nd": 2,
  third: 3, three: 3, "3": 3, "3rd": 3,
  fourth: 4, four: 4, "4": 4, "4th": 4,
  fifth: 5, five: 5, "5": 5, "5th": 5,
}

/** A destination query: words only, bounded, nothing that looks like markup or a link. */
function cleanQuery(q: string): string | null {
  const s = q.replace(/[.?!,]+$/g, "").trim()
  if (s.length < 2 || s.length > 120) return null
  if (/[<>{}\[\]`]|:\/\//.test(s)) return null
  return s
}

/**
 * Parse one addressed utterance. Returns null for anything that is not
 * clearly a navigation command, so it falls through to the assistant.
 */
export function parseNavCommand(text: string): NavigationCommand | null {
  // Case is kept for the query ("MG Road"), so match case-insensitively on
  // the normalised text rather than on a lower-cased copy.
  const said = text.trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "")
  const t = said.toLowerCase()

  const start = said.match(/^(?:navigate|directions|take me|get me|drive me|route me|guide me|start navigation)\s+(?:to\s+|me to\s+)?(.+)$/i)
    ?? said.match(/^(?:how do i get|how do i go)\s+to\s+(.+)$/i)
  if (start) {
    const q = cleanQuery(start[1])
    return q ? {kind: "start", query: q} : null
  }

  if (/^(?:repeat|say (?:that|it) again|what was that|come again)( that)?$/.test(t)) return {kind: "repeat"}
  if (/^(?:what'?s|what is) (?:the )?next( (?:turn|step))?$|^next (?:turn|step)$/.test(t)) return {kind: "next_step"}
  if (/^(?:eta|when (?:will|do) (?:i|we) (?:get there|arrive)|how (?:long|far)(?: is it| to go)?( left)?|what'?s (?:my|the) eta)$/.test(t)) return {kind: "eta"}
  if (/^(?:mute|quiet|stop talking|silence)(?: (?:navigation|directions|guidance))?$/.test(t)) return {kind: "mute"}
  if (/^(?:unmute|resume voice|talk again)(?: (?:navigation|directions|guidance))?$/.test(t)) return {kind: "unmute"}
  if (/^pause (?:navigation|directions|guidance|the route)$/.test(t)) return {kind: "pause"}
  if (/^(?:resume|continue) (?:navigation|directions|guidance|the route)$/.test(t)) return {kind: "resume"}
  if (/^(?:cancel|stop|end|exit|quit) (?:navigation|directions|guidance|the route|route)$/.test(t)) return {kind: "cancel"}

  const choose = t.match(/^(?:the |number |option )?(first|second|third|fourth|fifth|one|two|three|four|five|[1-5](?:st|nd|rd|th)?)(?: one| option)?$/)
  if (choose) return {kind: "choose", index: ORDINALS[choose[1]]}
  return null
}

export interface PlaceCandidate {
  id: string
  name: string
  /** Short address or locality, to tell same-named places apart. */
  detail: string
}

export type SessionReply =
  | {kind: "say"; text: string}
  /** Ask the SDK adapter to start a route to this place. The only way a route starts. */
  | {kind: "start_route"; place: PlaceCandidate; text: string}
  | {kind: "sdk"; command: "pause" | "resume" | "cancel"; text: string}
  | {kind: "guidance"; command: "repeat" | "next_step" | "eta" | "mute" | "unmute"}

/**
 * The navigation part of the session: the destination, what is being chosen
 * between, and what is waiting on a yes. Ends, and forgets, with the route.
 */
export class NavSession {
  private destination: PlaceCandidate | null = null
  private choices: PlaceCandidate[] | null = null
  private pendingReplace: PlaceCandidate | null = null

  get activeDestination(): PlaceCandidate | null {
    return this.destination
  }

  /**
   * Handle a parsed command. `search` resolves a query to candidates through
   * the Places adapter; it is injected, and may throw when offline.
   */
  async handle(cmd: NavigationCommand, search: (q: string) => Promise<PlaceCandidate[]>): Promise<SessionReply> {
    switch (cmd.kind) {
      case "start": {
        let found: PlaceCandidate[]
        try {
          found = await search(cmd.query)
        } catch {
          return {kind: "say", text: "Can't search for places right now. Try again, or start the route on your phone."}
        }
        if (found.length === 0) return {kind: "say", text: `I couldn't find ${cmd.query}. Try saying it another way.`}
        if (found.length === 1) return this.propose(found[0])
        this.choices = found.slice(0, 5)
        const list = this.choices.map((c, i) => `${i + 1}, ${c.name}, ${c.detail}`).join(". ")
        return {kind: "say", text: `I found ${this.choices.length}. ${list}. Which one?`}
      }
      case "choose": {
        if (!this.choices) return {kind: "say", text: "There's nothing to choose from."}
        const pick = this.choices[cmd.index - 1]
        if (!pick) return {kind: "say", text: `There are only ${this.choices.length}. Which one?`}
        this.choices = null
        return this.propose(pick)
      }
      case "pause":
      case "resume":
        if (!this.destination) return {kind: "say", text: "No active route."}
        return {kind: "sdk", command: cmd.kind, text: cmd.kind === "pause" ? "Navigation paused." : "Navigation resumed."}
      case "cancel":
        if (!this.destination) return {kind: "say", text: "No active route."}
        this.end()
        return {kind: "sdk", command: "cancel", text: "Navigation cancelled."}
      default:
        return {kind: "guidance", command: cmd.kind}
    }
  }

  /**
   * The wearer's yes or no to replacing the active destination. Only a clear
   * yes replaces it; anything else keeps the current route.
   */
  confirmReplace(answer: string): SessionReply {
    const p = this.pendingReplace
    if (!p) return {kind: "say", text: "Nothing to confirm."}
    this.pendingReplace = null
    if (/^\s*(yes|yeah|yep|haan|ha|confirm|do it|go ahead|replace it)\b/i.test(answer)) {
      this.destination = p
      return {kind: "start_route", place: p, text: `Going to ${p.name} instead.`}
    }
    return {kind: "say", text: `Keeping the route to ${this.destination?.name ?? "your destination"}.`}
  }

  get awaitingConfirmation(): boolean {
    return this.pendingReplace !== null
  }

  /** The trip ended or was cancelled: forget the destination and any pending choice. */
  end(): void {
    this.destination = null
    this.choices = null
    this.pendingReplace = null
  }

  private propose(place: PlaceCandidate): SessionReply {
    if (this.destination && this.destination.id !== place.id) {
      this.pendingReplace = place
      return {kind: "say", text: `You're going to ${this.destination.name}. Replace it with ${place.name}? Say yes to change.`}
    }
    this.destination = place
    return {kind: "start_route", place, text: `Starting route to ${place.name}, ${place.detail}.`}
  }
}
