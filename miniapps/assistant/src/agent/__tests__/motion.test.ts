import {describe, expect, test} from "bun:test"

import * as cards from "../../hud/cards"
import {STANDIN_OLED} from "../../hud/panel"
import {MotionState, stillOrWalking, type PassengerPolicy} from "../motion"

class FakeClock {
  constructor(public t = 1_000_000) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

function setup(policy: PassengerPolicy = "assume_driver") {
  const clock = new FakeClock()
  const m = new MotionState({clock, policy, enterMs: 3000, exitMs: 60_000})
  return {clock, m}
}

/** Hold a speed for a duration, sampling once a second. */
function driveAt(m: MotionState, clock: FakeClock, mps: number, ms: number) {
  for (let t = 0; t < ms; t += 1000) {
    m.onSpeed({speedMps: mps, accuracyM: 5})
    clock.advance(1000)
    m.tick()
  }
}

describe("entering and leaving a vehicle", () => {
  test("a sustained speed enters the vehicle state", () => {
    const {clock, m} = setup()
    expect(m.vehicle).toBe(false)
    driveAt(m, clock, 15, 4000)
    expect(m.vehicle).toBe(true)
    expect(m.driving()).toBe(true)
  })

  test("a brief burst of speed does not", () => {
    const {clock, m} = setup()
    driveAt(m, clock, 15, 2000)
    expect(m.vehicle).toBe(false)
  })

  test("walking pace is not a vehicle", () => {
    const {clock, m} = setup()
    driveAt(m, clock, 1.4, 30_000)
    expect(m.vehicle).toBe(false)
  })

  test("leaving takes much longer than entering, so lights do not flicker it", () => {
    const {clock, m} = setup()
    driveAt(m, clock, 15, 4000)
    expect(m.vehicle).toBe(true)

    // Stopped at a light for 45 seconds.
    driveAt(m, clock, 0, 45_000)
    expect(m.vehicle).toBe(true)
    expect(m.driving()).toBe(true)

    // Moving again; the pending exit is abandoned.
    driveAt(m, clock, 15, 5000)
    expect(m.vehicle).toBe(true)
  })

  test("but it does leave once the wearer has really stopped", () => {
    const {clock, m} = setup()
    driveAt(m, clock, 15, 4000)
    driveAt(m, clock, 0, 65_000)
    expect(m.vehicle).toBe(false)
    expect(m.driving()).toBe(false)
  })

  test("stop-start traffic stays in the vehicle state throughout", () => {
    const {clock, m} = setup()
    driveAt(m, clock, 15, 4000)
    for (let i = 0; i < 10; i++) {
      driveAt(m, clock, 0, 20_000)
      driveAt(m, clock, 12, 10_000)
    }
    expect(m.vehicle).toBe(true)
  })
})

describe("platform activity recognition", () => {
  test("automotive with confidence enters the vehicle state", () => {
    const {clock, m} = setup()
    m.onActivity({activity: "automotive", confidence: 90})
    clock.advance(4000)
    m.onActivity({activity: "automotive", confidence: 90})
    expect(m.vehicle).toBe(true)
  })

  test("a low-confidence report is ignored entirely", () => {
    const {clock, m} = setup()
    for (let i = 0; i < 10; i++) {
      m.onActivity({activity: "automotive", confidence: 20})
      clock.advance(1000)
      m.tick()
    }
    expect(m.vehicle).toBe(false)
    expect(m.sensing).toBe(false)
  })

  test("walking is not a vehicle", () => {
    const {clock, m} = setup()
    for (let i = 0; i < 10; i++) {
      m.onActivity({activity: "walking", confidence: 95})
      clock.advance(1000)
      m.tick()
    }
    expect(m.vehicle).toBe(false)
    expect(m.activity).toBe("walking")
  })

  test("cycling is not treated as driving", () => {
    const {clock, m} = setup()
    for (let i = 0; i < 20; i++) {
      m.onActivity({activity: "cycling", confidence: 95})
      clock.advance(1000)
      m.tick()
    }
    expect(m.driving()).toBe(false)
    expect(m.activity).toBe("cycling")
  })
})

describe("a bad GPS fix is not evidence", () => {
  test("a wildly inaccurate fix is ignored", () => {
    const {clock, m} = setup()
    for (let i = 0; i < 10; i++) {
      m.onSpeed({speedMps: 30, accuracyM: 500})
      clock.advance(1000)
      m.tick()
    }
    expect(m.vehicle).toBe(false)
    expect(m.sensing).toBe(false)
  })

  test("nonsense values are ignored", () => {
    const {m} = setup()
    m.onSpeed({speedMps: Number.NaN})
    m.onSpeed({speedMps: -5})
    expect(m.sensing).toBe(false)
  })

  test("a fix with no accuracy field is still used", () => {
    const {clock, m} = setup()
    driveAt(m, clock, 20, 4000)
    expect(m.sensing).toBe(true)
  })
})

describe("the passenger policy", () => {
  test("assume_driver treats any vehicle as driving", () => {
    const {clock, m} = setup("assume_driver")
    driveAt(m, clock, 15, 4000)
    expect(m.driving()).toBe(true)
    expect(m.needsAsking).toBe(false)
  })

  test("ask_once treats them as the driver until they say otherwise", () => {
    const {clock, m} = setup("ask_once")
    driveAt(m, clock, 15, 4000)
    expect(m.needsAsking).toBe(true)
    expect(m.driving()).toBe(true) // safe while unanswered

    m.answerForThisTrip(false) // "I'm a passenger"
    expect(m.needsAsking).toBe(false)
    expect(m.driving()).toBe(false)
  })

  test("ask_once asks again on the next trip", () => {
    const {clock, m} = setup("ask_once")
    driveAt(m, clock, 15, 4000)
    m.answerForThisTrip(false)
    expect(m.driving()).toBe(false)

    // Trip ends.
    driveAt(m, clock, 0, 65_000)
    expect(m.vehicle).toBe(false)

    // A new trip: the old answer must not carry over.
    driveAt(m, clock, 15, 4000)
    expect(m.needsAsking).toBe(true)
    expect(m.driving()).toBe(true)
  })

  test("confirming they are the driver keeps it on without asking again", () => {
    const {clock, m} = setup("ask_once")
    driveAt(m, clock, 15, 4000)
    m.answerForThisTrip(true)
    expect(m.needsAsking).toBe(false)
    expect(m.driving()).toBe(true)
  })

  test("manual_only never infers", () => {
    const {clock, m} = setup("manual_only")
    driveAt(m, clock, 30, 60_000)
    expect(m.vehicle).toBe(true) // it still knows
    expect(m.driving()).toBe(false) // but will not act on it
  })
})

describe("the wearer's own switch wins", () => {
  test("manual on overrides the sensors", () => {
    const {m} = setup()
    m.setManual(true)
    expect(m.driving()).toBe(true)
  })

  test("manual off overrides a detected vehicle", () => {
    const {clock, m} = setup()
    driveAt(m, clock, 15, 4000)
    expect(m.driving()).toBe(true)
    m.setManual(false)
    expect(m.driving()).toBe(false)
  })

  test("clearing it hands control back to the sensors", () => {
    const {clock, m} = setup()
    driveAt(m, clock, 15, 4000)
    m.setManual(false)
    expect(m.driving()).toBe(false)
    m.setManual(null)
    expect(m.driving()).toBe(true)
  })

  test("manual_only is driven entirely by the switch", () => {
    const {m} = setup("manual_only")
    expect(m.driving()).toBe(false)
    m.setManual(true)
    expect(m.driving()).toBe(true)
  })
})

describe("when nothing is feeding it", () => {
  test("it reports that it is not sensing, rather than implying safety", () => {
    const {m} = setup()
    expect(m.sensing).toBe(false)
    expect(m.driving()).toBe(false)
  })

  test("a manual setting counts as sensing", () => {
    const {m} = setup()
    m.setManual(true)
    expect(m.sensing).toBe(true)
  })
})

describe("attaching to whatever the platform offers", () => {
  test("uses speed alone when there is no activity binding", () => {
    const {clock, m} = setup()
    let emit: ((s: {speedMps: number}) => void) | null = null
    const off = m.attach({
      onSpeed(h) {
        emit = h
        return () => {}
      },
    })
    expect(emit).not.toBeNull()
    for (let i = 0; i < 5; i++) {
      emit!({speedMps: 15})
      clock.advance(1000)
      m.tick()
    }
    expect(m.vehicle).toBe(true)
    off()
  })

  test("unsubscribes both sources", () => {
    const {m} = setup()
    let activityOff = 0
    let speedOff = 0
    const off = m.attach({
      onActivity: () => () => activityOff++,
      onSpeed: () => () => speedOff++,
    })
    off()
    expect(activityOff).toBe(1)
    expect(speedOff).toBe(1)
  })

  test("attaching an empty source is harmless", () => {
    const {m} = setup()
    expect(() => m.attach({})()).not.toThrow()
  })
})

describe("still versus walking is all an IMU can honestly say", () => {
  test("a seated wearer reads still", () => {
    const quiet = Array.from({length: 50}, (_, i) => 1.0 + 0.01 * Math.sin(i))
    expect(stillOrWalking(quiet)).toBe("still")
  })

  test("a stride reads walking", () => {
    const stride = Array.from({length: 50}, (_, i) => 1.0 + 0.9 * Math.sin(i * 0.5))
    expect(stillOrWalking(stride)).toBe("walking")
  })

  test("too few samples is unknown rather than a guess", () => {
    expect(stillOrWalking([1, 1, 1])).toBe("unknown")
    expect(stillOrWalking([])).toBe("unknown")
  })

  test("a smooth car ride is indistinguishable from sitting — which is the point", () => {
    // This is why driving is NOT inferred from the IMU. A car on a good road
    // looks exactly like a chair, so this correctly says "still", and the
    // module never uses it to answer the driving question.
    const smoothRide = Array.from({length: 50}, (_, i) => 1.0 + 0.02 * Math.sin(i * 3))
    expect(stillOrWalking(smoothRide)).toBe("still")
  })
})

describe("it actually closes the dead-code gap", () => {
  test("the card gate reduces a message once motion says driving", () => {
    const {clock, m} = setup()
    const ctx = {panel: STANDIN_OLED}
    const card = cards.message("Amma", "Are you coming home for dinner tonight?", ctx)

    // Parked: the body shows.
    expect(cards.gate(card, m.driving())!.rows.join(" ")).toContain("dinner")

    // Driving: the body is gone, the sender stays.
    driveAt(m, clock, 15, 4000)
    const reduced = cards.gate(card, m.driving())!
    expect(reduced.rows.join(" ")).not.toContain("dinner")
    expect(reduced.rows).toContain("Amma")
  })

  test("and suppresses the assistant's own answer", () => {
    const {clock, m} = setup()
    const answer = cards.answer("Twenty-eight degrees and overcast.", {panel: STANDIN_OLED})
    expect(cards.gate(answer, m.driving())).not.toBeNull()
    driveAt(m, clock, 15, 4000)
    expect(cards.gate(answer, m.driving())).toBeNull()
  })
})
