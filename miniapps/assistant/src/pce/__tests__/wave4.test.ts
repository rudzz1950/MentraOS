/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {routePolicy, MIXED_USE_SOAK} from "../../agent/audioroute"
import {ModelRouter} from "../../agent/model"
import type {ModelClient, Voice} from "../../agent/ports"
import {SentenceSplitter, StreamingSpeaker} from "../../agent/speech"
import {Assistant} from "../../agent/turn"
import {MemoryService} from "../../memory/memory"
import {MemoryBlobStore, MemoryKeyValueStore} from "../../memory/ports"
import {VisionInput} from "../../vision/input"
import {crc32, MediaStore, TransferReceiver, WebCryptoCipher, parseManifest} from "../../vision/media"
import type {OcrEngine} from "../../vision/prepare"
import {ProductQa} from "../../vision/product"
import {CameraIndicatorView} from "../camera"
import {DataLifecycle, type GovernedMeta} from "../lifecycle"
import {PolicyEngine, type ConsentGrant} from "../policy"

const tick = () => new Promise(r => setTimeout(r, 0))

class RecVoice implements Voice {
  said: string[] = []
  stops = 0
  fail = false
  private release: (() => void) | null = null
  constructor(private readonly hold = false) {}
  async speak(s: string[]) {
    if (this.fail) throw new Error("disconnected")
    this.said.push(...s)
    if (this.hold) await new Promise<void>(r => (this.release = r))
  }
  async stop() {
    this.stops++
    this.release?.()
    this.release = null
  }
  finishCurrent() {
    this.release?.()
    this.release = null
  }
}

describe("ANI-175: sentence splitting for streamed speech", () => {
  test("sentences complete as chunks arrive, without breaking abbreviations or decimals", () => {
    const s = new SentenceSplitter()
    expect(s.push("Dr. Rao says the oats have 3.")).toEqual([])
    expect(s.push("5 g of sugar. That's ")).toEqual(["Dr. Rao says the oats have 3.5 g of sugar."])
    expect(s.push("low! Anything else? ")).toEqual(["That's low!", "Anything else?"])
    expect(s.push("हाँ। ठीक")).toEqual(["हाँ।"])
    expect(s.flush()).toEqual(["ठीक"])
  })
})

