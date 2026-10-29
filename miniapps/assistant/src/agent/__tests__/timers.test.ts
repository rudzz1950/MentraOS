import {describe, expect, test} from "bun:test"

import {TimerStore, formatDuration, parseAlarmTime, parseDuration, parseLabel} from "../timers"

class FakeClock {
  constructor(public t = new Date("2026-10-29T14:00:00+05:30").getTime()) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

const MIN = 60_000
const HOUR = 3_600_000

describe("parsing durations", () => {
  test("digits and units", () => {
    expect(parseDuration("set a timer for 10 minutes")).toBe(10 * MIN)
    expect(parseDuration("90 seconds")).toBe(90_000)
    expect(parseDuration("2 hours")).toBe(2 * HOUR)
  })

  test("words", () => {
    expect(parseDuration("ten minutes")).toBe(10 * MIN)
    expect(parseDuration("a minute")).toBe(MIN)
    expect(parseDuration("an hour")).toBe(HOUR)
  })

  test("compound", () => {
    expect(parseDuration("1 hour 30 minutes")).toBe(90 * MIN)
    expect(parseDuration("2 hours 15 mins")).toBe(135 * MIN)
  })

  test("halves, which people actually say", () => {
    expect(parseDuration("an hour and a half")).toBe(90 * MIN)
    expect(parseDuration("half an hour")).toBe(30 * MIN)
  })

  test("refuses rather than guessing", () => {
    // A timer set for the wrong duration is worse than one not set, because
    // the wearer believes it is running.
    expect(parseDuration("set a timer")).toBeNull()
    expect(parseDuration("a while")).toBeNull()
    expect(parseDuration("for the pasta")).toBeNull()
    expect(parseDuration("0 minutes")).toBeNull()
  })
})

describe("parsing alarm times", () => {
  const now = new Date("2026-10-29T14:00:00+05:30").getTime()

  test("later today", () => {
    const ms = parseAlarmTime("set an alarm for 6pm", now)
    expect(ms).toBe(4 * HOUR)
  })

  test("rolls to tomorrow when already past", () => {
    const ms = parseAlarmTime("set an alarm for 7am", now)
    expect(ms).toBe(17 * HOUR)
  })

  test("with minutes", () => {
    expect(parseAlarmTime("alarm for 6:30 pm", now)).toBe(4 * HOUR + 30 * MIN)
  })

  test("midnight and noon", () => {
    expect(parseAlarmTime("alarm for 12am", now)).toBe(10 * HOUR)
    expect(parseAlarmTime("alarm for 12pm", now)).toBe(22 * HOUR)
  })

  test("refuses nonsense", () => {
    expect(parseAlarmTime("alarm for 25pm", now)).toBeNull()
    expect(parseAlarmTime("alarm for 6:99 pm", now)).toBeNull()
    expect(parseAlarmTime("set an alarm", now)).toBeNull()
  })
})

describe("labels", () => {
  test("a named timer", () => {
    expect(parseLabel("set a timer for the pasta")).toBe("pasta")
    expect(parseLabel("timer for my laundry")).toBe("laundry")
  })

  test("a duration is not a label", () => {
    expect(parseLabel("set a timer for 10 minutes")).toBeUndefined()
    expect(parseLabel("timer for ten minutes")).toBeUndefined()
    expect(parseLabel("timer for an hour")).toBeUndefined()
  })
})

describe("setting them", () => {
  test("a timer, answered without a model", () => {
    const clock = new FakeClock()
    const s = new TimerStore(clock)
    expect(s.handle("set a timer for 10 minutes")).toBe("Timer set for 10 minutes.")
    expect(s.active().length).toBe(1)
  })

  test("a named timer says the name back", () => {
    const s = new TimerStore(new FakeClock())
    expect(s.handle("set a timer for the pasta for 8 minutes")).toContain("pasta")
  })

  test("an alarm", () => {
    const s = new TimerStore(new FakeClock())
    expect(s.handle("set an alarm for 6pm")).toBe("Alarm set for 6:00 pm.")
  })

  test("asks instead of guessing when the duration is missing", () => {
    const s = new TimerStore(new FakeClock())
    expect(s.handle("set a timer")).toBe("How long should the timer be?")
    expect(s.active().length).toBe(0)
  })

  test("asks instead of guessing when the alarm time is missing", () => {
    const s = new TimerStore(new FakeClock())
    expect(s.handle("set an alarm")).toBe("What time should the alarm be?")
    expect(s.active().length).toBe(0)
  })

  test("returns null for anything that is not a timer, so a model gets it", () => {
    const s = new TimerStore(new FakeClock())
    expect(s.handle("what is the capital of Karnataka")).toBeNull()
    expect(s.handle("send a message to Tanu")).toBeNull()
  })
})

describe("firing", () => {
  test("nothing is due before its time", () => {
    const clock = new FakeClock()
    const s = new TimerStore(clock)
    s.handle("set a timer for 10 minutes")
    clock.advance(9 * MIN)
    expect(s.due()).toEqual([])
  })

  test("due once the time passes, and only once", () => {
    const clock = new FakeClock()
    const s = new TimerStore(clock)
    s.handle("set a timer for 10 minutes")
    clock.advance(10 * MIN)
    expect(s.due().length).toBe(1)
    expect(s.due()).toEqual([])
  })

  test("says when the next one is, so the caller sets one timer", () => {
    const clock = new FakeClock()
    const s = new TimerStore(clock)
    expect(s.nextDueAt()).toBeNull()
    s.handle("set a timer for 10 minutes")
    s.handle("set a timer for 2 minutes")
    expect(s.nextDueAt()).toBe(clock.now() + 2 * MIN)
  })

  test("several fire together when the clock jumps, which it does on a phone", () => {
    const clock = new FakeClock()
    const s = new TimerStore(clock)
    s.handle("set a timer for 1 minute")
    s.handle("set a timer for 2 minutes")
    clock.advance(5 * MIN)
    expect(s.due().length).toBe(2)
  })
})

describe("asking about them", () => {
  test("how long is left", () => {
    const clock = new FakeClock()
    const s = new TimerStore(clock)
    s.handle("set a timer for 10 minutes")
    clock.advance(3 * MIN)
    expect(s.handle("how long is left")).toBe("7 minutes left.")
  })

  test("with nothing running", () => {
    const s = new TimerStore(new FakeClock())
    expect(s.handle("how much time is left")).toBe("No timers running.")
  })

  test("listing them", () => {
    const s = new TimerStore(new FakeClock())
    s.handle("set a timer for the pasta for 8 minutes")
    s.handle("set an alarm for 6pm")
    const listed = s.handle("what timers do I have")!
    expect(listed).toContain("pasta")
    expect(listed).toContain("6:00 pm")
  })
})

describe("cancelling", () => {
  test("the only one", () => {
    const s = new TimerStore(new FakeClock())
    s.handle("set a timer for 10 minutes")
    expect(s.handle("cancel the timer")).toBe("Cancelled.")
    expect(s.active().length).toBe(0)
  })

  test("by name", () => {
    const s = new TimerStore(new FakeClock())
    s.handle("set a timer for the pasta for 8 minutes")
    s.handle("set a timer for 20 minutes")
    expect(s.handle("cancel the pasta timer")).toContain("pasta")
    expect(s.active().length).toBe(1)
  })

  test("all of them, when asked", () => {
    const s = new TimerStore(new FakeClock())
    s.handle("set a timer for 10 minutes")
    s.handle("set a timer for 20 minutes")
    expect(s.handle("cancel all timers")).toBe("Cancelled all of them.")
    expect(s.active().length).toBe(0)
  })

  test("asks which one rather than picking, when it cannot tell", () => {
    const s = new TimerStore(new FakeClock())
    s.handle("set a timer for 10 minutes")
    s.handle("set a timer for 20 minutes")
    const reply = s.handle("cancel the timer")!
    expect(reply).toContain("Which one")
    // Nothing was cancelled on a guess.
    expect(s.active().length).toBe(2)
  })

  test("with nothing to cancel", () => {
    const s = new TimerStore(new FakeClock())
    expect(s.handle("cancel the timer")).toBe("Nothing to cancel.")
  })
})

describe("formatting", () => {
  test("reads the way a person would say it", () => {
    expect(formatDuration(10 * MIN)).toBe("10 minutes")
    expect(formatDuration(MIN)).toBe("1 minute")
    expect(formatDuration(90 * MIN)).toBe("1 hour 30 minutes")
    expect(formatDuration(45_000)).toBe("45 seconds")
  })

  test("drops seconds once there are hours, because nobody wants them", () => {
    expect(formatDuration(HOUR + 30 * MIN + 12_000)).toBe("1 hour 30 minutes")
  })

  test("never goes negative", () => {
    expect(formatDuration(-5000)).toBe("0 seconds")
  })
})
