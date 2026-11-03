/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {CommandTracker, degradeFor, EVENTS, readPayload, registerEcosystem, ttlFor} from "../../bus/ecosystem"
import {EventReceiver, EventSender, SchemaRegistry} from "../../bus/envelope"
import {Guidance} from "../../nav/guidance"
import {forLog, PositionService, type RawFix} from "../../nav/position"
import type {ProductAnswer} from "../../vision/answer"
import {ProductConversation} from "../../vision/conversation"
import {normalisedSize, orientation, planCrops, prepare, quality, retakeAdvice, validGtin, type GrayImage, type OcrEngine, type OcrLine} from "../../vision/prepare"
import type {VisionModel} from "../../vision/ports"
import {ProductQa} from "../../vision/product"

describe("ANI-177: the ecosystem contract", () => {
  function rig() {
    const c = {t: 1_000_000, now: () => c.t}
    const ringClock = {t: 0}
    const sender = new EventSender({deviceId: "ring-1", accountId: "acct", module: "gesture"}, "s1", () => ringClock.t)
    const glasses = new EventSender({deviceId: "gl-1", accountId: "acct", module: "hud"}, "s2", () => ringClock.t)
    const rx = new EventReceiver({registry: registerEcosystem(new SchemaRegistry()), accountId: "acct", now: c.now})
    const intent = (type: string, payload: unknown = {}) => sender.make(type, payload, {schemaVersion: 1, priority: "interactive", ttlMs: ttlFor(type)})
    return {c, ringClock, sender, glasses, rx, intent}
  }

  test("every contract event registers, with the right priority", () => {
    const {rx, intent} = rig()
    expect(rx.receive(intent("intent.scroll", {direction: "down"}), "ring-1").ok).toBe(true)
    expect(EVENTS.length).toBe(11)
  })

  test("known fields are type-checked; unknown fields are ignored for forward compatibility", () => {
    expect(readPayload("intent.scroll", {direction: "sideways"})).toBeNull()
    expect(readPayload("intent.scroll", {})).toBeNull()
    expect(readPayload("intent.scroll", {direction: "up", velocity: 3, added_in_v2: true})).toEqual({direction: "up"})
    expect(readPayload("telemetry.battery", {percent: 101, charging: false})).toBeNull()
    expect(readPayload("telemetry.link", {rssi_dbm: -70})).toEqual({rssi_dbm: -70})
    expect(readPayload("response.nack", {command_id: "x", reason: "teapot"})).toBeNull()
    expect(readPayload("intent.select", {})).toEqual({})
    expect(readPayload("intent.select", null)).toBeNull()
    expect(readPayload("intent.unknown", {})).toBeNull()
  })

  test("a newer contract version than this phone supports is refused, not misread", () => {
    const {rx, sender} = rig()
    const e = sender.make("intent.select", {}, {schemaVersion: 2, priority: "interactive", ttlMs: 800})
    expect(rx.receive(e, "ring-1")).toMatchObject({ok: false, reason: "unsupported_version"})
  })

  test("duplicate, delayed and out-of-order intents never cause a second action", () => {
    const {rx, intent, c} = rig()
    const a = intent("intent.select")
    const b = intent("intent.back")
    expect(rx.receive(a, "ring-1").ok).toBe(true)
    expect(rx.receive(a, "ring-1")).toMatchObject({reason: "duplicate"})
    expect(rx.receive(b, "ring-1").ok).toBe(true)
    expect(rx.receive({...a, eventId: "a2", idempotencyKey: "a2"}, "ring-1")).toMatchObject({reason: "stale_sequence"})
    const late = intent("intent.dismiss")
    c.t += 801
    expect(rx.receive(late, "ring-1")).toMatchObject({reason: "expired"})
  })

  test("commands get exactly one outcome: ACK, NACK or timeout", async () => {
    const {c, intent, glasses} = rig()
    const tr = new CommandTracker(c.now)
    const resp = (type: "response.ack" | "response.nack", payload: unknown) => glasses.make(type, payload, {schemaVersion: 1, priority: "interactive", ttlMs: 5000})

    const i1 = intent("intent.scroll", {direction: "up"})
    const p1 = tr.track(i1)
    c.t += 40
    tr.onResponse(resp("response.ack", {command_id: i1.eventId}))
    expect(await p1).toEqual({status: "acked", commandId: i1.eventId, latencyMs: 40})
    tr.onResponse(resp("response.ack", {command_id: i1.eventId}))
    expect(tr.ignored).toEqual([{commandId: i1.eventId, why: "already_answered"}])

    const i2 = intent("intent.capture_request", {purpose: "vision_qa"})
    const p2 = tr.track(i2)
    tr.onResponse(resp("response.nack", {command_id: i2.eventId, reason: "not_permitted"}))
    expect(await p2).toEqual({status: "nacked", commandId: i2.eventId, reason: "not_permitted"})

    const i3 = intent("intent.select")
    const p3 = tr.track(i3)
    c.t += 801
    tr.onResponse(resp("response.ack", {command_id: i3.eventId}))
    expect(tr.ignored.at(-1)).toEqual({commandId: i3.eventId, why: "late"})
    expect(tr.tick()).toEqual([{status: "timeout", commandId: i3.eventId}])
    expect(await p3).toEqual({status: "timeout", commandId: i3.eventId})
    expect(tr.pending).toBe(0)
  })

  test("old firmware degrades instead of being sent what it cannot do", () => {
    const old = (cmd: string) => ["intent.select", "intent.back"].includes(cmd)
    expect(degradeFor("intent.dismiss", old)).toEqual({send: "intent.back"})
    expect(degradeFor("intent.assistant_activate", old)).toEqual({send: "intent.select"})
    expect(degradeFor("intent.capture_request", old)).toEqual({unsupported: true})
    expect(degradeFor("intent.scroll", () => true)).toEqual({send: "intent.scroll"})
  })
})

