/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {NavSession, parseNavCommand, type PlaceCandidate} from "../commands"
import {formatDistance, Guidance, interruptibleBySpeech, type Effect, type NavFeedUpdate} from "../guidance"

const T = 1_000_000
const upd = (over: Partial<NavFeedUpdate> = {}): NavFeedUpdate => ({
  state: "enroute",
  routeGeneration: 1,
  step: 3,
  maneuver: "turn_right",
  roadName: "MG Road",
  distanceToManeuverM: 1500,
  etaSeconds: 600,
  at: T,
  ...over,
})
const spoken = (es: Effect[]) => es.filter((e): e is Extract<Effect, {kind: "speak"}> => e.kind === "speak").map(e => e.text)
const hud = (es: Effect[]) => es.filter((e): e is Extract<Effect, {kind: "hud"}> => e.kind === "hud").map(e => e.lines)

describe("ANI-241: prompts at thresholds, once each", () => {
  test("far, near and now are each spoken once", () => {
    const g = new Guidance()
    expect(spoken(g.update(upd({distanceToManeuverM: 1500}), T))).toEqual([])
    expect(spoken(g.update(upd({distanceToManeuverM: 950}), T))).toEqual(["In 950 m, turn right onto MG Road."])
    expect(spoken(g.update(upd({distanceToManeuverM: 900}), T))).toEqual([])
    expect(spoken(g.update(upd({distanceToManeuverM: 180}), T))).toEqual(["In 200 m, turn right onto MG Road."])
    expect(spoken(g.update(upd({distanceToManeuverM: 25}), T))).toEqual(["Turn right onto MG Road now."])
    expect(spoken(g.update(upd({distanceToManeuverM: 10}), T))).toEqual([])
  })

  test("marks crossed together are not read out one after another", () => {
    const g = new Guidance()
    // A late update lands already inside the last mark.
    expect(spoken(g.update(upd({distanceToManeuverM: 20}), T))).toEqual(["Turn right onto MG Road now."])
  })

  test("the imminent prompt is not interruptible by speech", () => {
    const g = new Guidance()
    const [now] = g.update(upd({distanceToManeuverM: 20}), T).filter(e => e.kind === "speak") as Extract<Effect, {kind: "speak"}>[]
    expect(now.priority).toBe("imminent")
    expect(interruptibleBySpeech(now)).toBe(false)
  })

  test("a new step cancels the old step's prompts: the wearer acted", () => {
    const g = new Guidance()
    g.update(upd({distanceToManeuverM: 180}), T)
    const es = g.update(upd({step: 4, maneuver: "turn_left", roadName: "Brigade Road", distanceToManeuverM: 600}), T)
    expect(es[0]).toEqual({kind: "cancel_speech", olderThan: {routeGeneration: 1, step: 4}})
    expect(spoken(es)).toEqual(["In 600 m, turn left onto Brigade Road."])
  })

  test("HUD cues: arrow, distance, lanes or road", () => {
    const g = new Guidance()
    expect(hud(g.update(upd({distanceToManeuverM: 150}), T))[0]).toEqual(["-> 150 m", "MG Road"])
    expect(hud(g.update(upd({step: 4, maneuver: "roundabout", roundaboutExit: 2, lanes: [false, true], distanceToManeuverM: 80}), T))[0])
      .toEqual(["O2 80 m", "| ||^|"])
  })

  test("distance formatting", () => {
    expect(formatDistance(1540)).toBe("1.5 km")
    expect(formatDistance(230)).toBe("250 m")
    expect(formatDistance(3)).toBe("10 m")
  })
})

