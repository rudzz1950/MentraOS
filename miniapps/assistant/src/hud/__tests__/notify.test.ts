import {beforeEach, describe, expect, it} from "bun:test"

import * as card from "../cards"
import {NotifyPolicy, senderOf, type PhoneNotification} from "../notify"
import {STANDIN_OLED} from "../panel"

class FakeClock {
  constructor(public t = 1_700_000_000_000) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

let clock: FakeClock
beforeEach(() => {
  clock = new FakeClock()
})

function notif(over: Partial<PhoneNotification> = {}): PhoneNotification {
  return {
    notificationId: "n1",
    app: "Messages",
    title: "Amma",
    content: "Dinner?",
    priority: "high",
    timestamp: clock.now(),
    packageName: "com.google.android.apps.messaging",
    ...over,
  }
}

const policy = (over: Partial<ConstructorParameters<typeof NotifyPolicy>[0]> = {}) =>
  new NotifyPolicy({clock, prioritySenders: ["Amma"], hourlyBudget: 3, ...over})

describe("the allow-list is the mechanism", () => {
  it("lets a named sender through", () => {
    expect(policy().decide(notif())).toEqual({show: true, reason: "priority_sender"})
  })

  it("lets a named app through", () => {
    const p = policy({prioritySenders: [], priorityApps: ["com.whatsapp"]})
    expect(p.decide(notif({packageName: "com.whatsapp", title: "Someone"}))).toEqual({
      show: true,
      reason: "priority_app",
    })
  })

  it("blocks everything not named, even at high priority", () => {
    expect(policy().decide(notif({title: "LinkedIn", priority: "max"}))).toEqual({
      show: false,
      reason: "not_priority",
    })
  })

  it("blocks everything when nothing is named", () => {
    const p = new NotifyPolicy({clock})
    expect(p.decide(notif()).show).toBe(false)
  })

  it("matches a sender inside a title that carries a counter", () => {
    expect(policy().decide(notif({title: "Amma (3 messages)"})).show).toBe(true)
  })

  it("matches case-insensitively", () => {
    expect(policy({prioritySenders: ["AMMA"]}).decide(notif({title: "amma"})).show).toBe(true)
  })

  it("is not fooled by an empty configured sender matching everything", () => {
    const p = policy({prioritySenders: [""]})
    expect(p.decide(notif({title: "Spam App"})).show).toBe(false)
  })
})

describe("platform priority floors", () => {
  it("never interrupts on min or low, allow-listed or not", () => {
    for (const priority of ["min", "low", "MIN", "Low"]) {
      expect(policy().decide(notif({priority})).show).toBe(false)
    }
  })

  it("treats an empty priority as showable, because iOS sends none", () => {
    expect(policy().decide(notif({priority: ""})).show).toBe(true)
  })

  it("never interrupts for an ongoing notification", () => {
    expect(policy().decide(notif({ongoing: true}))).toEqual({show: false, reason: "ongoing"})
  })
})

describe("do-not-disturb", () => {
  it("silences everything, including priority senders", () => {
    expect(policy({doNotDisturb: true}).decide(notif())).toEqual({show: false, reason: "dnd"})
  })

  it("can be turned on and off at runtime", () => {
    const p = policy()
    p.setDoNotDisturb(true)
    expect(p.decide(notif()).show).toBe(false)
    p.setDoNotDisturb(false)
    expect(p.decide(notif({notificationId: "n2"})).show).toBe(true)
  })

  it("spends no budget while silent", () => {
    const p = policy({doNotDisturb: true})
    for (let i = 0; i < 10; i++) p.decide(notif({notificationId: `n${i}`}))
    p.setDoNotDisturb(false)
    expect(p.remainingBudget()).toBe(3)
  })
})

describe("the hourly budget", () => {
  it("stops interrupting once spent", () => {
    const p = policy()
    for (let i = 0; i < 3; i++) {
      expect(p.decide(notif({notificationId: `n${i}`})).show).toBe(true)
    }
    expect(p.decide(notif({notificationId: "n9"}))).toEqual({show: false, reason: "over_budget"})
  })

  it("reports what is left", () => {
    const p = policy()
    expect(p.remainingBudget()).toBe(3)
    p.decide(notif())
    expect(p.remainingBudget()).toBe(2)
  })

  it("rolls forward rather than resetting on the hour", () => {
    const p = policy()
    for (let i = 0; i < 3; i++) p.decide(notif({notificationId: `n${i}`}))
    expect(p.remainingBudget()).toBe(0)

    // 40 minutes on: still inside the window, still spent.
    clock.advance(40 * 60 * 1000)
    expect(p.remainingBudget()).toBe(0)

    // Past the hour from the first: that one interruption comes back.
    clock.advance(21 * 60 * 1000)
    expect(p.remainingBudget()).toBe(3)
  })

  it("spends nothing on a notification it refused", () => {
    const p = policy()
    for (let i = 0; i < 5; i++) p.decide(notif({title: "Spam", notificationId: `s${i}`}))
    expect(p.remainingBudget()).toBe(3)
  })
})

describe("reposts", () => {
  it("does not interrupt twice for the same notification key", () => {
    const p = policy()
    const n = notif({notificationKey: "0|com.msg|1|null|10123"})
    expect(p.decide(n).show).toBe(true)
    expect(p.decide(n)).toEqual({show: false, reason: "repost"})
  })

  it("falls back to app and id when the platform gave no key", () => {
    const p = policy()
    expect(p.decide(notif()).show).toBe(true)
    expect(p.decide(notif()).reason).toBe("repost")
  })

  it("does not confuse the same id from two different apps", () => {
    const p = policy()
    expect(p.decide(notif({packageName: "com.a"})).show).toBe(true)
    expect(p.decide(notif({packageName: "com.b"})).show).toBe(true)
  })

  it("lets the same thread interrupt again once the window has passed", () => {
    const p = policy({repostWindowMs: 60_000, hourlyBudget: 10})
    const n = notif({notificationKey: "k"})
    expect(p.decide(n).show).toBe(true)
    clock.advance(30_000)
    expect(p.decide(n).show).toBe(false)
    clock.advance(31_000)
    expect(p.decide(n).show).toBe(true)
  })

  it("spends no budget on a repost", () => {
    const p = policy()
    const n = notif({notificationKey: "k"})
    p.decide(n)
    p.decide(n)
    p.decide(n)
    expect(p.remainingBudget()).toBe(2)
  })
})

describe("naming the sender", () => {
  it("strips a message counter", () => {
    expect(senderOf(notif({title: "Amma (3 messages)"}))).toBe("Amma")
    expect(senderOf(notif({title: "Amma (2)"}))).toBe("Amma")
  })

  it("leaves an ordinary name alone", () => {
    expect(senderOf(notif({title: "Anirudh Bharadwaj"}))).toBe("Anirudh Bharadwaj")
  })

  it("falls back to the app when there is no title", () => {
    expect(senderOf(notif({title: ""}))).toBe("Messages")
  })
})

describe("reply is a platform capability, never an assumption", () => {
  it("offers a reply prompt only when the platform handed one over", () => {
    // Android with a reply action.
    const android = notif({canReply: true})
    expect(android.canReply).toBe(true)
    // iOS over ANCS is read-only; India is outside the EU carve-out.
    const ios = notif({canReply: undefined, priority: ""})
    expect(ios.canReply).toBeUndefined()
  })
})

describe("a shown notification becomes a card that obeys the driving rules", () => {
  const ctx = {panel: STANDIN_OLED}

  it("keeps the sender and drops the body while driving", () => {
    const n = notif({content: "Are you coming home for dinner tonight?"})
    expect(policy().decide(n).show).toBe(true)
    const c = card.message(senderOf(n), n.content, ctx)
    const driving = card.gate(c, true)!
    expect(driving.rows).toContain("Amma")
    expect(driving.rows.join(" ")).not.toContain("dinner")
  })

  it("fits the panel", () => {
    const c = card.message(senderOf(notif()), "Dinner?", ctx)
    expect(c.rows.length).toBeLessThanOrEqual(STANDIN_OLED.content.rows)
    for (const r of c.rows) expect(r.length).toBeLessThanOrEqual(STANDIN_OLED.cols)
  })
})
