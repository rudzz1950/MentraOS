import {describe, expect, test} from "bun:test"

import {BargeIn} from "../bargein"
import type {Transcript} from "../ports"
import {TranscriptStabilizer} from "../stabilize"

function rig(finalGraceMs?: number) {
  const clock = {t: 0, now: () => clock.t}
  const committed: string[] = []
  const finals: {text: string; via: string}[] = []
  const s = new TranscriptStabilizer({
    clock,
    finalGraceMs,
    onCommitted: t => committed.push(t),
    onFinal: (text, via) => finals.push({text, via}),
  })
  return {clock, s, committed, finals}
}

describe("partials do not flicker", () => {
  test("a word is committed only when two partials agree on it", () => {
    const {s, committed} = rig()
    s.partial("send")
    expect(committed).toEqual([])
    s.partial("send the")
    expect(committed).toEqual(["send"])
    s.partial("send the deck")
    expect(committed).toEqual(["send", "send the"])
  })

  test("a revision of unconfirmed words is never shown", () => {
    // The recogniser's three readings of one sentence.
    const {s, committed} = rig()
    s.partial("set")
    s.partial("send the")
    s.partial("send the deck")
    s.partial("send the deck to")
    expect(committed).toEqual(["send the", "send the deck"])
  })

  test("committed text only ever grows within an utterance", () => {
    const {s, committed} = rig()
    for (const p of ["book a", "book a table", "book a cable", "book a table for", "book a table for two"]) s.partial(p)
    for (let i = 1; i < committed.length; i++) expect(committed[i].startsWith(committed[i - 1])).toBe(true)
  })

  test("a recogniser revising an agreed word does not retract it", () => {
    const {s, committed} = rig()
    s.partial("call mom")
    s.partial("call mom now")
    expect(s.stableText).toBe("call mom")
    s.partial("call tom now")
    s.partial("call tom now please")
    // "mom" stays shown; nothing new is committed until agreement resumes past it.
    expect(s.stableText).toBe("call mom")
    expect(committed).toEqual(["call mom"])
  })

  test("case and trailing punctuation do not break agreement", () => {
    const {s} = rig()
    s.partial("Send")
    s.partial("send, the")
    expect(s.stableText).toBe("send,")
  })
})

describe("barge-in acts only on words that will still be there", () => {
  test("a retracted partial never triggers an interrupt", () => {
    const clock = {t: 0, now: () => clock.t}
    let interrupts = 0
    const barge = new BargeIn({clock, trigger: "transcript", minChars: 3, onInterrupt: () => interrupts++})
    barge.beganSpeaking()
    const s = new TranscriptStabilizer({clock, onCommitted: t => barge.onTranscript(t)})

    // A cough heard as a word, then nothing: it never reaches barge-in.
    s.partial("ahem")
    s.partial("")
    s.final("")
    expect(interrupts).toBe(0)

    // Real speech that the recogniser keeps does.
    s.partial("wait stop")
    s.partial("wait stop that")
    expect(interrupts).toBe(1)
  })
})

describe("endpointing", () => {
  test("the recogniser's final ends the utterance", () => {
    const {s, finals} = rig()
    s.partial("set a timer")
    s.final("set a timer for ten minutes")
    expect(finals).toEqual([{text: "set a timer for ten minutes", via: "recognizer"}])
  })

  test("VAD silence alone waits for the recogniser instead of clipping the last word", () => {
    const {clock, s, finals} = rig(800)
    s.partial("send the")
    s.vadEnd()
    clock.t = 500
    s.tick()
    expect(finals).toEqual([])
    // The decoder catches up with the last word inside the grace period.
    s.final("send the deck")
    expect(finals).toEqual([{text: "send the deck", via: "recognizer"}])
  })

  test("no final at all: the last partial is used in full after the grace period", () => {
    const {clock, s, finals} = rig(800)
    s.partial("remind me")
    s.partial("remind me at six")
    s.vadEnd()
    expect(s.nextDeadline()).toBe(800)
    clock.t = 799
    s.tick()
    expect(finals).toEqual([])
    clock.t = 800
    s.tick()
    // Includes "at six", which was never committed: nothing more is coming to confirm it.
    expect(finals).toEqual([{text: "remind me at six", via: "vad_timeout"}])
    expect(s.nextDeadline()).toBeNull()
  })

  test("speech resuming inside the grace period cancels the VAD endpoint", () => {
    const {clock, s, finals} = rig(800)
    s.partial("book a table")
    s.vadEnd()
    clock.t = 400
    s.vadStart()
    s.partial("book a table for two")
    clock.t = 2000
    s.tick()
    expect(finals).toEqual([])
  })

  test("a partial after the VAD went quiet means the VAD was early", () => {
    const {clock, s, finals} = rig(800)
    s.partial("call")
    s.vadEnd()
    clock.t = 300
    s.partial("call mom")
    clock.t = 1200
    s.tick()
    expect(finals).toEqual([])
  })

  test("exactly one final per utterance, and the next one starts clean", () => {
    const {clock, s, finals, committed} = rig(800)
    s.partial("first one")
    s.partial("first one done")
    s.final("first one done")
    s.vadEnd()
    clock.t = 5000
    s.tick()
    expect(finals.length).toBe(1)

    committed.length = 0
    s.partial("second")
    s.partial("second try")
    expect(committed).toEqual(["second"])
  })

  test("VAD end with nothing heard is not an utterance", () => {
    const {clock, s, finals} = rig()
    s.vadEnd()
    clock.t = 10_000
    s.tick()
    s.final("")
    expect(finals).toEqual([])
  })
})

describe("attaching to a recogniser", () => {
  test("routes partials and finals from a TranscriptSource", () => {
    const {s, finals, committed} = rig()
    let handler!: (t: Transcript) => void
    let unsubscribed = false
    const off = s.attach({
      on(h) {
        handler = h
        return () => (unsubscribed = true)
      },
    })
    handler({text: "what time", isFinal: false})
    handler({text: "what time is", isFinal: false})
    handler({text: "what time is it", isFinal: true})
    expect(committed).toEqual(["what time"])
    expect(finals).toEqual([{text: "what time is it", via: "recognizer"}])
    off()
    expect(unsubscribed).toBe(true)
  })
})
