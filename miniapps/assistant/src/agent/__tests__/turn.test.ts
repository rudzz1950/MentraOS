/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {MemoryService} from "../../memory/memory"
import {MemoryBlobStore, MemoryKeyValueStore} from "../../memory/ports"
import {ModelRouter, ModelsUnavailableError, rulesAnswer} from "../model"
import type {Clock, Hud, ModelClient, Tool, Voice} from "../ports"
import {classify} from "../router"
import {STANDIN_OLED, TARGET_HUD} from "../../hud/panel"
import {OutboundLimit} from "../bargein"
import {Assistant, confirmationCard, fitToHud, splitSentences} from "../turn"

const T0 = new Date("2026-10-29T14:05:00+05:30").getTime()
const clock: Clock = {now: () => T0}

class FakeHud implements Hud {
  shown: string[][] = []
  async show(lines: string[]) {
    this.shown.push(lines)
  }
  async clear() {}
  get last() {
    return this.shown.at(-1) ?? []
  }
  get flat() {
    return this.shown.map(s => s.join(" "))
  }
}

class FakeVoice implements Voice {
  spoken: string[][] = []
  stops = 0
  async speak(sentences: string[]) {
    this.spoken.push(sentences)
  }
  async stop() {
    this.stops++
  }
  get said() {
    return this.spoken.flat().join(" ")
  }
}

/** A model that streams a canned answer, or fails in a chosen way. */
class FakeModel implements ModelClient {
  calls: string[] = []
  constructor(
    readonly name: string,
    private readonly reply: string | (() => never) = "ok",
  ) {}
  async *complete(prompt: string): AsyncIterable<string> {
    this.calls.push(prompt)
    if (typeof this.reply === "function") this.reply()
    for (const word of (this.reply as string).split(" ")) yield word + " "
  }
}

function memory() {
  return new MemoryService({
    storage: new MemoryKeyValueStore(),
    blobs: new MemoryBlobStore(),
    now: () => T0,
    embeddingsEnabled: true,
  })
}

function build(opts: {
  model?: ModelClient | ModelClient[]
  tools?: Tool[]
  outbound?: OutboundLimit
  driving?: () => boolean
} = {}) {
  const hud = new FakeHud()
  const voice = new FakeVoice()
  const mem = memory()
  const models = opts.model
    ? Array.isArray(opts.model)
      ? opts.model
      : [opts.model]
    : [new FakeModel("small", "Two lines at most.")]
  const assistant = new Assistant({
    transcripts: {on: () => () => {}},
    hud,
    voice,
    memory: mem,
    router: new ModelRouter(models, 50),
    clock,
    tools: opts.tools,
    outbound: opts.outbound,
    driving: opts.driving,
  })
  return {assistant, hud, voice, mem, models}
}

describe("what counts as addressed", () => {
  test("overheard speech is ignored, whatever it sounds like", () => {
    expect(classify("send her the deck", false)).toBe("not_for_me")
    expect(classify("what time is the meeting", false)).toBe("not_for_me")
    expect(classify("", true)).toBe("not_for_me")
  })

  test("an action verb up front is an instruction", () => {
    expect(classify("send a message to Tanu", true)).toBe("action")
    expect(classify("remind me to order the dev kit", true)).toBe("action")
  })

  test("the same verb mid-sentence is still a question", () => {
    expect(classify("what time should I set off", true)).toBe("question")
  })

  test("an ambiguous utterance is answered, not acted on", () => {
    // Wrong as a question: harmless. Wrong as an action: it sends something.
    expect(classify("the thing from yesterday", true)).toBe("question")
  })

  test("notes are recognised", () => {
    expect(classify("remember that the lab quote was 90k", true)).toBe("note")
  })
})