describe("ANI-241/243: nothing stale is ever spoken", () => {
  test("an update from an older step or route is ignored", () => {
    const g = new Guidance()
    g.update(upd({step: 4}), T)
    expect(g.update(upd({step: 3, distanceToManeuverM: 20}), T)).toEqual([])
    g.update(upd({routeGeneration: 2, step: 0}), T)
    expect(g.update(upd({routeGeneration: 1, step: 9, distanceToManeuverM: 20}), T)).toEqual([])
  })

  test("a missed turn: reroute clears the HUD, voids queued speech, and waits for the new route", () => {
    const g = new Guidance()
    g.update(upd({distanceToManeuverM: 180}), T)
    const rr = g.update(upd({state: "rerouting"}), T)
    expect(rr).toContainEqual({kind: "cancel_speech", olderThan: {routeGeneration: 2, step: 0}})
    expect(hud(rr)[0]).toEqual(["Rerouting...", ""])
    expect(spoken(rr)).toEqual(["Rerouting."])
    // A late update from the abandoned route, even one that looks fresh, is dropped.
    expect(g.update(upd({routeGeneration: 1, step: 3, distanceToManeuverM: 20}), T)).toEqual([])
    // Repeated rerouting updates do not repeat the announcement.
    expect(spoken(g.update(upd({state: "rerouting"}), T))).toEqual([])
    // The corrected maneuver on the new route.
    const next = g.update(upd({routeGeneration: 2, step: 0, maneuver: "u_turn", roadName: undefined, distanceToManeuverM: 150}), T)
    expect(spoken(next)).toEqual(["In 150 m, make a U-turn."])
  })

  test("trip cancelled: everything is cleared and nothing more is said", () => {
    const g = new Guidance()
    g.update(upd(), T)
    const es = g.update(upd({state: "stopped"}), T)
    expect(es).toEqual([{kind: "cancel_speech", olderThan: {routeGeneration: Infinity, step: Infinity}}, {kind: "hud_clear"}])
    expect(g.update(upd({distanceToManeuverM: 20}), T)).toEqual([])
    expect(g.repeat()).toBe("No active route.")
  })

  test("a feed update that arrives too late is not current guidance", () => {
    const g = new Guidance()
    expect(g.update(upd({at: T - 6000, distanceToManeuverM: 20}), T)).toEqual([])
  })

  test("duplicated feed events speak once", () => {
    const g = new Guidance()
    const u = upd({distanceToManeuverM: 20})
    expect(spoken(g.update(u, T)).length).toBe(1)
    expect(spoken(g.update(u, T)).length).toBe(0)
  })

  test("reconnect restores the current step without replaying passed prompts", () => {
    const g = new Guidance()
    g.update(upd({distanceToManeuverM: 900}), T)
    // Disconnected while the car moved to 150 m; the 200 m mark was crossed unseen.
    const es = g.restore(upd({distanceToManeuverM: 150}), T)
    expect(spoken(es)).toEqual([])
    expect(hud(es)).toEqual([["-> 150 m", "MG Road"]])
    // The next mark still fires.
    expect(spoken(g.update(upd({distanceToManeuverM: 25}), T))).toEqual(["Turn right onto MG Road now."])
  })
})

describe("ANI-243: GPS drift and the camera", () => {
  test("a poor fix warns once, and suppresses the distance-based 'now'", () => {
    const g = new Guidance()
    g.update(upd({distanceToManeuverM: 180}), T)
    expect(spoken(g.position({accuracyM: 120, at: T}, T))).toEqual(["GPS signal is weak. Check your phone before turning."])
    expect(spoken(g.position({accuracyM: 130, at: T}, T))).toEqual([])
    expect(spoken(g.update(upd({distanceToManeuverM: 20}), T))).toEqual([])
    // Recovered: the warning can fire again later, and prompts resume.
    g.position({accuracyM: 8, at: T}, T)
    expect(spoken(g.update(upd({distanceToManeuverM: 15}), T))).toEqual(["Turn right onto MG Road now."])
  })

  test("a lost fix (tunnel) counts as unreliable", () => {
    const g = new Guidance()
    g.update(upd({distanceToManeuverM: 180}), T)
    g.position({accuracyM: 5, at: T}, T)
    expect(spoken(g.position(null, T + 10_001))).toEqual(["GPS signal is weak. Check your phone before turning."])
  })

  test("the camera can raise a doubt but never change the instruction", () => {
    const g = new Guidance()
    g.update(upd({distanceToManeuverM: 180}), T)
    expect(g.camera({routeGeneration: 1, step: 3, verdict: "agrees", description: "a right turn sign"})).toEqual([])
    const doubt = g.camera({routeGeneration: 1, step: 3, verdict: "conflicts", description: "a no right turn sign"})
    expect(spoken(doubt)[0]).toContain("Not sure: I can see a no right turn sign")
    expect(doubt.every(e => e.kind === "speak")).toBe(true)
    expect(g.repeat()).toBe("In 200 m, turn right onto MG Road.")
    // A hint about another step is ignored.
    expect(g.camera({routeGeneration: 1, step: 2, verdict: "conflicts", description: "x"})).toEqual([])
  })
})