describe("ANI-175: streaming speech", () => {
  function rig(opts: {glassesUp?: boolean; hold?: boolean} = {}) {
    const clock = {t: 0, now: () => clock.t}
    const glasses = new RecVoice(opts.hold)
    const phone = new RecVoice()
    const states: string[] = []
    const sp = new StreamingSpeaker({glasses, phone, glassesAvailable: () => opts.glassesUp ?? true, clock, onState: s => states.push(s)})
    return {sp, glasses, phone, clock, states}
  }

  test("the first sentence plays before the answer is finished", async () => {
    const {sp, glasses, clock} = rig()
    sp.begin()
    clock.t = 120
    sp.push("Standup is at ten. ")
    await tick()
    expect(glasses.said).toEqual(["Standup is at ten."])
    expect(sp.timeToFirstAudio()).toBe(120)
    sp.push("It's in room four")
    await sp.finish()
    expect(glasses.said).toEqual(["Standup is at ten.", "It's in room four"])
  })

  test("barge-in stops now, drops the queue, and ignores chunks that race in afterwards", async () => {
    const {sp, glasses} = rig({hold: true})
    sp.begin()
    sp.push("One. Two. Three. ")
    await tick()
    expect(glasses.said).toEqual(["One."])
    expect(await sp.stop()).toBeGreaterThanOrEqual(0)
    sp.push("Four. ")
    await tick()
    expect(glasses.said).toEqual(["One."])
    expect(sp.speechState).toBe("idle")
  })

  test("a tier that fails after being heard is called out, and the next answer starts clean", async () => {
    const {sp, glasses} = rig()
    sp.begin()
    sp.push("The vendor slipped by ")
    sp.push("two weeks. And ")
    await tick()
    expect(sp.restartAfterFailure()).toBe(true)
    sp.push("The vendor is late. ")
    await sp.finish()
    expect(glasses.said).toEqual(["The vendor slipped by two weeks.", "That answer was cut off.", "The vendor is late."])
  })

  test("a tier that fails before a word was heard leaves nothing to call out", async () => {
    const {sp, glasses} = rig()
    sp.begin()
    sp.push("half a sente")
    expect(sp.restartAfterFailure()).toBe(false)
    sp.push("Fine. ")
    await sp.finish()
    expect(glasses.said).toEqual(["Fine."])
  })

  test("pause re-says the interrupted sentence from its start on resume", async () => {
    const {sp, glasses} = rig({hold: true})
    sp.begin()
    sp.push("Turn left. Then right. ")
    await tick()
    await sp.pause()
    expect(sp.speechState).toBe("paused")
    sp.resume()
    await tick()
    expect(glasses.said).toEqual(["Turn left.", "Turn left."])
    glasses.finishCurrent()
    await tick()
    expect(glasses.said).toEqual(["Turn left.", "Turn left.", "Then right."])
  })

  test("muted speaks nothing", async () => {
    const {sp, glasses} = rig()
    await sp.setMuted(true)
    sp.begin()
    sp.push("Hello. ")
    await sp.finish()
    expect(glasses.said).toEqual([])
  })

  test("glasses unavailable or failing mid-answer falls back to the phone, saying so once", async () => {
    const {sp, glasses, phone} = rig()
    sp.begin()
    sp.push("First. ")
    await tick()
    glasses.fail = true
    sp.push("Second. Third. ")
    await sp.finish()
    expect(glasses.said).toEqual(["First."])
    expect(phone.said).toEqual(["Glasses audio isn't available, using the phone.", "Second.", "Third."])
    expect(sp.outputDevice).toBe("phone")
  })

  test("wired into the turn loop: speech starts while the model is still streaming", async () => {
    const glasses = new RecVoice()
    const phone = new RecVoice()
    const clock = {now: () => 0}
    const sp = new StreamingSpeaker({glasses, phone, glassesAvailable: () => true, clock})
    let spokenBeforeEnd: string[] = []
    const model: ModelClient = {
      name: "small",
      locality: "device",
      async *complete() {
        yield "Your next meeting is at three. "
        await tick()
        spokenBeforeEnd = [...glasses.said]
        yield "It's with Priya."
      },
    }
    const a = new Assistant({
      transcripts: {on: () => () => {}},
      hud: {show: async () => {}, clear: async () => {}},
      voice: phone,
      memory: new MemoryService({storage: new MemoryKeyValueStore(), blobs: new MemoryBlobStore(), now: () => 0}),
      router: new ModelRouter([model], 1000),
      clock,
      speech: sp,
    })
    const r = await a.handle("when is my next meeting", true)
    expect(r.answer).toBe("Your next meeting is at three. It's with Priya.")
    expect(spokenBeforeEnd).toEqual(["Your next meeting is at three."])
    expect(glasses.said).toEqual(["Your next meeting is at three.", "It's with Priya."])
  })

  test("in the turn loop, a failed tier that was heard is called out before the fallback answer", async () => {
    const glasses = new RecVoice()
    const sp = new StreamingSpeaker({glasses, phone: new RecVoice(), glassesAvailable: () => true, clock: {now: () => 0}})
    const flaky: ModelClient = {name: "small", locality: "device", async *complete() {
      yield "The answer is "
      yield "forty. Because "
      await tick()
      throw new Error("model crashed")
    }}
    const steady: ModelClient = {name: "heavy", locality: "device", async *complete() {
      yield "The answer is forty-two."
    }}
    const a = new Assistant({
      transcripts: {on: () => () => {}}, hud: {show: async () => {}, clear: async () => {}}, voice: new RecVoice(),
      memory: new MemoryService({storage: new MemoryKeyValueStore(), blobs: new MemoryBlobStore(), now: () => 0}),
      router: new ModelRouter([flaky, steady], 1000), clock: {now: () => 0}, speech: sp,
    })
    const r = await a.handle("what is the answer", true)
    expect(r.via).toBe("heavy")
    expect(glasses.said).toEqual(["The answer is forty.", "That answer was cut off.", "The answer is forty-two."])
  })
})