describe("a turn", () => {
  test("ignores overheard speech without showing or saying anything", async () => {
    const {assistant, hud, voice} = build()
    const r = await assistant.handle("so I told him no", false)
    expect(r.ignored).toBe(true)
    expect(hud.shown).toEqual([])
    expect(voice.spoken).toEqual([])
  })

  test("answers a question on the panel and aloud", async () => {
    const {assistant, hud, voice} = build()
    const r = await assistant.handle("what did I say about the pitch", true)
    expect(r.intent).toBe("question")
    expect(r.via).toBe("small")
    expect(voice.said).toContain("Two lines")
    expect(hud.last.length).toBeLessThanOrEqual(2)
  })

  test("the clock is answered without a model at all", async () => {
    const model = new FakeModel("small", "never used")
    const {assistant, voice} = build({model})
    const r = await assistant.handle("what's the time", true)
    expect(r.via).toBe("rules")
    expect(model.calls.length).toBe(0)
    expect(voice.said).toContain("2:05")
  })

  test("a note goes into memory and is findable", async () => {
    const {assistant, mem} = build()
    await assistant.handle("remember that the lab quote was ninety thousand", true)
    const all = await mem.list()
    expect(all.length).toBe(1)
    expect(all[0].text).toBe("the lab quote was ninety thousand")
    expect(all[0].source.utterance).toContain("remember that")
  })

  test("memory and preferences reach the model", async () => {
    const model = new FakeModel("small", "fine")
    const {assistant, mem} = build({model})
    await mem.add({
      class: "stable_preference",
      text: "Keep answers to two lines",
      source: {turnId: "t0", turnAt: T0},
    })
    await mem.add({
      class: "episodic",
      text: "Sent the deck to the investors on Tuesday",
      source: {turnId: "t0", turnAt: T0},
    })
    await assistant.handle("how did the deck go", true)

    const prompt = model.calls[0]
    expect(prompt).toContain("Keep answers to two lines")
    expect(prompt).toContain("Sent the deck")
    expect(prompt).toContain("Question: how did the deck go")
  })
})

describe("consequential actions", () => {
  function sendTool() {
    const calls: string[] = []
    const tool: Tool = {
      name: "message",
      consequential: true,
      run: async args => {
        calls.push(args)
        return "Sent."
      },
    }
    return {tool, calls}
  }

  test("nothing is sent until the user confirms", async () => {
    const {tool, calls} = sendTool()
    const {assistant, hud} = build({tools: [tool]})

    const r = await assistant.handle("message Tanu that I'm running late", true)
    expect(r.pendingConfirmation?.tool).toBe("message")
    expect(calls.length).toBe(0)
    expect(assistant.awaitingConfirmation).toBe(true)
    // The ask must survive, whatever the message says: a card showing only
    // what is about to be sent reads as "already sent".
    expect(hud.last.length).toBe(2)
    expect(hud.last[1]).toContain("confirm")
  })

  test("confirming runs it exactly once", async () => {
    const {tool, calls} = sendTool()
    const {assistant, voice} = build({tools: [tool]})
    await assistant.handle("message Tanu that I'm running late", true)
    const r = await assistant.handle("send", true)

    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("running late")
    expect(r.via).toBe("tool:message")
    expect(voice.said).toContain("Sent.")
    expect(assistant.awaitingConfirmation).toBe(false)
  })

  test("anything other than yes cancels, and nothing is sent", async () => {
    const {tool, calls} = sendTool()
    const {assistant, voice} = build({tools: [tool]})
    await assistant.handle("message Tanu that I'm running late", true)
    const r = await assistant.handle("no, leave it", true)

    expect(calls.length).toBe(0)
    expect(r.answer).toBe("Cancelled.")
    expect(voice.said).toContain("Cancelled.")
  })

  test("a harmless tool runs without ceremony", async () => {
    const calls: string[] = []
    const tool: Tool = {
      name: "timer",
      consequential: false,
      run: async a => {
        calls.push(a)
        return "Timer set."
      },
    }
    const {assistant} = build({tools: [tool]})
    const r = await assistant.handle("set a timer for ten minutes", true)
    expect(calls.length).toBe(1)
    expect(r.answer).toBe("Timer set.")
  })
})

describe("when models fail", () => {
  test("falls to the next tier", async () => {
    const dead = new FakeModel("small", () => {
      throw new Error("503")
    })
    const alive = new FakeModel("large", "Answered by the big one.")
    const {assistant} = build({model: [dead, alive]})

    const r = await assistant.handle("why is the sky blue", true)
    expect(r.via).toBe("large")
    expect(r.answer).toContain("big one")
  })

  test("says so plainly when none answer", async () => {
    const dead = () =>
      new FakeModel("x", () => {
        throw new Error("offline")
      })
    const {assistant, hud, voice} = build({model: [dead(), dead()]})

    const r = await assistant.handle("why is the sky blue", true)
    expect(r.error).toContain("Can't reach")
    // Shown, not spoken into the void, and never silent.
    expect(hud.flat.at(-1)).toContain("Can't reach")
    expect(voice.said).not.toContain("Can't reach")
  })

  test("a failed tier's partial text is discarded, not shown as an answer", async () => {
    class HalfModel implements ModelClient {
      readonly name = "half"
      async *complete(): AsyncIterable<string> {
        yield "The answer is "
        throw new Error("cut off")
      }
    }
    const {assistant} = build({model: [new HalfModel(), new FakeModel("large", "Complete answer.")]})
    const r = await assistant.handle("why is the sky blue", true)
    expect(r.answer).toBe("Complete answer. ")
    expect(r.answer).not.toContain("The answer is")
  })
})

