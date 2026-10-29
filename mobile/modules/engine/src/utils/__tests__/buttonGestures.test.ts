import {describe, expect, test} from "bun:test"

import {ButtonGestureRecognizer} from "../buttonGestures"

const opts = {doubleWindowMs: 300, holdMs: 600, debounceMs: 30}

describe("a single press", () => {
  test("is not reported the instant the button comes up", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    expect(r.up(80)).toEqual([])
    expect(r.pressPending).toBe(true)
  })

  test("is reported once the double-tap window closes", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(80)
    expect(r.tick(300)).toEqual([])
    expect(r.tick(400)).toEqual(["press"])
    expect(r.pressPending).toBe(false)
  })

  test("is reported only once", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(80)
    r.tick(400)
    expect(r.tick(500)).toEqual([])
    expect(r.tick(2000)).toEqual([])
  })
})

describe("a double press", () => {
  test("fires on the second release inside the window", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(80)
    r.down(150)
    expect(r.up(220)).toEqual(["double_press"])
  })

  test("does not also emit the single press it was waiting on", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(80)
    r.down(150)
    r.up(220)
    expect(r.tick(1000)).toEqual([])
  })

  test("two presses too far apart are two single presses", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(80)
    expect(r.tick(500)).toEqual(["press"])
    r.down(600)
    expect(r.up(680)).toEqual([])
    expect(r.tick(1100)).toEqual(["press"])
  })

  test("three quick presses are a double then a single, not two doubles", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(50)
    r.down(100)
    expect(r.up(150)).toEqual(["double_press"])
    r.down(200)
    expect(r.up(250)).toEqual([])
    expect(r.tick(600)).toEqual(["press"])
  })
})

describe("a long press", () => {
  test("fires while the button is still down, not on release", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    expect(r.tick(599)).toEqual([])
    expect(r.tick(600)).toEqual(["long_press"])
  })

  test("does not also produce a press when released", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.tick(600)
    expect(r.up(900)).toEqual([])
    expect(r.tick(2000)).toEqual([])
  })

  test("fires once however long it is held", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    expect(r.tick(600)).toEqual(["long_press"])
    expect(r.tick(1200)).toEqual([])
    expect(r.tick(5000)).toEqual([])
  })

  test("a tap then a hold is a hold, not a tap and a hold", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(50)
    r.down(120) // second press, but held
    const atHold = r.tick(720)
    expect(atHold).toEqual(["long_press"])
    expect(r.up(900)).toEqual([])
    expect(r.tick(2000)).toEqual([])
  })

  test("a release just under the threshold is still a press", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    expect(r.up(599)).toEqual([])
    expect(r.tick(1000)).toEqual(["press"])
  })
})

describe("contact bounce", () => {
  test("a bouncing release is ignored", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(80)
    r.down(90) // bounce, inside debounce
    expect(r.up(100)).toEqual([]) // ignored, not a double press
    expect(r.tick(500)).toEqual(["press"])
  })

  test("a bouncing press is ignored", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.down(10) // bounce
    expect(r.tick(600)).toEqual(["long_press"]) // timed from the first edge
  })

  test("an up with no down is ignored", () => {
    const r = new ButtonGestureRecognizer(opts)
    expect(r.up(100)).toEqual([])
  })
})

describe("scheduling", () => {
  test("says when it next has work, so the caller needs one timer", () => {
    const r = new ButtonGestureRecognizer(opts)
    expect(r.nextDeadline()).toBeNull()
    r.down(0)
    expect(r.nextDeadline()).toBe(600) // the hold
    r.up(80)
    expect(r.nextDeadline()).toBe(381) // the double-tap window, plus one
    r.tick(400)
    expect(r.nextDeadline()).toBeNull()
  })

  test("ticking late still resolves both deadlines", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    // The phone was busy; one tick arrives long after both deadlines.
    expect(r.tick(5000)).toEqual(["long_press"])
  })
})

describe("disconnect", () => {
  test("drops a half-finished gesture", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(80)
    r.reset()
    expect(r.tick(1000)).toEqual([])
    expect(r.pressPending).toBe(false)
  })

  test("a button left down across a disconnect does not fire a hold later", () => {
    const r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.reset()
    expect(r.tick(5000)).toEqual([])
  })
})

describe("the three gestures the capability profile advertises", () => {
  test("are all reachable, which is what the profile promises", () => {
    const seen = new Set<string>()
    let r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(50)
    for (const g of r.tick(400)) seen.add(g)

    r = new ButtonGestureRecognizer(opts)
    r.down(0)
    r.up(50)
    r.down(100)
    for (const g of r.up(150)) seen.add(g)

    r = new ButtonGestureRecognizer(opts)
    r.down(0)
    for (const g of r.tick(600)) seen.add(g)

    expect([...seen].sort()).toEqual(["double_press", "long_press", "press"])
  })
})