describe("ANI-242: spoken commands are a closed, typed set", () => {
  test("each control parses", () => {
    expect(parseNavCommand("Navigate to MG Road")).toEqual({kind: "start", query: "MG Road"})
    expect(parseNavCommand("take me to Cubbon Park.")).toEqual({kind: "start", query: "Cubbon Park"})
    expect(parseNavCommand("how do I get to the airport?")).toEqual({kind: "start", query: "the airport"})
    expect(parseNavCommand("repeat that")).toEqual({kind: "repeat"})
    expect(parseNavCommand("what's next")).toEqual({kind: "next_step"})
    expect(parseNavCommand("how long left")).toEqual({kind: "eta"})
    expect(parseNavCommand("mute navigation")).toEqual({kind: "mute"})
    expect(parseNavCommand("unmute")).toEqual({kind: "unmute"})
    expect(parseNavCommand("pause navigation")).toEqual({kind: "pause"})
    expect(parseNavCommand("resume navigation")).toEqual({kind: "resume"})
    expect(parseNavCommand("cancel navigation")).toEqual({kind: "cancel"})
    expect(parseNavCommand("the second one")).toEqual({kind: "choose", index: 2})
  })

  test("anything else is not a navigation command", () => {
    expect(parseNavCommand("what's the weather")).toBeNull()
    expect(parseNavCommand("stop")).toBeNull()
    expect(parseNavCommand("navigate to https://evil.example")).toBeNull()
    expect(parseNavCommand("navigate to <script>")).toBeNull()
    expect(parseNavCommand("navigate to " + "x".repeat(200))).toBeNull()
  })
})

describe("ANI-242: the navigation session", () => {
  const mg: PlaceCandidate = {id: "p1", name: "MG Road Metro", detail: "MG Road, Bengaluru"}
  const mgMall: PlaceCandidate = {id: "p2", name: "MG Road Mall", detail: "Gurugram"}
  const airport: PlaceCandidate = {id: "p3", name: "Kempegowda Airport", detail: "Devanahalli"}

  test("one result starts the route", async () => {
    const s = new NavSession()
    const r = await s.handle({kind: "start", query: "MG Road"}, async () => [mg])
    expect(r).toEqual({kind: "start_route", place: mg, text: "Starting route to MG Road Metro, MG Road, Bengaluru."})
  })

  test("ambiguity is read back and resolved before anything starts", async () => {
    const s = new NavSession()
    const r = await s.handle({kind: "start", query: "MG Road"}, async () => [mg, mgMall])
    expect(r).toEqual({kind: "say", text: "I found 2. 1, MG Road Metro, MG Road, Bengaluru. 2, MG Road Mall, Gurugram. Which one?"})
    expect(s.activeDestination).toBeNull()
    expect(await s.handle({kind: "choose", index: 3}, async () => [])).toEqual({kind: "say", text: "There are only 2. Which one?"})
    expect((await s.handle({kind: "choose", index: 2}, async () => [])).kind).toBe("start_route")
    expect(s.activeDestination).toEqual(mgMall)
  })

  test("replacing an active destination needs a yes", async () => {
    const s = new NavSession()
    await s.handle({kind: "start", query: "MG Road"}, async () => [mg])
    const r = await s.handle({kind: "start", query: "airport"}, async () => [airport])
    expect(r.kind).toBe("say")
    expect(s.awaitingConfirmation).toBe(true)
    expect(s.confirmReplace("no keep going")).toEqual({kind: "say", text: "Keeping the route to MG Road Metro."})
    expect(s.activeDestination).toEqual(mg)

    await s.handle({kind: "start", query: "airport"}, async () => [airport])
    expect(s.confirmReplace("yes")).toEqual({kind: "start_route", place: airport, text: "Going to Kempegowda Airport instead."})
  })

  test("search failures and no results say so plainly", async () => {
    const s = new NavSession()
    expect(await s.handle({kind: "start", query: "x"}, async () => {
      throw new Error("offline")
    })).toEqual({kind: "say", text: "Can't search for places right now. Try again, or start the route on your phone."})
    expect(await s.handle({kind: "start", query: "Atlantis"}, async () => [])).toEqual({kind: "say", text: "I couldn't find Atlantis. Try saying it another way."})
  })

  test("cancel ends the route and forgets the destination", async () => {
    const s = new NavSession()
    expect(await s.handle({kind: "cancel"}, async () => [])).toEqual({kind: "say", text: "No active route."})
    await s.handle({kind: "start", query: "MG Road"}, async () => [mg])
    expect(await s.handle({kind: "cancel"}, async () => [])).toEqual({kind: "sdk", command: "cancel", text: "Navigation cancelled."})
    expect(s.activeDestination).toBeNull()
  })

  test("mute and repeat go to guidance, not the SDK", async () => {
    const s = new NavSession()
    expect(await s.handle({kind: "mute"}, async () => [])).toEqual({kind: "guidance", command: "mute"})
    const g = new Guidance()
    g.setMuted(true)
    expect(spoken(g.update(upd({distanceToManeuverM: 20}), T))).toEqual([])
    expect(g.eta(T)).toContain("10 minutes")
  })
})