describe("ANI-235: preparing a capture", () => {
  function image(w: number, h: number, f: (x: number, y: number) => number): GrayImage {
    const data = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.max(0, Math.min(255, Math.round(f(x, y))))
    return {width: w, height: h, data}
  }
  // A label: dark text strokes on a light background.
  const sharp = image(80, 60, (x, y) => ((x % 6 < 2 && y % 10 < 6) ? 40 : 200))
  const blurred = image(80, 60, (x, _y) => 120 + 20 * Math.sin(x / 15))
  const glare = image(80, 60, (x, y) => (x > 20 && y > 10 ? 255 : (x % 6 < 2 ? 40 : 200)))
  const dark = image(80, 60, (x, y) => ((x % 6 < 2 && y % 10 < 6) ? 2 : 30))

  test("good and bad captures separate on the quality checks", () => {
    expect(quality(sharp).ok).toBe(true)
    expect(quality(blurred).problems).toContain("blurred")
    expect(quality(glare).problems).toContain("glare")
    expect(quality(dark).problems).toContain("too_dark")
    expect(quality(sharp, {textHeightsPx: [6, 8]}).problems).toEqual(["text_too_small"])
    expect(retakeAdvice(["blurred", "glare"])).toBe("I can't read the label: hold still, tilt away from the light, and try again.")
  })

  test("orientation and size: upright, bounded, never upscaled", () => {
    expect(orientation(6)).toEqual({rotate: 90, mirror: false})
    expect(orientation(99)).toEqual({rotate: 0, mirror: false})
    expect(normalisedSize(4000, 3000, 6)).toEqual({width: 1200, height: 1600, scale: 0.4})
    expect(normalisedSize(800, 600)).toEqual({width: 800, height: 600, scale: 1})
  })

  const line = (text: string, x: number, y: number, w = 0.3, h = 0.03): OcrLine => ({text, region: {x, y, w, h}, confidence: 0.9})

  test("crops follow label headings, in English and Hindi, and merge when they overlap", () => {
    const layoutA = [line("Ingredients: oats, salt", 0.1, 0.5), line("Nutrition per 100 g", 0.6, 0.1), line("MRP ₹45", 0.7, 0.9, 0.2)]
    const fields = planCrops(layoutA).map(c => c.field).sort()
    expect(fields).toEqual(["ingredients", "nutrition", "price"])
    const hindi = planCrops([line("सामग्री: जई, नमक", 0.1, 0.1), line("पोषण मूल्य", 0.1, 0.6)])
    expect(hindi.map(c => c.field).sort()).toEqual(["ingredients", "nutrition"])
    const merged = planCrops([line("Ingredients", 0.1, 0.1), line("Contains milk", 0.1, 0.15)])
    expect(merged.length).toBe(1)
    for (const c of planCrops(layoutA)) {
      expect(c.region.x).toBeGreaterThanOrEqual(0)
      expect(c.region.x + c.region.w).toBeLessThanOrEqual(1)
      expect(c.region.y + c.region.h).toBeLessThanOrEqual(1)
    }
  })

  test("nothing recognised: the whole image is read, so nothing is lost to cropping", () => {
    expect(planCrops([])).toEqual([{field: "full", region: {x: 0, y: 0, w: 1, h: 1}}])
  })

  test("barcodes are checksum-validated and never trusted", () => {
    expect(validGtin("8901058000290")).toBe("8901058000290")
    expect(validGtin("8901058000291")).toBeNull()
    expect(validGtin("036000291452")).toBe("036000291452")
    expect(validGtin("12345")).toBeNull()
  })

  test("the full pipeline: OCR lines in full-image coordinates, scope carried, payment-like text flagged", async () => {
    const seen: string[] = []
    const ocr: OcrEngine = {
      name: "fake-ocr",
      async recognize(_ref, crop) {
        seen.push(JSON.stringify(crop))
        return [{text: crop.y > 0.4 ? "Ingredients: oats; scan to pay upi://pay?pa=x@y" : "Energy 389 kcal", region: {x: 0.5, y: 0.5, w: 0.5, h: 0.1}, confidence: 0.88, language: "en"}]
      },
    }
    const r = await prepare({
      captureRef: "media:c1-norm", originalRef: "media:c1", scopeId: "scope-1", expiresAt: 2000, now: 1000,
      image: sharp, firstPass: [line("Ingredients", 0.1, 0.5, 0.3, 0.3), line("Nutrition", 0.6, 0.05, 0.3, 0.3)],
      barcodeDigits: "8901058000290", ocr,
    })
    if (!r.ok) throw new Error(r.advice)
    expect(r.capture).toMatchObject({scopeId: "scope-1", expiresAt: 2000, originalRef: "media:c1", ocrEngine: "fake-ocr", barcode: {gtin: "8901058000290", trusted: false}})
    const ing = r.capture.lines.find(l => l.field === "ingredients")!
    expect(ing.paymentLike).toBe(true)
    // Mapped back from crop coordinates.
    expect(ing.region.x).toBeGreaterThan(0.1)
    expect(ing.confidence).toBe(0.88)
    expect(seen.length).toBe(2)
  })

  test("a bad or expired capture becomes advice, not text", async () => {
    const ocr: OcrEngine = {name: "x", recognize: async () => []}
    const base = {captureRef: "media:c", originalRef: "media:c", scopeId: "s", now: 1000, firstPass: [], ocr}
    expect(await prepare({...base, expiresAt: 2000, image: blurred})).toMatchObject({ok: false, reason: "quality"})
    expect(await prepare({...base, expiresAt: 999, image: sharp})).toMatchObject({ok: false, reason: "expired"})
  })
})