describe("ANI-176: audio route policy", () => {
  test("the speaker in the frame without echo cancellation never uses VAD barge-in", () => {
    expect(routePolicy("glasses_speaker", {aecActive: false, callActive: false})).toMatchObject({bargeIn: "transcript", vadBoostDbWhileSpeaking: 12, minWords: 2})
    expect(routePolicy("glasses_speaker", {aecActive: true, callActive: false}).bargeIn).toBe("vad")
    expect(routePolicy("earbuds", {aecActive: false, callActive: false}).bargeIn).toBe("vad")
    expect(routePolicy("phone_speaker", {aecActive: true, callActive: false}).bargeIn).toBe("transcript")
    expect(routePolicy("earbuds", {aecActive: true, callActive: true}).bargeIn).toBe("off")
    expect(MIXED_USE_SOAK.durationMin).toBe(30)
  })
})

describe("ANI-167: receiving media", () => {
  async function frames(data: Uint8Array, chunk = 1024, id = 7, sealed = true) {
    const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", data))
    const n = Math.ceil(data.length / chunk)
    const m = new Uint8Array(44)
    const v = new DataView(m.buffer)
    m[0] = 0xb1
    v.setUint16(1, id, true)
    v.setUint32(3, data.length, true)
    v.setUint16(7, chunk, true)
    v.setUint16(9, n, true)
    m.set(sha, 11)
    m[43] = sealed ? 1 : 0
    const chunks = []
    for (let i = 0; i < n; i++) {
      const part = data.slice(i * chunk, (i + 1) * chunk)
      const f = new Uint8Array(11 + part.length)
      const fv = new DataView(f.buffer)
      f[0] = 0xb0
      fv.setUint16(1, id, true)
      fv.setUint16(3, i, true)
      fv.setUint16(5, part.length, true)
      fv.setUint32(7, crc32(part), true)
      f.set(part, 11)
      chunks.push(f)
    }
    return {manifest: m, chunks}
  }
  const img = Uint8Array.from({length: 2500}, (_, i) => (i * 31 + 7) & 0xff)
  const rx = (over: Partial<ConstructorParameters<typeof TransferReceiver>[0]> = {}) =>
    new TransferReceiver({sessionId: "sess-1", now: () => 0, fastLink: true, kind: "still", requireSealed: false, ...over})

  test("CRC-32 matches the firmware's check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
  })

  test("chunks in any order, duplicated, become one verified file", async () => {
    const {manifest, chunks} = await frames(img)
    const r = rx()
    expect(r.onManifest(manifest, "sess-1")).toEqual({ok: true})
    for (const c of [chunks[2], chunks[0], chunks[0], chunks[1]]) expect((await r.onChunk(c)).ok).toBe(true)
    const done = await r.complete()
    expect(done.ok && done.media.bytes).toEqual(img)
  })

  test("an interrupted transfer reports what is missing, resumes, and is never exposed partially", async () => {
    const {manifest, chunks} = await frames(img)
    const r = rx()
    r.onManifest(manifest, "sess-1")
    await r.onChunk(chunks[0])
    expect(r.missing()).toEqual([1, 2])
    expect(await r.complete()).toEqual({ok: false, reason: "incomplete"})
    await r.onChunk(chunks[1])
    await r.onChunk(chunks[2])
    expect((await r.complete()).ok).toBe(true)
  })

  test("a corrupted chunk is not acknowledged; a tampered file fails integrity", async () => {
    const {manifest, chunks} = await frames(img)
    const r = rx()
    r.onManifest(manifest, "sess-1")
    const bad = chunks[1].slice()
    bad[20] ^= 0xff
    expect(await r.onChunk(bad)).toEqual({ok: false, reason: "crc"})
    // Tamper consistently (CRC recomputed) so only the whole-file hash can catch it.
    const evil = chunks[1].slice()
    evil[20] ^= 0xff
    new DataView(evil.buffer).setUint32(7, crc32(evil.slice(11)), true)
    await r.onChunk(chunks[0])
    await r.onChunk(evil)
    await r.onChunk(chunks[2])
    expect(await r.complete()).toEqual({ok: false, reason: "integrity"})
  })

  test("wrong session, oversize, unsealed and clips over BLE are refused up front", async () => {
    const {manifest} = await frames(img)
    expect(rx().onManifest(manifest, "someone-else")).toEqual({ok: false, reason: "wrong_session"})
    const unsealed = (await frames(img, 1024, 7, false)).manifest
    expect(rx({requireSealed: true}).onManifest(unsealed, "sess-1")).toEqual({ok: false, reason: "not_sealed"})
    expect(rx({fastLink: false, kind: "clip"}).onManifest(manifest, "sess-1")).toEqual({ok: false, reason: "clip_needs_fast_link"})
    expect(rx({fastLink: false}).onManifest(manifest, "sess-1")).toEqual({ok: true})
    const big = new Uint8Array(44)
    big.set(manifest)
    new DataView(big.buffer).setUint32(3, 600 * 1024, true)
    new DataView(big.buffer).setUint16(9, Math.ceil((600 * 1024) / 1024), true)
    expect(rx().onManifest(big, "sess-1")).toEqual({ok: false, reason: "too_large"})
    expect(parseManifest(new Uint8Array(10))).toBeNull()
  })

  test("a stalled transfer times out", async () => {
    const clock = {t: 0}
    const {manifest, chunks} = await frames(img)
    const r = rx({now: () => clock.t, timeoutMs: 1000})
    r.onManifest(manifest, "sess-1")
    await r.onChunk(chunks[0])
    clock.t = 1001
    expect(await r.complete()).toEqual({ok: false, reason: "timeout"})
  })
})