describe("the confirmation card", () => {
  test("keeps the ask even when the summary is long", () => {
    const lines = confirmationCard("message: tell Tanu I am going to be quite late this evening")
    expect(lines.length).toBe(2)
    expect(lines[0].length).toBeLessThanOrEqual(21)
    expect(lines[1]).toBe("Say send to confirm")
  })

  test("a short summary is not padded or truncated", () => {
    expect(confirmationCard("timer: 10 min")[0]).toBe("timer: 10 min")
  })
})

describe("fitting the panel", () => {
  // The panel's real geometry, not the two lines this test used to assume:
  // 128x64 at a 6x10 font is 21 columns, and the capability profile allows
  // four text lines. See hud/panel.ts.
  test("wraps within the panel's four rows of 21 characters", () => {
    const lines = fitToHud("The quick brown fox jumps over the lazy dog again and again")
    expect(lines.length).toBeLessThanOrEqual(STANDIN_OLED.content.rows)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(STANDIN_OLED.cols)
  })

  test("the wider HUD shows more of a long answer", () => {
    const text =
      "Twenty-eight degrees and overcast in Bengaluru, with rain likely after four this afternoon."
    expect(fitToHud(text, TARGET_HUD).join(" ").length).toBeGreaterThan(
      fitToHud(text, STANDIN_OLED).join(" ").length,
    )
  })

  test("a short answer stays one line", () => {
    expect(fitToHud("Yes")).toEqual(["Yes"])
  })

  test("speech is split by sentence so it can start early", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"])
  })
})

describe("the rules path", () => {
  test("answers the time", () => {
    expect(rulesAnswer("what's the time", clock)).toContain("2:05")
  })

  test("does not hijack a question that merely contains the word", () => {
    expect(rulesAnswer("is it time to leave", clock)).toBeNull()
  })

  test("declines what it cannot answer", () => {
    expect(rulesAnswer("why is the sky blue", clock)).toBeNull()
  })
})

describe("the router itself", () => {
  test("refuses to be constructed with no models", () => {
    expect(() => new ModelRouter([])).toThrow(/at least one/)
  })

  test("reports every failure when all tiers fail", async () => {
    const boom = (n: string) =>
      new FakeModel(n, () => {
        throw new Error("down")
      })
    const router = new ModelRouter([boom("a"), boom("b")], 50)
    try {
      await router.complete("x")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ModelsUnavailableError)
      expect((err as ModelsUnavailableError).failures.length).toBe(2)
    }
  })
})


describe("the outbound limit, in the loop", () => {
  const sender = (sent: string[]): Tool => ({
    name: "message",
    consequential: true,
    async run(args) {
      sent.push(args)
      return "Sent."
    },
  })

  async function send(a: Assistant, text: string, reply = "yes") {
    await a.handle(text, true)
    return a.handle(reply, true)
  }

  test("five go through on one confirmation each", async () => {
    const sent: string[] = []
    const {assistant} = build({tools: [sender(sent)]})
    for (let i = 0; i < 5; i++) {
      await send(assistant, `message Tanu number ${i}`)
    }
    expect(sent.length).toBe(5)
    expect(assistant.outboundRemaining).toBe(0)
  })

  test("the sixth asks again, and says so on the panel", async () => {
    const sent: string[] = []
    const {assistant, hud} = build({tools: [sender(sent)]})
    for (let i = 0; i < 5; i++) await send(assistant, `message Tanu ${i}`)

    await assistant.handle("message Tanu once more", true)
    expect(assistant.awaitingReconfirmation).toBe(true)
    expect(hud.last.join(" ")).toContain("Again?")
  })

  test("a hesitant ok does not send the sixth", async () => {
    const sent: string[] = []
    const {assistant} = build({tools: [sender(sent)]})
    for (let i = 0; i < 5; i++) await send(assistant, `message Tanu ${i}`)

    const r = await send(assistant, "message Tanu once more", "ok")
    expect(r.answer).toBe("Cancelled.")
    expect(sent.length).toBe(5)
  })

  test("an explicit yes does send it", async () => {
    const sent: string[] = []
    const {assistant} = build({tools: [sender(sent)]})
    for (let i = 0; i < 5; i++) await send(assistant, `message Tanu ${i}`)

    await send(assistant, "message Tanu once more", "send")
    expect(sent.length).toBe(6)
  })

  test("a question never spends the outbound budget", async () => {
    const {assistant} = build({tools: [sender([])]})
    await assistant.handle("what is the plan for tomorrow", true)
    expect(assistant.outboundRemaining).toBe(5)
  })

  test("a cancelled action spends nothing", async () => {
    const sent: string[] = []
    const {assistant} = build({tools: [sender(sent)]})
    await send(assistant, "message Tanu hello", "no")
    expect(sent.length).toBe(0)
    expect(assistant.outboundRemaining).toBe(5)
  })
})

