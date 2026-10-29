import {describe, expect, it} from "bun:test"

import {BargeIn, OutboundLimit} from "../bargein"
import {CancelledError, ModelRouter} from "../model"
import type {ModelClient} from "../ports"

class FakeClock {
  constructor(public t = 1_000_000) {}
  now() {
    return this.t
  }
  advance(ms: number) {
    this.t += ms
  }
}

function setup(over: Partial<Parameters<typeof BargeIn.prototype.constructor>[0]> = {}) {
  const clock = new FakeClock()
  let stops = 0
  const b = new BargeIn({clock, onInterrupt: () => stops++, ...(over as object)} as never)
  return {clock, b, stops: () => stops}
}

describe("the 300 ms budget", () => {
  it("stops well inside 300 ms of the voice onset in vad mode", () => {
    const {clock, b, stops} = setup({trigger: "vad", minVoicedMs: 120})
    b.beganSpeaking()
    clock.advance(1500) // mid-sentence

    b.onVoice(true) // first voiced frame
    expect(stops()).toBe(0) // not yet: the minimum guards a cough

    clock.advance(120)
    expect(b.onVoice(true)).toBe(true)
    expect(stops()).toBe(1)
    expect(b.lastLatencyMs()).toBe(120)
    expect(b.lastLatencyMs()!).toBeLessThan(300)
  })

  it("leaves headroom for the link once the minimum is spent", () => {
    const {b} = setup({trigger: "vad", minVoicedMs: 120})
    // 120 ms of voice + 20 ms firmware attack still leaves ~160 ms for BLE
    // and the stop call. The budget is the reason minVoicedMs is not 250.
    expect(120 + 20).toBeLessThan(300)
    expect(b.state.speaking).toBe(false)
  })
})

describe("what counts as speaking over the assistant", () => {
  it("ignores a single noisy frame", () => {
    const {clock, b, stops} = setup({trigger: "vad", minVoicedMs: 120})
    b.beganSpeaking()
    b.onVoice(true)
    clock.advance(40)
    b.onVoice(false) // the cough ended
    clock.advance(400)
    b.onVoice(true) // a new run starts its own clock
    expect(stops()).toBe(0)
    expect(b.state.speaking).toBe(true)
  })

  it("does not interrupt when the assistant is not talking", () => {
    const {clock, b, stops} = setup({trigger: "vad", minVoicedMs: 10})
    b.onVoice(true)
    clock.advance(500)
    expect(b.onVoice(true)).toBe(false)
    expect(stops()).toBe(0)
  })

  it("does not interrupt twice for one utterance", () => {
    const {clock, b, stops} = setup({trigger: "vad", minVoicedMs: 10})
    b.beganSpeaking()
    b.onVoice(true)
    clock.advance(50)
    expect(b.onVoice(true)).toBe(true)
    expect(b.onVoice(true)).toBe(false) // already stopped
    expect(stops()).toBe(1)
  })
})

describe("the trigger is a mode, not a default", () => {
  it("in transcript mode, VAD alone never interrupts", () => {
    const {clock, b, stops} = setup({trigger: "transcript"})
    b.beganSpeaking()
    b.onVoice(true)
    clock.advance(5000)
    expect(b.onVoice(true)).toBe(false)
    expect(stops()).toBe(0)
  })

  it("in transcript mode, recognised speech interrupts", () => {
    const {b, stops} = setup({trigger: "transcript", minChars: 3})
    b.beganSpeaking()
    expect(b.onTranscript("actually")).toBe(true)
    expect(stops()).toBe(1)
  })

  it("in transcript mode, a scrap of text does not", () => {
    const {b, stops} = setup({trigger: "transcript", minChars: 3})
    b.beganSpeaking()
    expect(b.onTranscript("a")).toBe(false)
    expect(b.onTranscript("  ")).toBe(false)
    expect(stops()).toBe(0)
  })

  it("in vad mode, a transcript does not also fire", () => {
    const {b, stops} = setup({trigger: "vad"})
    b.beganSpeaking()
    expect(b.onTranscript("actually never mind")).toBe(false)
    expect(stops()).toBe(0)
  })

  it("in off mode, neither signal interrupts", () => {
    const {clock, b, stops} = setup({trigger: "off", minVoicedMs: 1})
    b.beganSpeaking()
    b.onVoice(true)
    clock.advance(100)
    expect(b.onVoice(true)).toBe(false)
    expect(b.onTranscript("stop")).toBe(false)
    expect(stops()).toBe(0)
  })

  it("always honours a tap, in every mode", () => {
    for (const trigger of ["vad", "transcript", "off"] as const) {
      const {b, stops} = setup({trigger})
      b.beganSpeaking()
      expect(b.onTap()).toBe(true)
      expect(stops()).toBe(1)
    }
  })

  it("ignores a tap when nothing is playing", () => {
    const {b, stops} = setup({trigger: "vad"})
    expect(b.onTap()).toBe(false)
    expect(stops()).toBe(0)
  })
})

