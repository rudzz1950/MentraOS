import {describe, expect, test} from "bun:test"

import * as cards from "../../hud/cards"
import type {PhoneNotification} from "../../hud/notify"
import {STANDIN_OLED} from "../../hud/panel"
import {ReplyContext} from "../reply"

class FakeClock {
  constructor(public t = 1_000_000) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

function notif(over: Partial<PhoneNotification> = {}): PhoneNotification {
  return {
    notificationId: "n1",
    app: "Messages",
    title: "Amma",
    content: "Are you coming home?",
    priority: "high",
    timestamp: 0,
    packageName: "com.google.android.apps.messaging",
    ...over,
  }
}

describe("the card no longer promises what the platform forbids", () => {
  const ctx = {panel: STANDIN_OLED}

  test("no reply prompt when there is no reply action", () => {
    // iOS over ANCS is read-only, and interactive forwarding is EU-only from
    // 26.5 — which excludes India.
    const c = cards.message("Amma", "Dinner?", ctx, {canReply: false})
    expect(c.rows.join(" ")).not.toContain("reply")
  })

  test("none by default either, rather than assuming one exists", () => {
    const c = cards.message("Amma", "Dinner?", ctx)
    expect(c.rows.join(" ")).not.toContain("reply")
  })

  test("the prompt appears when the platform handed one over", () => {
    const c = cards.message("Amma", "Dinner?", ctx, {canReply: true})
    expect(c.rows.join(" ")).toContain("reply")
  })

  test("and the prompt is still the first thing dropped when space is tight", () => {
    const long = "Are you coming home for dinner tonight or should I keep it aside for tomorrow"
    const c = cards.message("Amma", long, ctx, {canReply: true})
    expect(c.rows.length).toBeLessThanOrEqual(STANDIN_OLED.content.rows)
  })
})

describe("the reply target", () => {
  test("is offered only when a reply action exists", () => {
    const r = new ReplyContext({clock: new FakeClock()})
    expect(r.offer(notif({canReply: true}))).not.toBeNull()
    expect(r.offer(notif({canReply: false}))).toBeNull()
    expect(r.offer(notif())).toBeNull()
  })

  test("carries what the platform reply action needs", () => {
    const r = new ReplyContext({clock: new FakeClock()})
    const t = r.offer(notif({canReply: true, notificationKey: "0|com.msg|1|null|10123"}))!
    expect(t.notificationKey).toBe("0|com.msg|1|null|10123")
    expect(t.packageName).toBe("com.google.android.apps.messaging")
    expect(t.sender).toBe("Amma")
  })

  test("names the sender without the message counter", () => {
    const r = new ReplyContext({clock: new FakeClock()})
    const t = r.offer(notif({canReply: true, title: "Amma (3 messages)"}))!
    expect(t.sender).toBe("Amma")
  })

  test("expires with the card, so a late reply cannot land on it", () => {
    const clock = new FakeClock()
    const r = new ReplyContext({clock, windowMs: 6000})
    r.offer(notif({canReply: true}))
    expect(r.current()).not.toBeNull()
    clock.advance(6001)
    // Otherwise "reply, I'm on my way" lands on whatever arrived twenty
    // minutes ago, to someone else entirely.
    expect(r.current()).toBeNull()
  })

  test("a newer message replaces the target", () => {
    const r = new ReplyContext({clock: new FakeClock()})
    r.offer(notif({canReply: true, title: "Amma"}))
    r.offer(notif({canReply: true, notificationId: "n2", title: "Tanu"}))
    expect(r.current()!.sender).toBe("Tanu")
  })

  test("a message with no reply action clears a previous target", () => {
    const r = new ReplyContext({clock: new FakeClock()})
    r.offer(notif({canReply: true}))
    r.offer(notif({notificationId: "n2", canReply: false}))
    expect(r.current()).toBeNull()
  })
})

describe("parsing a reply", () => {
  const r = new ReplyContext({clock: new FakeClock()})

  test("pulls the body out", () => {
    expect(r.parse("reply I'll be there in ten minutes")).toBe("I'll be there in ten minutes")
    expect(r.parse("respond yes that works")).toBe("yes that works")
    expect(r.parse("tell her I'm on my way")).toBe("I'm on my way")
  })

  test("handles the filler people actually say", () => {
    expect(r.parse("reply saying I'm on my way")).toBe("I'm on my way")
    expect(r.parse("reply, running late")).toBe("running late")
  })

  test("a bare reply is not a reply", () => {
    // Naming the intent with no content. Sending an empty message is worse
    // than asking what to say.
    expect(r.parse("reply")).toBeNull()
    expect(r.parse("reply saying")).toBeNull()
    expect(r.isBareReply("reply")).toBe(true)
    expect(r.isBareReply("reply I'm coming")).toBe(false)
  })

  test("an unrelated utterance is not a reply", () => {
    expect(r.parse("what is the weather")).toBeNull()
    expect(r.parse("set a timer for 10 minutes")).toBeNull()
  })

  test("a question that merely contains the word is not one either", () => {
    expect(r.parse("did she reply to my email")).toBeNull()
  })
})