describe("interrupting a turn in flight", () => {
  /** A model that never finishes until it is cancelled. */
  class Hanging implements ModelClient {
    name = "slow"
    async *complete(_p: string, signal: AbortSignal): AsyncIterable<string> {
      yield "I "
      while (!signal.aborted) {
        await new Promise(r => setTimeout(r, 1))
      }
      throw new Error("aborted")
    }
  }

  test("barge-in ends the turn without showing a half answer", async () => {
    const hud = new FakeHud()
    const voice = new FakeVoice()
    const assistant = new Assistant({
      transcripts: {on: () => () => {}},
      hud,
      voice,
      memory: memory(),
      router: new ModelRouter([new Hanging()], 10_000),
      clock,
    })
    const turn = assistant.handle("what is the weather like", true)
    // The wearer speaks over it.
    await new Promise(r => setTimeout(r, 5))
    assistant.interrupt()
    const result = await turn

    expect(result.interrupted).toBe(true)
    expect(result.answer).toBeUndefined()
    expect(voice.stops).toBe(1)
    // The panel never showed a partial answer; the last thing on it is the
    // thinking card.
    expect(hud.flat.at(-1)).toContain("Thinking")
  })

  test("interrupting when nothing is running is harmless", () => {
    const {assistant} = build()
    expect(() => assistant.interrupt()).not.toThrow()
  })
})

describe("driving, in the loop", () => {
  test("the assistant keeps quiet on the panel while driving", async () => {
    const {assistant, hud, voice} = build({driving: () => true})
    await assistant.handle("what is the weather like", true)
    // Suppressed: the panel was never written to. Speech still happens, which
    // is the right channel at speed.
    expect(hud.shown.length).toBe(0)
    expect(voice.said.length).toBeGreaterThan(0)
  })

  test("and shows it when stopped", async () => {
    const {assistant, hud} = build({driving: () => false})
    await assistant.handle("what is the weather like", true)
    expect(hud.shown.length).toBeGreaterThan(0)
  })
})

describe("timers never reach a model", () => {
  test("setting one is answered on-device", async () => {
    const {assistant, models} = build()
    const r = await assistant.handle("set a timer for 10 minutes", true)
    expect(r.via).toBe("timers")
    expect(r.answer).toContain("10 minutes")
    // The whole point: no network was touched.
    expect((models[0] as any).calls.length).toBe(0)
  })

  test("so does asking how long is left", async () => {
    const {assistant, models} = build()
    await assistant.handle("set a timer for 10 minutes", true)
    const r = await assistant.handle("how long is left", true)
    expect(r.via).toBe("timers")
    expect((models[0] as any).calls.length).toBe(0)
  })

  test("the timer is actually registered, not just acknowledged", async () => {
    const {assistant} = build()
    await assistant.handle("set a timer for 10 minutes", true)
    expect(assistant.timerStore.active().length).toBe(1)
  })

  test("a real question still goes to the model", async () => {
    const {assistant, models} = build()
    const r = await assistant.handle("what is the capital of Karnataka", true)
    expect(r.via).not.toBe("timers")
    expect((models[0] as any).calls.length).toBe(1)
  })

  test("an incomplete timer asks rather than setting a guessed one", async () => {
    const {assistant} = build()
    const r = await assistant.handle("set a timer", true)
    expect(r.answer).toContain("How long")
    expect(assistant.timerStore.active().length).toBe(0)
  })

  test("overheard speech still cannot set a timer", async () => {
    const {assistant} = build()
    const r = await assistant.handle("set a timer for 10 minutes", false)
    expect(r.ignored).toBe(true)
    expect(assistant.timerStore.active().length).toBe(0)
  })

  test("a note about a timer is still a note", async () => {
    const {assistant, mem} = build()
    const r = await assistant.handle("remember that the pasta timer is 8 minutes", true)
    expect(r.intent).toBe("note")
    expect(assistant.timerStore.active().length).toBe(0)
    expect((await mem.list()).length).toBe(1)
  })
})

