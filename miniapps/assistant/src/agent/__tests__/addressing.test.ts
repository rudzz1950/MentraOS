import {describe, expect, test} from "bun:test"

import {Addressing} from "../addressing"

class FakeClock {
  constructor(public t = 1_000_000) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

function setup(over: Partial<Parameters<typeof Addressing.prototype.constructor>[0]> = {}) {
  const clock = new FakeClock()
  const a = new Addressing({clock, windowMs: 8000, followUpMs: 5000, ...(over as object)} as never)
  return {clock, a}
}

describe("nothing is addressed without a way in", () => {
  test("speech with no wake and no tap is ignored", () => {
    const {a} = setup()
    expect(a.consider("send her the deck")).toBe("not_addressed")
    expect(a.isOpen()).toBe(false)
  })

  test("which is what the router was always relying on", () => {
    // classify(text, false) returns "not_for_me" — but nothing used to produce
    // that false. This is the piece that was missing.
    const {a} = setup()
    expect(a.isAddressed("what time is the meeting")).toBe(false)
  })
})

describe("the wake word", () => {
  test("opens the floor", () => {
    const {a} = setup()
    expect(a.wake()).toBe(true)
    expect(a.consider("what is the weather")).toBe("wake")
  })

  test("the window expires", () => {
    const {clock, a} = setup()
    a.wake()
    clock.advance(8001)
    expect(a.consider("what is the weather")).toBe("not_addressed")
  })

  test("speaking twice does not get two answers", () => {
    const {a} = setup()
    a.wake()
    expect(a.consider("what is the weather")).toBe("wake")
    expect(a.consider("and the traffic")).toBe("not_addressed")
  })

  test("saying the keyword again does not reset the wearer's own clock", () => {
    const {clock, a} = setup()
    a.wake()
    clock.advance(5000)
    a.wake()
    clock.advance(3001) // 8001 since the first wake
    expect(a.consider("hello")).toBe("not_addressed")
  })

  test("empty speech is not addressed and does not consume the window", () => {
    const {a} = setup()
    a.wake()
    expect(a.consider("   ")).toBe("not_addressed")
    expect(a.consider("what is the weather")).toBe("wake")
  })
})

describe("the tap", () => {
  test("always opens the floor", () => {
    const {a} = setup()
    expect(a.tap()).toBe(true)
    expect(a.consider("remind me in ten minutes")).toBe("tap")
  })

  test("works even during a cool-off, because a press is not a misfire", () => {
    const {clock, a} = setup({falseWakeLimit: 2, coolOffMs: 30_000})
    for (let i = 0; i < 2; i++) {
      a.wake()
      clock.advance(8001)
      a.tick()
    }
    expect(a.coolingOff).toBe(true)
    expect(a.wake()).toBe(false)
    expect(a.tap()).toBe(true)
    expect(a.consider("hello")).toBe("tap")
    expect(a.coolingOff).toBe(false)
  })
})

describe("the follow-up window", () => {
  test("a follow-up needs no wake word", () => {
    const {a} = setup()
    a.wake()
    a.consider("what is the weather")
    a.beganSpeaking()
    a.finishedSpeaking()
    expect(a.consider("what about tomorrow")).toBe("follow_up")
  })

  test("it does not open while the assistant is still speaking", () => {
    const {a} = setup()
    a.wake()
    a.consider("what is the weather")
    a.beganSpeaking()
    expect(a.isOpen()).toBe(false)
  })

  test("it is shorter than a wake window", () => {
    const {clock, a} = setup()
    a.wake()
    a.consider("q")
    a.beganSpeaking()
    a.finishedSpeaking()
    clock.advance(5001)
    expect(a.consider("what about tomorrow")).toBe("not_addressed")
  })

  test("one follow-up per answer, not a rolling window", () => {
    const {a} = setup()
    a.wake()
    a.consider("q")
    a.beganSpeaking()
    a.finishedSpeaking()
    expect(a.consider("what about tomorrow")).toBe("follow_up")
    // The next thing said in the room is not ours.
    expect(a.consider("did you watch the match")).toBe("not_addressed")
  })

  test("a chain of follow-ups works as long as the assistant keeps replying", () => {
    const {a} = setup()
    a.wake()
    a.consider("q")
    for (let i = 0; i < 4; i++) {
      a.beganSpeaking()
      a.finishedSpeaking()
      expect(a.consider(`follow up ${i}`)).toBe("follow_up")
    }
  })

  test("a turn that said nothing opens no follow-up window", () => {
    const {a} = setup()
    a.wake()
    a.consider("q")
    a.endTurn()
    expect(a.consider("what about tomorrow")).toBe("not_addressed")
  })
})

describe("false wakes are bounded", () => {
  test("a wake with nothing said counts as false", () => {
    const {clock, a} = setup()
    a.wake()
    clock.advance(8001)
    a.tick()
    expect(a.falseWakes).toBe(1)
  })

  test("enough of them in a row starts a cool-off", () => {
    const {clock, a} = setup({falseWakeLimit: 3, coolOffMs: 30_000})
    for (let i = 0; i < 3; i++) {
      a.wake()
      clock.advance(8001)
      a.tick()
    }
    expect(a.coolingOff).toBe(true)
    expect(a.wake()).toBe(false)
  })

  test("the cool-off ends", () => {
    const {clock, a} = setup({falseWakeLimit: 2, coolOffMs: 30_000})
    for (let i = 0; i < 2; i++) {
      a.wake()
      clock.advance(8001)
      a.tick()
    }
    clock.advance(30_001)
    expect(a.coolingOff).toBe(false)
    expect(a.wake()).toBe(true)
  })

  test("real speech resets the count, so an occasional misfire never cools off", () => {
    const {clock, a} = setup({falseWakeLimit: 3})
    a.wake()
    clock.advance(8001)
    a.tick() // false: 1
    a.wake()
    expect(a.consider("what is the weather")).toBe("wake") // real
    expect(a.falseWakes).toBe(0)
    a.wake()
    clock.advance(8001)
    a.tick()
    expect(a.coolingOff).toBe(false)
  })

  test("an unused follow-up window is not a false wake", () => {
    const {clock, a} = setup()
    a.wake()
    a.consider("q")
    a.beganSpeaking()
    a.finishedSpeaking()
    clock.advance(5001)
    a.tick()
    // The wearer simply had nothing more to ask. That is not a misfire.
    expect(a.falseWakes).toBe(0)
  })

  test("an unused tap window is not a false wake either", () => {
    const {clock, a} = setup()
    a.tap()
    clock.advance(8001)
    a.tick()
    expect(a.falseWakes).toBe(0)
  })
})