describe("ANI-237: product questions as a conversation", () => {
  const OCR = [{text: "Nutrition per 100 g: Total Sugars 3,5 g"}, {text: "Ingredients: Rolled oats (85%), spices, salt."}]
  const ans = (over: Partial<ProductAnswer>): ProductAnswer => ({
    schema_version: 1, capture_id: "cap-1", answer_text: "It has 3.5 g of sugar per 100 g.", source_tier: "label",
    evidence_items: [{field_name: "nutrition", extracted_value: "Total Sugars 3,5 g", confidence: 0.9}, {field_name: "nutrition", extracted_value: "per 100 g", confidence: 0.9}],
    confidence: 0.9, follow_up_required: "none", ...over,
  })
  function rig(opts: {glassesAudio?: boolean; glassesFails?: boolean; slow?: boolean} = {}) {
    const said: {where: string; text: string[]}[] = []
    const shown: string[][] = []
    let stops = 0
    const replies = [ans({}), ans({answer_text: "Rolled oats, spices and salt.", evidence_items: [{field_name: "ingredients", extracted_value: "Rolled oats (85%), spices, salt", confidence: 0.9}]}), ans({answer_text: "Salt is listed.", evidence_items: [{field_name: "ingredients", extracted_value: "salt", confidence: 0.9}]})]
    const model: VisionModel = {
      name: "fake", locality: "cloud",
      async ask(_r, signal) {
        if (opts.slow) await new Promise((res, rej) => {
          const t = setTimeout(res, 50)
          signal?.addEventListener("abort", () => {
            clearTimeout(t)
            rej(new Error("aborted"))
          })
        })
        return replies.shift()
      },
    }
    const qa = new ProductQa({model, now: () => 1000, consent: {reach: () => "cloud"}})
    qa.setCapture({image: {captureId: "cap-1", mimeType: "image/jpeg", bytes: new Uint8Array([1])}, scopeId: "s", ocr: OCR, takenAt: 1000})
    const voice = (where: string, fail = false) => ({
      async speak(s: string[]) {
        if (fail) throw new Error("disconnected")
        said.push({where, text: s})
      },
      async stop() {
        stops++
      },
    })
    const conv = new ProductConversation({
      qa, hud: {show: async l => void shown.push(l), clear: async () => {}},
      glassesVoice: voice("glasses", opts.glassesFails), phoneVoice: voice("phone"), glassesAudio: () => opts.glassesAudio ?? true,
    })
    return {conv, said, shown, stops: () => stops}
  }

  test("ask, then two follow-ups on the same capture, all heard on the glasses", async () => {
    const {conv, said, shown} = rig()
    expect(await conv.onUtterance("how much sugar")).toMatchObject({kind: "answered", output: "glasses"})
    expect(await conv.onUtterance("read the ingredients")).toMatchObject({kind: "answered", output: "glasses"})
    expect(await conv.onUtterance("any salt?")).toMatchObject({kind: "answered"})
    expect(said.map(s => s.text[0])).toEqual(["It has 3.5 g of sugar per 100 g.", "Rolled oats, spices and salt.", "Salt is listed."])
    expect(shown[0][1]).toBe("from label")
    for (const l of shown) for (const row of l) expect(row.length).toBeLessThanOrEqual(22)
  })

  test("repeat, mute and unmute never reach the model", async () => {
    const {conv, said} = rig()
    await conv.onUtterance("how much sugar")
    expect(await conv.onUtterance("repeat that")).toMatchObject({kind: "repeated", output: "glasses"})
    expect(said.length).toBe(2)
    expect(await conv.onUtterance("mute")).toEqual({kind: "muted"})
    expect(await conv.onUtterance("read the ingredients")).toMatchObject({kind: "answered", output: "muted"})
    expect(await conv.onUtterance("unmute")).toEqual({kind: "unmuted"})
  })

  test("stop cancels a question in flight and nothing is spoken for it", async () => {
    const {conv, said, stops} = rig({slow: true})
    const pending = conv.onUtterance("how much sugar")
    expect(await conv.onUtterance("stop")).toEqual({kind: "stopped"})
    expect(await pending).toEqual({kind: "stopped"})
    expect(said).toEqual([])
    expect(stops()).toBe(2)
  })

  test("glasses audio unavailable or failing falls back to the phone, saying so once", async () => {
    const off = rig({glassesAudio: false})
    expect(await off.conv.onUtterance("how much sugar")).toMatchObject({output: "phone"})
    expect(off.said[0].text[0]).toBe("Glasses audio isn't available, using the phone.")
    await off.conv.onUtterance("read the ingredients")
    expect(off.said[1].text.length).toBe(1)
    const failing = rig({glassesFails: true})
    expect(await failing.conv.onUtterance("how much sugar")).toMatchObject({output: "phone"})
  })
})