describe("conversation history", () => {
  test("a follow-up has the previous exchange to refer to", async () => {
    const {assistant, models} = build()
    await assistant.handle("what is the weather in Bengaluru", true)
    await assistant.handle("what about tomorrow", true)

    const second = (models[0] as any).calls[1] as string
    expect(second).toContain("Recent conversation")
    expect(second).toContain("weather in Bengaluru")
  })

  test("the first question has no history, so no empty section", async () => {
    const {assistant, models} = build()
    await assistant.handle("what is the weather", true)
    expect((models[0] as any).calls[0]).not.toContain("Recent conversation")
  })

  test("it is bounded rather than growing all session", async () => {
    const {assistant} = build()
    for (let i = 0; i < 8; i++) {
      await assistant.handle(`question number ${i}`, true)
    }
    expect(assistant.historyLength).toBe(3)
  })

  test("it can be dropped when the wearer walks away", async () => {
    const {assistant} = build()
    await assistant.handle("what is the weather", true)
    expect(assistant.historyLength).toBe(1)
    assistant.clearHistory()
    expect(assistant.historyLength).toBe(0)
  })

  test("a failure is not recorded as an answer", async () => {
    // Otherwise the model would treat "can't reach the assistant" as a fact
    // about the world on the next turn.
    const dead = new FakeModel("dead", () => {
      throw new Error("offline")
    })
    const {assistant} = build({model: dead})
    const r = await assistant.handle("what is the weather", true)
    expect(r.error).toBeDefined()
    expect(assistant.historyLength).toBe(0)
  })

  test("a timer is not put in the model's context either", async () => {
    const {assistant, models} = build()
    await assistant.handle("set a timer for 5 minutes", true)
    await assistant.handle("what is the weather", true)
    expect((models[0] as any).calls[0]).not.toContain("Recent conversation")
  })
})

describe("the built-in timer is a default, not a hijack", () => {
  test("a registered timer tool wins over the built-in", async () => {
    const calls: string[] = []
    const tool: Tool = {
      name: "timer",
      consequential: false,
      run: async a => {
        calls.push(a)
        return "Set on the phone's clock."
      },
    }
    const {assistant} = build({tools: [tool]})
    const r = await assistant.handle("set a timer for ten minutes", true)
    expect(calls.length).toBe(1)
    expect(r.via).toBe("tool:timer")
    // The on-device store stayed out of it.
    expect(assistant.timerStore.active().length).toBe(0)
  })

  test("and the built-in is used when no such tool exists", async () => {
    const {assistant} = build()
    const r = await assistant.handle("set a timer for ten minutes", true)
    expect(r.via).toBe("timers")
    expect(assistant.timerStore.active().length).toBe(1)
  })

  test("an unrelated tool does not block the built-in", async () => {
    const tool: Tool = {name: "message", consequential: true, run: async () => "Sent."}
    const {assistant} = build({tools: [tool]})
    const r = await assistant.handle("set a timer for ten minutes", true)
    expect(r.via).toBe("timers")
  })
})

describe("what the wearer is told when nothing answers", () => {
  const dead = () =>
    new FakeModel("dead", () => {
      throw new Error("offline")
    })

  function withHeavy(hasHeavyTier: boolean) {
    const hud = new FakeHud()
    const assistant = new Assistant({
      transcripts: {on: () => () => {}},
      hud,
      voice: new FakeVoice(),
      memory: memory(),
      router: new ModelRouter([dead()], 20),
      clock,
      hasHeavyTier,
    })
    return {assistant, hud}
  }

  test("a configured heavy tier that is unreachable invites a retry", async () => {
    const {assistant, hud} = withHeavy(true)
    const r = await assistant.handle("what is the capital of Karnataka", true)
    expect(r.error).toMatch(/can't reach/i)
    expect(hud.flat.at(-1)).toMatch(/can't reach/i)
  })

  test("no heavy tier states a deployment fact instead of a fault", async () => {
    // An on-premise install with no GPU is working as specified. Telling the
    // wearer to try again would be a lie they could act on forever.
    const {assistant, hud} = withHeavy(false)
    const r = await assistant.handle("what is the capital of Karnataka", true)
    expect(r.error).toMatch(/aren't set up/i)
    expect(r.error).not.toMatch(/can't reach/i)
    expect(hud.flat.at(-1)).toMatch(/aren't set up/i)
  })

  test("the hosted default assumes a heavy tier exists", async () => {
    // The pessimistic default would tell an ordinary user a capability is
    // missing when it is merely offline.
    const {assistant} = build({model: dead()})
    const r = await assistant.handle("what is the capital of Karnataka", true)
    expect(r.error).toMatch(/can't reach/i)
  })
})