describe("playback bookkeeping", () => {
  it("clears state when speech finishes on its own", () => {
    const {b} = setup({trigger: "vad"})
    b.beganSpeaking()
    expect(b.state.speaking).toBe(true)
    b.finishedSpeaking()
    expect(b.state.speaking).toBe(false)
    expect(b.state.startedAt).toBeNull()
  })

  it("reports no latency when nothing was interrupted", () => {
    const {b} = setup({trigger: "vad"})
    b.beganSpeaking()
    b.finishedSpeaking()
    expect(b.lastLatencyMs()).toBeNull()
  })
})

// ---------------------------------------------------------------------------

function tier(name: string, chunks: string[], opts: {throws?: boolean} = {}): ModelClient {
  return {
    name,
    async *complete(_prompt: string, signal: AbortSignal) {
      for (const c of chunks) {
        if (signal.aborted) throw new Error("aborted")
        yield c
      }
      if (opts.throws) throw new Error("boom")
    },
  }
}

describe("cancellation is not failure", () => {
  it("does not fall through to the next tier when the caller cancels", async () => {
    const tried: string[] = []
    const watch = (name: string): ModelClient => ({
      name,
      async *complete() {
        tried.push(name)
        yield "part"
      },
    })
    const router = new ModelRouter([watch("small"), watch("large")])
    const ctrl = new AbortController()
    // Cancel as soon as the first chunk lands — the wearer spoke over it.
    await expect(
      router.complete("q", {
        signal: ctrl.signal,
        onChunk: () => ctrl.abort(),
      }),
    ).rejects.toBeInstanceOf(CancelledError)
    expect(tried).toEqual(["small"])
  })

  it("refuses immediately when already cancelled", async () => {
    const router = new ModelRouter([tier("small", ["hi"])])
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(router.complete("q", {signal: ctrl.signal})).rejects.toBeInstanceOf(CancelledError)
  })

  it("still falls through on a real failure", async () => {
    const router = new ModelRouter([tier("small", ["x"], {throws: true}), tier("large", ["ok"])])
    const r = await router.complete("q")
    expect(r.via).toBe("large")
    expect(r.text).toBe("ok")
  })
})

// ---------------------------------------------------------------------------

describe("the outbound limit", () => {
  it("allows five in ten minutes on one confirmation", () => {
    const clock = new FakeClock()
    const limit = new OutboundLimit(clock)
    for (let i = 0; i < 5; i++) {
      expect(limit.check().reconfirm).toBe(false)
      limit.record()
    }
    expect(limit.remaining()).toBe(0)
  })

  it("asks a second time rather than refusing the sixth", () => {
    const clock = new FakeClock()
    const limit = new OutboundLimit(clock)
    for (let i = 0; i < 5; i++) limit.record()
    const v = limit.check()
    expect(v.allow).toBe(true)
    expect(v.reconfirm).toBe(true)
  })

  it("keeps asking rather than quietly giving up after the first excess", () => {
    const clock = new FakeClock()
    const limit = new OutboundLimit(clock)
    for (let i = 0; i < 8; i++) {
      limit.record()
    }
    expect(limit.check().reconfirm).toBe(true)
  })

  it("says how long until it stops asking", () => {
    const clock = new FakeClock()
    const limit = new OutboundLimit(clock)
    for (let i = 0; i < 5; i++) limit.record()
    const v = limit.check()
    expect(v.reconfirm && v.msUntilFree).toBe(10 * 60 * 1000)
    clock.advance(4 * 60 * 1000)
    const later = limit.check()
    expect(later.reconfirm && later.msUntilFree).toBe(6 * 60 * 1000)
  })

  it("rolls forward", () => {
    const clock = new FakeClock()
    const limit = new OutboundLimit(clock)
    for (let i = 0; i < 5; i++) limit.record()
    expect(limit.check().reconfirm).toBe(true)
    clock.advance(10 * 60 * 1000 + 1)
    expect(limit.check().reconfirm).toBe(false)
    expect(limit.remaining()).toBe(5)
  })

  it("is a separate budget from the inbound interruption one", () => {
    // Five outbound in ten minutes; six inbound an hour. Different windows,
    // different limits, different purposes — merging them would mean a chatty
    // hour silenced the wearer's own messages.
    const clock = new FakeClock()
    expect(new OutboundLimit(clock).remaining()).toBe(5)
  })
})