describe("ANI-240: the position service", () => {
  const fix = (over: Partial<RawFix> = {}): RawFix => ({latitude: 12.97159, longitude: 77.59456, accuracyM: 8, timeMs: 1_700_000_000_000, elapsedMs: 10_000, source: "fused", ...over})
  function rig() {
    const c = {t: 10_000}
    return {s: new PositionService(() => c.t), c}
  }

  test("nothing is reported until permission is granted", () => {
    const {s} = rig()
    expect(s.onFix(fix())).toEqual([])
    s.setPermission("precise")
    expect(s.onFix(fix()).map(e => e.kind)).toEqual(["resume_route_updates", "fix"])
  })

  test("precise only when accurate and fresh; never exact when it is not", () => {
    const {s, c} = rig()
    s.setPermission("precise")
    s.onFix(fix())
    expect(s.current()!.quality).toBe("precise")
    c.t += 6000
    expect(s.current()!.quality).toBe("stale")
    c.t += 10_000
    expect(s.current()!.quality).toBe("lost")
    expect(s.forGuidance()).toBeNull()
    s.onFix(fix({elapsedMs: c.t, accuracyM: 45}))
    expect(s.current()!.quality).toBe("approximate")
  })

  test("approximate permission is always approximate", () => {
    const {s} = rig()
    s.setPermission("approximate")
    s.onFix(fix({accuracyM: 3}))
    expect(s.current()!.quality).toBe("approximate")
  })

  test("revoking permission or background restriction stops route updates and forgets the fix", () => {
    const {s} = rig()
    s.setPermission("precise")
    s.onFix(fix())
    expect(s.setPermission("denied")).toEqual([{kind: "stop_route_updates", reason: "permission_denied"}])
    expect(s.current()).toBeNull()
    expect(s.onFix(fix({elapsedMs: 11_000}))).toEqual([])
    s.setPermission("precise")
    s.onFix(fix({elapsedMs: 12_000}))
    expect(s.setPermission("background_restricted")).toEqual([{kind: "stop_route_updates", reason: "background_restricted"}])
  })

  test("raw and road-snapped are kept apart", () => {
    const {s} = rig()
    s.setPermission("precise")
    s.onFix(fix())
    const ev = s.onFix(fix({source: "sdk_snapped", latitude: 12.9717, elapsedMs: 10_001}))
    expect(s.current()!.source).toBe("fused")
    expect(s.snapped()!.latitude).toBe(12.9717)
    expect(ev.at(-1)).toMatchObject({kind: "fix", fix: {source: "fused"}, snapped: {source: "sdk_snapped"}})
  })

  test("invalid, backwards and unusable fixes", () => {
    const {s} = rig()
    s.setPermission("precise")
    expect(s.onFix(fix({latitude: 0, longitude: 0}))).toEqual([])
    expect(s.onFix(fix({latitude: 91}))).toEqual([])
    expect(s.onFix(fix({accuracyM: -1}))).toEqual([])
    s.onFix(fix())
    expect(s.onFix(fix({elapsedMs: 9_000}))).toEqual([])
    expect(s.onFix(fix({elapsedMs: 11_000, accuracyM: 900}))).toEqual([{kind: "stop_route_updates", reason: "unusable_fix"}])
  })

  test("a reboot forgets fixes whose monotonic clock no longer exists", () => {
    const {s} = rig()
    s.setPermission("precise")
    s.onFix(fix())
    s.onReboot()
    expect(s.current()).toBeNull()
  })

  test("logs get about a kilometre, never the exact point", () => {
    const {s} = rig()
    s.setPermission("precise")
    s.onFix(fix())
    expect(forLog(s.current()!)).toEqual({lat: 12.97, lon: 77.59, accuracyBucket: "le10m", quality: "precise"})
  })

  test("feeds turn-by-turn guidance: a stale fix reads as poor GPS there", () => {
    const {s, c} = rig()
    s.setPermission("precise")
    s.onFix(fix())
    c.t += 6000
    const g = new Guidance()
    g.update({state: "enroute", routeGeneration: 1, step: 0, maneuver: "turn_left", distanceToManeuverM: 150, at: 0}, 0)
    const pos = s.forGuidance()!
    expect(g.position(pos, pos.at).length).toBe(1)
  })
})