describe("ANI-169: the media lifecycle", () => {
  async function rig() {
    const c = {t: 1_000_000, now: () => c.t}
    const policy = new PolicyEngine({now: c.now, verify: () => true})
    let n = 0
    const grant = (scopeId: string) => policy.apply({kind: "grant", eventId: `g${++n}`, scopeId, purposes: ["vision_qa"], categories: ["image"], maxReach: "cloud", issuedAt: c.t, expiresAt: c.t + 3_600_000, signature: "x"} as ConsentGrant)
    const life = new DataLifecycle({policy, now: c.now, reachable: () => true})
    const store = new MediaStore({lifecycle: life, cipher: await WebCryptoCipher.generate(), now: c.now})
    const meta = (scopeId: string, ttl = 120_000): GovernedMeta => ({scopeId, purpose: "vision_qa", expiresAt: c.t + ttl, provenance: "captured", ownerUserId: "u1"})
    return {c, policy, grant, life, store, meta}
  }
  const photo = new TextEncoder().encode("JPEG-BYTES-OF-A-CEREAL-BOX")

  test("media is encrypted at rest and readable while live", async () => {
    const {store, grant, meta} = await rig()
    grant("s1")
    expect(await store.put("media:c1", photo, meta("s1"))).toEqual({ok: true, ref: "media:c1"})
    expect(new TextDecoder().decode(store.rawAtRest("media:c1")!)).not.toContain("CEREAL")
    expect(await store.get("media:c1")).toEqual(photo)
  })

  test("an unscoped or revoked capture is never stored", async () => {
    const {store, meta} = await rig()
    expect(await store.put("media:c2", photo, {...meta("s9"), scopeId: ""})).toMatchObject({ok: false, reason: "missing_metadata"})
    expect(await store.put("media:c2", photo, meta("never-granted"))).toMatchObject({ok: false, reason: "purpose_not_granted"})
  })

  test("revoking the scope deletes the photo and every derivative, with a receipt of counts", async () => {
    const {store, grant, meta, life} = await rig()
    grant("s1")
    await store.put("media:c1", photo, meta("s1"))
    store.thumbnails.put("media:c1", new Uint8Array([1]), meta("s1"))
    store.ocr.put("media:c1", "MASALA OATS", meta("s1"))
    store.summaries.put("media:c1", "a cereal box", meta("s1"))
    store.modelCache.put("media:c1", {answer: "3.5 g"}, meta("s1"))
    const receipt = await life.revoke("s1", {kind: "revoke", eventId: "r1", scopeId: "s1", issuedAt: 0, signature: "x"})
    expect(receipt.complete).toBe(true)
    expect(receipt.stores.filter(s => s.deleted > 0).map(s => s.store).sort()).toEqual(["capture_media", "capture_model_cache", "capture_ocr", "capture_summaries", "capture_thumbnails"])
    expect(JSON.stringify(receipt)).not.toContain("OATS")
    expect(await store.get("media:c1")).toBeNull()
    expect(store.ocr.get("media:c1")).toBeUndefined()
  })

  test("expiry removes the photo and its derivatives together", async () => {
    const {store, grant, meta, c} = await rig()
    grant("s1")
    await store.put("media:c1", photo, meta("s1", 1000))
    store.ocr.put("media:c1", "text", meta("s1", 1000))
    c.t += 1001
    expect(await store.expire()).toBe(1)
    expect(store.ocr.get("media:c1")).toBeUndefined()
  })
})

describe("ANI-168: a capture into the assistant", () => {
  test("a verified capture becomes the active one; bad ones get an honest sentence", async () => {
    const c = {t: 1_000_000, now: () => c.t}
    const policy = new PolicyEngine({now: c.now, verify: () => true})
    policy.apply({kind: "grant", eventId: "g", scopeId: "s1", purposes: ["vision_qa"], categories: ["image"], maxReach: "cloud", issuedAt: c.t, expiresAt: c.t + 3_600_000, signature: "x"})
    const life = new DataLifecycle({policy, now: c.now, reachable: () => true})
    const media = new MediaStore({lifecycle: life, cipher: await WebCryptoCipher.generate(), now: c.now})
    const asked: string[] = []
    const qa = new ProductQa({now: c.now, consent: policy.forPurpose("vision_qa"), mode: "scene", model: {name: "m", locality: "cloud", async ask(r) {
      asked.push(r.prompt)
      return {schema_version: 1, capture_id: r.image.captureId, answer_text: "It says Platform 4.", source_tier: "label", evidence_items: [{field_name: "other", extracted_value: "Platform 4", confidence: 0.9}], confidence: 0.9, follow_up_required: "none"}
    }}})
    const sharp = {width: 40, height: 30, data: Uint8Array.from({length: 1200}, (_, i) => ((i % 40) % 6 < 2 && Math.floor(i / 40) % 10 < 6 ? 40 : 200))}
    const ocr: OcrEngine = {name: "ocr", recognize: async () => [{text: "Platform 4", region: {x: 0.1, y: 0.1, w: 0.4, h: 0.1}, confidence: 0.9}]}
    const input = new VisionInput({media, qa, ocr, decodeGray: async () => sharp, firstPass: async () => [], sessionId: () => "sess-1", now: c.now})
    const ref = {ref: "media:c1", sessionId: "sess-1", mimeType: "image/jpeg" as const, width: 40, height: 30}

    expect(await input.accept({...ref, sessionId: "other"})).toMatchObject({ok: false, reason: "wrong_session"})
    expect(await input.accept(ref)).toMatchObject({ok: false, reason: "unknown"})
    await media.put("media:c1", new Uint8Array([1, 2, 3]), {scopeId: "s1", purpose: "vision_qa", expiresAt: c.t + 120_000, provenance: "captured", ownerUserId: "u"})
    expect(await input.accept(ref)).toEqual({ok: true, captureId: "media:c1", lines: 1})
    expect(media.ocr.get("media:c1")).toBe("Platform 4")
    const a = await qa.ask("which platform is this?")
    expect(a).toMatchObject({ok: true, text: "It says Platform 4."})
    expect(asked[0]).toContain("a document, an object or a scene")
  })
})

describe("ANI-172: the camera indicator on the phone", () => {
  test("never 'off' without a fresh report", () => {
    const c = {t: 0, now: () => c.t}
    const v = new CameraIndicatorView({now: c.now})
    expect(v.label()).toBe("Camera may be active")
    v.report("ready")
    expect(v.label()).toBe("Camera off")
    v.report("capturing")
    expect(v.label()).toBe("Camera recording")
    v.linkLost()
    expect(v.label()).toBe("Camera may be active")
    v.report("ready")
    c.t += 6000
    expect(v.label()).toBe("Glasses not connected")
    v.report("error")
    expect(v.label()).toBe("Camera indicator fault: camera disabled")
  })

  test("after an app crash with a capture open, it starts uncertain", () => {
    expect(CameraIndicatorView.afterCrash({now: () => 0}, true).state()).toBe("uncertain")
  })
})
