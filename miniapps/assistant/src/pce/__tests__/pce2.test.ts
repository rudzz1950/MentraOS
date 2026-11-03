/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {EventReceiver, SchemaRegistry} from "../../bus/envelope"
import {MemoryService} from "../../memory/memory"
import {MemoryBlobStore, MemoryKeyValueStore} from "../../memory/ports"
import type {ModelClient} from "../../agent/ports"
import {PerceptionHub} from "../adapters"
import {ClockAligner, fuse, usableFor} from "../fusion"
import {DataLifecycle, memoryStore, ScopedMap, type GovernedMeta} from "../lifecycle"
import {MemoryContext} from "../memoryctx"
import {availableTiers, CAPABILITY_MATRIX, OfflineCoordinator, type Connectivity} from "../offline"
import {PolicyEngine, type ConsentGrant, type ConsentRevocation, type DeviceContext} from "../policy"
import {DeviceRegistry} from "../registry"
import {SessionManager} from "../session"
import {SettingsCentre} from "../settings"
import {canCloseRequirement, contractSuite, deliver, prng, SimulatedDevice} from "../simulator"
import {scrub, Telemetry} from "../telemetry"
import {Proactive, type Signal} from "../triggers"

const T0 = 1_000_000
function clock() {
  const c = {t: T0, now: () => c.t}
  return c
}
const quiet: DeviceContext = {driving: false, inMeeting: false, doNotDisturb: false, localMinutes: 12 * 60}
let ev = 0
function policyWith(c: {now: () => number; t: number}) {
  const p = new PolicyEngine({now: c.now, verify: e => e.signature === "ok"})
  const grant = (scopeId: string, over: Partial<ConsentGrant> = {}) =>
    p.apply({kind: "grant", eventId: `g${++ev}`, scopeId, purposes: ["assistant_answer", "memory_write", "vision_qa"], categories: ["transcript", "image", "sensor", "wellness"],
      maxReach: "cloud", issuedAt: c.t, expiresAt: c.t + 3_600_000, signature: "ok", ...over})
  const revocation = (scopeId: string): ConsentRevocation => ({kind: "revoke", eventId: `r${++ev}`, scopeId, issuedAt: c.t, signature: "ok"})
  return {p, grant, revocation}
}

describe("ANI-209: proactive triggers", () => {
  function rig(ctx: DeviceContext = quiet) {
    const c = clock()
    const {p} = policyWith(c)
    let context = ctx
    const pr = new Proactive({clock: c, policy: p, context: () => context, hourlyBudget: 3})
    pr.addRule({id: "cal", kind: "calendar", description: "Remind me 5 minutes before meetings", enabled: true, priority: "normal", minIntervalMs: 600_000})
    pr.addRule({id: "loc", kind: "location", description: "Pick up groceries near the shop", enabled: true, priority: "normal", minIntervalMs: 600_000})
    pr.addRule({id: "bat", kind: "device_state", description: "Glasses battery critical", enabled: true, priority: "safety", minIntervalMs: 600_000})
    const sig = (kind: Signal["kind"], subject: string, over: Partial<Signal> = {}): Signal => ({kind, subject, at: c.t, text: `${kind} ${subject}`, permitted: true, ...over})
    return {pr, c, sig, setCtx: (x: DeviceContext) => (context = x)}
  }

  test("every suggestion traces to an enabled rule and the signal that fired it", () => {
    const {pr, sig} = rig()
    const o = pr.evaluate("cal", sig("calendar", "standup", {text: "Standup in 5 minutes"}))
    expect(o).toMatchObject({shown: true, suggestion: {ruleId: "cal", text: "Standup in 5 minutes", why: {rule: "Remind me 5 minutes before meetings", textFrom: "rule"}}})
    expect(pr.explain("cal")!.signals[0].subject).toBe("standup")
  })

  test("location, ambient audio and camera need an opt-in on top of being enabled", () => {
    const {pr, sig} = rig()
    expect(pr.evaluate("loc", sig("location", "shop"))).toMatchObject({shown: false, reason: "not_opted_in"})
    pr.optIn("loc", true)
    expect(pr.evaluate("loc", sig("location", "shop")).shown).toBe(true)
  })

  test("a burst of the same signal is one suggestion", () => {
    const {pr, sig, c} = rig()
    expect(pr.evaluate("cal", sig("calendar", "standup")).shown).toBe(true)
    for (let i = 0; i < 5; i++) expect(pr.evaluate("cal", sig("calendar", "standup"))).toMatchObject({reason: "repeat_suppressed"})
    c.t += 600_000
    expect(pr.evaluate("cal", sig("calendar", "standup")).shown).toBe(true)
  })

  test("a calendar change is a different subject, and the hourly budget still holds", () => {
    const {pr, sig} = rig()
    for (const s of ["a", "b", "c"]) expect(pr.evaluate("cal", sig("calendar", s)).shown).toBe(true)
    expect(pr.evaluate("cal", sig("calendar", "d"))).toMatchObject({reason: "budget_exhausted"})
    // Safety exceeds the budget, deterministically.
    expect(pr.evaluate("bat", sig("device_state", "battery")).shown).toBe(true)
  })

  test("quiet hours, DND and driving come from the policy engine; safety still gets through", () => {
    const {pr, sig, setCtx} = rig()
    setCtx({...quiet, driving: true})
    expect(pr.evaluate("cal", sig("calendar", "x"))).toMatchObject({reason: "policy_driving"})
    setCtx({...quiet, localMinutes: 23 * 60, quietHours: [22 * 60, 7 * 60]})
    expect(pr.evaluate("cal", sig("calendar", "y"))).toMatchObject({reason: "policy_quiet_hours"})
    setCtx({...quiet, doNotDisturb: true})
    expect(pr.evaluate("bat", sig("device_state", "battery")).shown).toBe(true)
  })

  test("removing the source permission stops the rule", () => {
    const {pr, sig} = rig()
    expect(pr.evaluate("cal", sig("calendar", "x", {permitted: false}))).toMatchObject({reason: "signal_not_permitted"})
  })

  test("snooze, disable, tune and remove", () => {
    const {pr, sig, c} = rig()
    pr.snooze("cal", c.t + 1000)
    expect(pr.evaluate("cal", sig("calendar", "x")).shown).toBe(false)
    c.t += 1000
    pr.enable("cal", false)
    expect(pr.evaluate("cal", sig("calendar", "x"))).toMatchObject({reason: "rule_disabled"})
    expect(() => pr.tune("cal", 10)).toThrow()
    pr.remove("cal")
    expect(pr.evaluate("cal", sig("calendar", "x"))).toMatchObject({reason: "no_such_rule"})
  })

  test("a model can word a suggestion, never infer a sensitive trait, never create a trigger", () => {
    const {pr, sig} = rig()
    expect(pr.evaluate("cal", sig("calendar", "x"), "You seem depressed lately; take a break before standup")).toMatchObject({reason: "sensitive_inference"})
    const o = pr.evaluate("cal", sig("calendar", "y"), "Standup soon. Your notes are on the phone.")
    expect(o.shown && o.suggestion.why.textFrom).toBe("model")
    expect(pr.evaluate("not-a-rule", sig("calendar", "z"), "Anything")).toMatchObject({reason: "no_such_rule"})
    expect(() => pr.addRule({id: "w", kind: "wellness_summary", description: "x", enabled: true, priority: "safety", minIntervalMs: 60_000})).toThrow()
  })
})

describe("ANI-210: offline", () => {
  function rig(net: Connectivity = "offline") {
    const c = clock()
    const {p, grant, revocation} = policyWith(c)
    let n = net
    const off = new OfflineCoordinator({policy: p, now: c.now, connectivity: () => n, maxAttempts: 2})
    return {off, p, grant, revocation, c, setNet: (x: Connectivity) => (n = x)}
  }

  test("essential controls work in airplane mode; cloud-only things say so", () => {
    const {off} = rig()
    for (const a of ["hud.navigate", "ring.haptic", "capture.stop", "audio.mute", "timer.set", "memory.note"]) expect(off.submit(a, false)).toEqual({run: "now"})
    expect(off.submit("vision.ask", false)).toMatchObject({run: "refused", reason: "needs_network"})
    expect(off.submit("task.create", false)).toEqual({run: "queue"})
    expect(off.submit("not.a.thing", false)).toMatchObject({reason: "not_in_deployment"})
  })

  test("a consequential action is refused offline and can never be queued", () => {
    const {off} = rig()
    expect(off.submit("message.send", true)).toMatchObject({run: "refused", reason: "consequential_not_queued"})
    expect(() => off.enqueue({actionId: "message.send", payload: {}, consequential: true})).toThrow(/never queued/)
  })

  test("revocation removes queued work and cached context, and is checked again at flush", async () => {
    const {off, p, grant, revocation, setNet} = rig()
    grant("s1")
    grant("s2")
    off.enqueue({actionId: "task.create", payload: {t: 1}, consequential: false, scopeId: "s1"})
    off.enqueue({actionId: "task.create", payload: {t: 2}, consequential: false, scopeId: "s2"})
    off.cachePut("ctx", {who: "Asha"}, {ttlMs: 60_000, scopeId: "s1"})
    p.apply(revocation("s1"))
    expect(off.pending.map(i => i.scopeId)).toEqual(["s2"])
    expect(off.cacheGet("ctx")).toBeUndefined()
    expect(() => off.enqueue({actionId: "task.create", payload: {}, consequential: false, scopeId: "s1"})).toThrow(/revoked/)
    setNet("online")
    const sent: unknown[] = []
    expect(await off.flush(async i => void sent.push(i.payload))).toEqual({sent: 1, dropped: 0, failed: 0})
    expect(sent).toEqual([{t: 2}])
  })

  test("flush is bounded: failures retry, then give up", async () => {
    const {off, setNet} = rig()
    off.enqueue({actionId: "task.create", payload: {}, consequential: false})
    setNet("online")
    expect(await off.flush(async () => Promise.reject(new Error("503")))).toEqual({sent: 0, dropped: 0, failed: 0})
    expect(await off.flush(async () => Promise.reject(new Error("503")))).toEqual({sent: 0, dropped: 0, failed: 1})
    expect(off.pending.length).toBe(0)
  })

  test("cached context needs an expiry, and expires", () => {
    const {off, c} = rig()
    expect(() => off.cachePut("x", 1, {ttlMs: 0})).toThrow()
    off.cachePut("x", 1, {ttlMs: 100})
    expect(off.cacheGet("x")).toBe(1)
    c.t += 101
    expect(off.cacheGet("x")).toBeUndefined()
  })

  test("the existing router's tiers are filtered by reachability, with an honest message", () => {
    const tier = (name: string, locality: ModelClient["locality"]): ModelClient => ({name, locality, async *complete() {}})
    const tiers = [tier("phone", "device"), tier("plant", "site"), tier("hosted", "cloud")]
    expect(availableTiers(tiers, "online")).toEqual({tiers, degraded: null})
    expect(availableTiers(tiers, "site_only").tiers.map(t => t.name)).toEqual(["phone", "plant"])
    expect(availableTiers(tiers, "offline")).toMatchObject({degraded: "Offline: short answers only."})
    expect(availableTiers([tier("hosted", "cloud")], "offline").degraded).toContain("Timers, notes and the clock still work")
  })

  test("the capability matrix lists the essentials as available disconnected", () => {
    expect(CAPABILITY_MATRIX.find(r => r.capability.startsWith("Ring controls"))!.disconnected).toBe(true)
    expect(CAPABILITY_MATRIX.find(r => r.capability.startsWith("Sending messages"))!.disconnected).toBe(false)
  })
})

describe("ANI-211: telemetry", () => {
  function rig() {
    const c = clock()
    return {t: new Telemetry({now: c.now, salt: "install-salt", versions: {app: "1.2.3", firmware: {glasses: "0.3.0"}}}), c}
  }

  test("one trace follows a ring gesture to the HUD, stage by stage", () => {
    const {t} = rig()
    const id = t.newTrace()
    t.span(id, "event_receive", 0, 4)
    t.span(id, "action_dispatch", 4, 30)
    t.span(id, "hud_render", 30, 62, {device: t.pseudonym("gl-1")})
    expect(t.trace(id).map(s => [s.stage, s.durationMs])).toEqual([["event_receive", 4], ["action_dispatch", 26], ["hud_render", 32]])
  })

  test("content cannot be recorded: transcripts, names and payloads are dropped and counted", () => {
    const {t} = rig()
    const id = t.newTrace()
    t.span(id, "model_complete", 0, 10, {
      transcript: "send Asha the deck",
      upi: "upi://pay?pa=shop@okhdfc&am=500",
      ok: true,
      tier: "small",
      tokens: 42,
      location: "12.9716,77.5946",
    })
    const s = JSON.stringify(t.exportBundle({userAuthorised: true, previewedAt: T0}))
    for (const secret of ["Asha", "upi://", "okhdfc", "77.5946"]) expect(s).not.toContain(secret)
    expect(t.trace(id)[0].attrs).toEqual({ok: true, tier: "small", tokens: 42})
    expect(t.dropped).toBe(3)
  })

  test("error text is scrubbed", () => {
    expect(scrub("failed for asha@example.com on +91 98765 43210, vpa shop@okhdfc, https://x.example/a?token=1, key AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII"))
      .toBe("failed for [email] on [number], vpa [vpa], [url] key [blob]")
  })

  test("device ids are pseudonymised per install", () => {
    const a = new Telemetry({now: () => 0, salt: "a", versions: {app: "1"}})
    const b = new Telemetry({now: () => 0, salt: "b", versions: {app: "1"}})
    expect(a.pseudonym("gl-1")).toBe(a.pseudonym("gl-1"))
    expect(a.pseudonym("gl-1")).not.toBe(b.pseudonym("gl-1"))
    expect(a.pseudonym("gl-1")).not.toContain("gl-1")
  })

  test("alerts: crash loop, latency, queue growth, disconnects, failed revocation", () => {
    const {t} = rig()
    for (let i = 0; i < 3; i++) t.event("crash")
    for (let i = 0; i < 20; i++) t.span("x", "model_first_token", 0, 900)
    t.metric("queue_depth", 80)
    for (let i = 0; i < 5; i++) t.event("disconnect")
    t.event("revocation_failed", {store: "glasses_cache"})
    expect(t.alerts().map(a => a.kind).sort()).toEqual(["crash_loop", "high_latency", "queue_growth", "repeated_disconnect", "revocation_failed"])
  })

  test("a support bundle needs authorisation after a preview, and carries versions", () => {
    const {t} = rig()
    expect(t.preview().versions).toEqual({app: "1.2.3", firmware: {glasses: "0.3.0"}})
    expect(() => t.exportBundle({} as never)).toThrow(/authorisation/)
    expect(JSON.parse(t.exportBundle({userAuthorised: true, previewedAt: T0})).versions.app).toBe("1.2.3")
  })

  test("local retention", () => {
    const {t, c} = rig()
    t.event("crash")
    c.t += 86_400_001
    t.event("disconnect")
    expect(t.preview().events).toBe(1)
  })
})

describe("ANI-212: lifecycle across every store", () => {
  function rig() {
    const c = clock()
    const {p, grant, revocation} = policyWith(c)
    let glassesUp = true
    const life = new DataLifecycle({policy: p, now: c.now, reachable: loc => loc !== "glasses" || glassesUp})
    const meta = (scopeId: string, over: Partial<GovernedMeta> = {}): GovernedMeta => ({scopeId, purpose: "vision_qa", expiresAt: c.t + 60_000, provenance: "captured", ownerUserId: "u1", ...over})
    return {life, p, grant, revocation, meta, c, setGlasses: (on: boolean) => (glassesUp = on)}
  }

  test("writes without complete, live, granted metadata are refused at the store", () => {
    const {life, grant, meta, p, revocation} = rig()
    const ocr = new ScopedMap<string>("ocr", "ocr", life)
    expect(ocr.put("a", "text", {scopeId: "s1"} as never)).toEqual({ok: false, reason: "missing_metadata"})
    expect(ocr.put("a", "text", meta("s1"))).toEqual({ok: false, reason: "purpose_not_granted"})
    grant("s1")
    expect(ocr.put("a", "text", meta("s1")).ok).toBe(true)
    expect(ocr.put("b", "text", meta("s1", {expiresAt: 0}))).toEqual({ok: false, reason: "expired"})
    p.apply(revocation("s1"))
    expect(ocr.put("c", "text", meta("s1"))).toEqual({ok: false, reason: "scope_revoked"})
  })

  test("revocation reaches every registered store and returns a per-store receipt", async () => {
    const {life, grant, meta, revocation} = rig()
    const memory = new MemoryService({storage: new MemoryKeyValueStore(), blobs: new MemoryBlobStore(), now: () => T0})
    life.register(memoryStore(memory))
    const media = new ScopedMap<string>("capture_media", "capture_media", life)
    const ocr = new ScopedMap<string>("ocr", "ocr", life)
    grant("s1")
    await memory.add({class: "episodic", text: "Asha said the vendor slipped", source: {turnId: "t", turnAt: 0, provenance: "captured", scopeId: "s1"}})
    media.put("img1", "media:img1", meta("s1"))
    ocr.put("img1", "MASALA OATS", meta("s1"))
    ocr.put("img2", "other", meta("s2-not-granted"))

    const receipt = await life.revoke("s1", revocation("s1"))
    expect(receipt.complete).toBe(true)
    expect(receipt.stores.map(s => [s.store, s.status, s.deleted, s.remaining])).toEqual([
      ["memory", "complete", 1, 0],
      ["capture_media", "complete", 1, 0],
      ["ocr", "complete", 1, 0],
    ])
    expect(await memory.scopes()).toEqual([])
  })

  test("an unreachable store is pending, and converges when it comes back (offline revocation)", async () => {
    const {life, grant, meta, revocation, setGlasses} = rig()
    const glassesCache = new ScopedMap<string>("glasses_cache", "tool_caches", life, "glasses")
    grant("s1")
    glassesCache.put("x", "frame ref", meta("s1"))
    setGlasses(false)
    const first = await life.revoke("s1", revocation("s1"))
    expect(first).toMatchObject({complete: false, stores: [{store: "glasses_cache", status: "pending"}]})
    expect(life.unconverged()).toEqual(["s1"])
    // Even while pending, nothing new can be written to the scope.
    expect(glassesCache.put("y", "frame", meta("s1"))).toEqual({ok: false, reason: "scope_revoked"})
    setGlasses(true)
    const [second] = await life.converge()
    expect(second).toMatchObject({complete: true, stores: [{store: "glasses_cache", status: "complete", deleted: 1}]})
    expect(life.unconverged()).toEqual([])
  })

  test("a store that does not fully purge is reported incomplete, not complete", async () => {
    const {life, grant, revocation} = rig()
    life.register({name: "leaky", category: "summaries", location: "phone", purge: async () => 1, count: async () => 2})
    grant("s1")
    const r = await life.revoke("s1", revocation("s1"))
    expect(r).toMatchObject({complete: false, stores: [{store: "leaky", status: "incomplete", remaining: 2}]})
  })

  test("legal holds are reported, never hidden", async () => {
    const {life, grant, revocation} = rig()
    life.register({name: "invoices", category: "local_backups", location: "phone", purge: async () => 0, count: async () => 1, legalHold: async () => 1})
    grant("s1")
    const r = await life.revoke("s1", revocation("s1"))
    expect(r.stores[0]).toMatchObject({status: "complete", held: 1})
  })

  test("the inventory shows which categories nothing is registered for", () => {
    const {life} = rig()
    new ScopedMap("ocr", "ocr", life)
    expect(life.gaps()).toContain("embeddings")
    expect(life.gaps()).not.toContain("ocr")
  })

  test("a revocation policy did not accept purges nothing", async () => {
    const {life} = rig()
    await expect(life.revoke("s1", {kind: "revoke", eventId: "forged", scopeId: "s1", issuedAt: 0, signature: "bad"})).rejects.toThrow(/not accepted/)
  })
})

describe("ANI-201: input adapters", () => {
  test("each modality validates and types its input", () => {
    const hub = new PerceptionHub()
    expect(hub.ingest("voice", {kind: "final", text: "what's next", utteranceId: "u1", at: 1}).ok).toBe(true)
    expect(hub.ingest("vision", {kind: "capture", captureRef: "media:abc", scopeId: "s1", at: 1}).ok).toBe(true)
    expect(hub.ingest("motion", {kind: "head_gesture", gesture: "nod", confidence: 0.9, at: 1}).ok).toBe(true)
    expect(hub.ingest("ring", {kind: "gesture", gesture: "double_tap", at: 1}).ok).toBe(true)
    expect(hub.ingest("phone", {kind: "calendar", eventId: "e1", change: "starting_soon", at: 1}).ok).toBe(true)
  })

  test("malformed input is refused with a reason", () => {
    const hub = new PerceptionHub()
    expect(hub.ingest("ring", {kind: "gesture", gesture: "teleport", at: 1})).toMatchObject({ok: false, reason: "malformed"})
    expect(hub.ingest("motion", {kind: "activity", activity: "driving", confidence: 0.9, at: 1, source: "platform"})).toMatchObject({reason: "malformed"})
    expect(hub.ingest("ring", {kind: "wellness_summary", metric: "resting_hr", value: 60, unit: "min", at: 1, scopeId: "s"})).toMatchObject({reason: "malformed"})
    expect(hub.ingest("voice", null)).toMatchObject({reason: "malformed"})
  })

  test("raw media never enters context; captures and overheard speech need a scope", () => {
    const hub = new PerceptionHub()
    expect(hub.ingest("vision", {kind: "capture", captureRef: "media:x", scopeId: "s", at: 1, pixels: new Uint8Array(4)})).toMatchObject({reason: "raw_media"})
    expect(hub.ingest("vision", {kind: "capture", captureRef: "data:image/jpeg;base64,AAAA", scopeId: "s", at: 1})).toMatchObject({reason: "raw_media"})
    expect(hub.ingest("vision", {kind: "capture", captureRef: "media:x", at: 1})).toMatchObject({reason: "unscoped_capture"})
    expect(hub.ingest("voice", {kind: "final", text: "she said no", utteranceId: "u", at: 1, captured: true})).toMatchObject({reason: "unscoped_capture"})
    expect(hub.ingest("ring", {kind: "wellness_summary", metric: "steps", value: 9000, unit: "count", at: 1})).toMatchObject({reason: "unscoped_capture"})
  })

  test("a late partial does not overwrite a final; late telemetry is refused", () => {
    const hub = new PerceptionHub()
    hub.ingest("voice", {kind: "final", text: "send the deck", utteranceId: "u1", at: 10})
    expect(hub.ingest("voice", {kind: "partial", text: "send the", utteranceId: "u1", at: 9})).toMatchObject({reason: "late"})
    expect(hub.ingest("voice", {kind: "partial", text: "send the", utteranceId: "u1", at: 11})).toMatchObject({reason: "late"})
    hub.ingest("ring", {kind: "battery", percent: 50, at: 20})
    expect(hub.ingest("ring", {kind: "battery", percent: 60, at: 19})).toMatchObject({reason: "late"})
  })

  test("a missing modality is absent and does not block the others", () => {
    const hub = new PerceptionHub()
    hub.remove("vision")
    expect(hub.ingest("vision", {kind: "camera_state", state: "idle", at: 1})).toMatchObject({reason: "modality_absent"})
    expect(hub.ingest("ring", {kind: "gesture", gesture: "tap", at: 1}).ok).toBe(true)
    const s = hub.status()
    expect(s.vision.present).toBe(false)
    expect(s.ring).toMatchObject({present: true, ok: 1})
  })

  test("oversize input is refused", () => {
    const hub = new PerceptionHub()
    expect(hub.ingest("voice", {kind: "final", text: "x".repeat(9000), utteranceId: "u", at: 1})).toMatchObject({reason: "too_large"})
  })
})

describe("ANI-202: sensor fusion", () => {
  test("clock offset and drift are estimated, with uncertainty", () => {
    const a = new ClockAligner()
    // Ring clock runs 100 ppm fast relative to the phone, offset 5000 ms, delivery delay 2-20 ms.
    const r = prng(7)
    for (let i = 0; i < 32; i++) {
      const device = i * 1000
      const phone = 5000 + device * (1 - 100e-6) + 2 + Math.floor(r() * 18)
      a.observe({source: "ring", eventId: `e${i}`, deviceTimeMs: device, receivedAt: phone})
    }
    const e = a.estimate("ring")!
    expect(Math.abs(e.driftPpm + 100)).toBeLessThan(40)
    expect(e.uncertaintyMs).toBeGreaterThan(1)
    expect(e.uncertaintyMs).toBeLessThan(25)
    const placed = a.toPhoneTime("ring", 31_000)!
    expect(Math.abs(placed.at - (5000 + 31_000 * (1 - 100e-6) + 2))).toBeLessThan(25)
  })

  test("a replay or a clock that went backwards is excluded", () => {
    const a = new ClockAligner()
    expect(a.observe({source: "ring", eventId: "1", deviceTimeMs: 100, receivedAt: 200})).toBe(true)
    expect(a.observe({source: "ring", eventId: "1", deviceTimeMs: 100, receivedAt: 900})).toBe(false)
    expect(a.observe({source: "ring", eventId: "2", deviceTimeMs: 50, receivedAt: 950})).toBe(false)
  })

  test("agreement fuses, with provenance and inherited scopes", () => {
    const f = fuse([
      {source: "phone", eventId: "p1", value: "in_vehicle", at: 990, confidence: 0.8},
      {source: "glasses", eventId: "g1", value: "in_vehicle", at: 995, confidence: 0.7, scopeId: "s1"},
    ], {now: 1000, freshnessMs: 30_000})
    expect(f).toMatchObject({status: "ok", value: "in_vehicle", scopes: ["s1"]})
    expect(f.confidence).toBeCloseTo(0.9)
    expect(f.sources.map(s => s.eventId)).toEqual(["p1", "g1"])
  })

  test("contradiction is surfaced, never averaged", () => {
    const f = fuse([
      {source: "phone", eventId: "p1", value: 0.0, at: 990, confidence: 0.9},
      {source: "ring", eventId: "r1", value: 30.0, at: 990, confidence: 0.9},
    ], {now: 1000, freshnessMs: 30_000, agree: (a, b) => Math.abs(a - b) < 5})
    expect(f.status).toBe("conflict")
    expect(f.value).toBeUndefined()
    expect(usableFor(f, "display_hint")).toBe(false)
  })

  test("stale, missing, implausible and motion-artefact readings", () => {
    expect(fuse([{source: "ring", eventId: "r", value: 60, at: 0, confidence: 0.9}], {now: 100_000, freshnessMs: 30_000}).status).toBe("stale")
    expect(fuse([], {now: 0, freshnessMs: 1}).status).toBe("missing")
    expect(fuse([{source: "ring", eventId: "r", value: 400, at: 0, confidence: 0.9}], {now: 0, freshnessMs: 1, plausible: v => v > 25 && v < 230}).status).toBe("missing")
    expect(fuse([{source: "ring", eventId: "r", value: 60, at: 0, confidence: 0.9, quality: ["motion_artifact"]}], {now: 0, freshnessMs: 1}).status).toBe("missing")
  })

  test("fusion output is gated by declared thresholds and never drives a consequential action", () => {
    const f = fuse([{source: "phone", eventId: "p", value: "walking", at: 0, confidence: 0.65}], {now: 0, freshnessMs: 1})
    expect(usableFor(f, "display_hint")).toBe(true)
    expect(usableFor(f, "suggestion")).toBe(false)
    const sure = fuse([{source: "a", eventId: "a", value: 1, at: 0, confidence: 0.99}, {source: "b", eventId: "b", value: 1, at: 0, confidence: 0.99}], {now: 0, freshnessMs: 1})
    expect(usableFor(sure, "consequential")).toBe(false)
  })
})

describe("ANI-203: memory in the context engine", () => {
  function rig() {
    const c = clock()
    const {p, grant, revocation} = policyWith(c)
    const memory = new MemoryService({storage: new MemoryKeyValueStore(), blobs: new MemoryBlobStore(), now: c.now, embeddingsEnabled: true})
    return {ctx: new MemoryContext({memory, policy: p, now: c.now}), memory, p, grant, revocation, c}
  }

  test("a fact stated on the glasses is found later from the ring, with its provenance", async () => {
    const {ctx} = rig()
    await ctx.rememberStated("My manager is Priya", {turnId: "t1", deviceId: "gl-1", utterance: "remember my manager is Priya"})
    const [hit] = await ctx.retrieve("who is my manager")
    expect(hit).toMatchObject({text: "My manager is Priya", kind: "user_stated", source: {turnId: "t1", deviceId: "gl-1", utterance: "remember my manager is Priya"}})
  })

  test("stated, observed and hypothesis are kept distinct", async () => {
    const {ctx, memory, grant} = rig()
    grant("s1")
    await ctx.rememberStated("I prefer short answers", {class: "stable_preference", turnId: "t1", deviceId: "phone"})
    await memory.add({class: "episodic", text: "Asha said short answers please", source: {turnId: "t2", turnAt: 0, provenance: "captured", scopeId: "s1"}})
    await ctx.rememberApprovedHypothesis("Prefers short answers in meetings", {turnId: "t3", deviceId: "phone", approvedByUser: true, confidence: 0.7})
    const kinds = (await ctx.retrieve("short answers", {k: 5})).map(h => h.kind).sort()
    expect(kinds).toEqual(["hypothesis", "observed", "user_stated"])
    await expect(ctx.rememberApprovedHypothesis("x", {turnId: "t", deviceId: "p", approvedByUser: false, confidence: 0.5})).rejects.toThrow(/approval/)
  })

  test("a captured memory whose consent ended is not retrieved, even before collection", async () => {
    const {ctx, memory, grant, c} = rig()
    grant("s1", {expiresAt: c.t + 1000})
    await memory.add({class: "episodic", text: "Asha said the vendor slipped", source: {turnId: "t", turnAt: 0, provenance: "captured", scopeId: "s1"}})
    expect((await ctx.retrieve("vendor")).length).toBe(1)
    c.t += 1001
    expect(await ctx.retrieve("vendor")).toEqual([])
  })

  test("intent narrows retrieval first, then falls back", async () => {
    const {ctx} = rig()
    await ctx.rememberStated("Chase the compressor quote", {class: "active_task", turnId: "t1", deviceId: "phone"})
    await ctx.rememberStated("The compressor is a Kirloskar", {class: "project_context", turnId: "t2", deviceId: "phone", tags: ["plant"]})
    const tasks = await ctx.retrieve("compressor", {intent: "task", k: 1})
    expect(tasks[0].class).toBe("active_task")
    expect((await ctx.retrieve("compressor", {intent: "task", k: 2})).length).toBe(2)
  })

  test("a correction updates the canonical record for every device", async () => {
    const {ctx} = rig()
    const m = await ctx.rememberStated("My manager is Priya", {turnId: "t1", deviceId: "gl-1"})
    await ctx.correct(m.id, "My manager is Pooja", {deviceId: "phone"})
    const [hit] = await ctx.retrieve("manager")
    expect(hit).toMatchObject({text: "My manager is Pooja", corrected: true, source: {deviceId: "gl-1"}})
  })

  test("deletion survives a restart", async () => {
    const storage = new MemoryKeyValueStore()
    const blobs = new MemoryBlobStore()
    const c = clock()
    const {p} = policyWith(c)
    const a = new MemoryContext({memory: new MemoryService({storage, blobs, now: c.now}), policy: p, now: c.now})
    const m = await a.rememberStated("Locker code 4411", {turnId: "t", deviceId: "phone"})
    await a.delete(m.id)
    const b = new MemoryContext({memory: new MemoryService({storage, blobs, now: c.now}), policy: p, now: c.now})
    expect(await b.retrieve("locker code")).toEqual([])
  })
})

describe("ANI-213: the settings centre", () => {
  function rig() {
    const c = clock()
    const {p, grant, revocation} = policyWith(c)
    const registry = new DeviceRegistry(c.now)
    registry.enroll({deviceId: "gl-1", kind: "glasses", model: "MYGL-DK1", firmwareVersion: "0.3.0", protocolVersion: 1})
    const session = new SessionManager({registry, now: c.now})
    session.addDevice("gl-1", "glasses")
    session.start()
    session.connected({descriptor: {deviceId: "gl-1", kind: "glasses", model: "MYGL-DK1", firmwareVersion: "0.3.0", protocolVersion: 1}, capabilities: [{id: "display", state: "supported"}, {id: "camera.still", state: "supported"}], commands: []})
    const life = new DataLifecycle({policy: p, now: c.now, reachable: () => true})
    const memory = new MemoryService({storage: new MemoryKeyValueStore(), blobs: new MemoryBlobStore(), now: c.now})
    life.register(memoryStore(memory))
    const proactive = new Proactive({clock: c, policy: p, context: () => quiet})
    const sc = new SettingsCentre({registry, session, policy: p, lifecycle: life, proactive, memory})
    return {sc, registry, session, p, grant, revocation, memory}
  }

  test("devices show connected, authorized, capturing and model-processing as separate states", () => {
    const {sc} = rig()
    sc.setCapturing("gl-1", true)
    expect(sc.devices()[0]).toMatchObject({connected: true, authorized: true, capturing: true, modelProcessing: false, capabilities: ["display", "camera.still"]})
  })

  test("revoking a device is enforced by the registry, not just hidden", () => {
    const {sc, registry} = rig()
    expect(sc.revokeDevice("gl-1", "hud")).toEqual({ok: false, reason: "needs_phone_confirmation"})
    expect(sc.revokeDevice("gl-1", "phone")).toEqual({ok: true})
    expect(registry.check("gl-1", ["display"])).toMatchObject({ok: false, reason: "device_revoked"})
    expect(sc.devices()[0]).toMatchObject({authorized: false, connected: false})
  })

  test("withdrawing a scope purges it and the dashboard shows it", async () => {
    const {sc, grant, revocation, memory} = rig()
    grant("s1")
    await memory.add({class: "episodic", text: "captured", source: {turnId: "t", turnAt: 0, provenance: "captured", scopeId: "s1"}})
    expect(sc.lifecycleDashboard().activeScopes.map(s => s.scopeId)).toContain("s1")
    expect(await sc.revokeScope(revocation("s1"), "voice")).toEqual({ok: false, reason: "needs_phone_confirmation"})
    const receipt = await sc.revokeScope(revocation("s1"), "phone")
    expect(receipt).toMatchObject({complete: true})
    expect(sc.lifecycleDashboard()).toMatchObject({revokedScopes: ["s1"], activeScopes: []})
  })

  test("model use: six separate controls, training off by default, enabling needs the phone", () => {
    const {sc} = rig()
    const m = sc.getModelUse()
    expect(Object.keys(m).sort()).toEqual(["analytics", "modelImprovement", "processRequests", "saveMemory", "sharing", "thirdPartyProviders"])
    expect(m.modelImprovement).toBe(false)
    expect(sc.setModelUse("modelImprovement", true, "voice")).toEqual({ok: false, reason: "needs_phone_confirmation"})
    expect(sc.setModelUse("thirdPartyProviders", {gemini: true}, "hud")).toEqual({ok: false, reason: "needs_phone_confirmation"})
    // Turning something off is never gated.
    expect(sc.setModelUse("saveMemory", false, "voice")).toEqual({ok: true})
    expect(sc.setModelUse("thirdPartyProviders", {gemini: true}, "phone")).toEqual({ok: true})
    expect(sc.getModelUse().thirdPartyProviders).toEqual({gemini: true})
  })

  test("pausing context and deleting memory", async () => {
    const {sc, memory} = rig()
    expect(sc.pauseContext(true)).toEqual({ok: true})
    expect(sc.isContextPaused).toBe(true)
    const m = await memory.add({class: "episodic", text: "x", source: {turnId: "t", turnAt: 0}})
    expect(await sc.deleteMemory(m.id, "hud")).toEqual({ok: false, reason: "needs_phone_confirmation"})
    expect(await sc.deleteMemory(m.id, "hud", true)).toEqual({ok: true})
    expect((await sc.memoryCentre()).memories).toEqual([])
  })
})

describe("ANI-214: the simulator", () => {
  function harness() {
    const c = clock()
    const registry = new DeviceRegistry(c.now)
    const schemas = new SchemaRegistry().register({type: "ring.gesture", versions: [1, 1], priority: "interactive", validate: (p): p is {g: string} => typeof (p as {g?: unknown})?.g === "string"})
    const receiver = new EventReceiver({registry: schemas, accountId: "acct", now: c.now})
    return {c, registry, receiver}
  }
  const ring = () => new SimulatedDevice("ring-1", "ring", {accountId: "acct", capabilities: [{id: "haptics", state: "supported"}, {id: "wellness.spo2", state: "unavailable"}], commands: ["haptic"]})

  test("the contract suite passes against a simulated device, and says it was simulated", () => {
    const {registry, receiver} = harness()
    registry.enroll({deviceId: "ring-1", kind: "ring", model: "SIM-RING", firmwareVersion: "sim-1.0.0", protocolVersion: 1})
    const report = contractSuite(ring(), {registry, receiver, eventType: "ring.gesture", payload: {g: "tap"}, appVersion: "1.2.3", seed: 1})
    expect(report.checks.filter(c => !c.passed)).toEqual([])
    expect(report).toMatchObject({passed: true, mode: "simulated", simulatorVersion: "pce-sim-1", firmware: {"ring-1": "sim-1.0.0"}})
  })

  test("a simulated pass cannot close a physical requirement", () => {
    const report = {scenario: "x", mode: "simulated" as const, firmware: {}, appVersion: "1", passed: true, checks: []}
    expect(canCloseRequirement(report, {needsPhysical: true})).toEqual({ok: false, reason: "simulated evidence cannot close a physical-integration requirement"})
    expect(canCloseRequirement(report, {needsPhysical: false})).toEqual({ok: true})
    expect(canCloseRequirement({...report, mode: "physical"}, {needsPhysical: true})).toEqual({ok: true})
  })

  test("faults are deterministic for a seed: duplication and reorder are absorbed by the receiver", () => {
    const {registry, receiver, c} = harness()
    registry.enroll({deviceId: "ring-1", kind: "ring", model: "SIM-RING", firmwareVersion: "sim-1.0.0", protocolVersion: 1})
    const dev = ring()
    const sent = Array.from({length: 40}, (_, i) => {
      dev.tick(50)
      return {event: dev.emit("ring.gesture", {g: `g${i}`}, {ttlMs: 10_000, priority: "telemetry"}), sentAt: T0 + i * 50}
    })
    const faults = {duplicate: 0.3, reorder: 0.2, drop: 0.1, maxDelayMs: 40}
    const a = deliver(sent, faults, 42)
    const b = deliver(sent, faults, 42)
    expect(a.map(x => x.event.eventId)).toEqual(b.map(x => x.event.eventId))
    expect(a.length).not.toBe(sent.length)

    const accepted = new Set<string>()
    let dupes = 0
    for (const d of a) {
      c.t = d.arrivesAt
      const r = receiver.receive(d.event, "ring-1")
      if (r.ok) accepted.add(r.event.eventId)
      else if (r.reason === "duplicate") dupes++
    }
    // Idempotency: every distinct event at most once, every duplicate refused.
    expect(accepted.size).toBe(new Set(a.map(x => x.event.eventId)).size)
    expect(dupes).toBe(a.length - accepted.size)
  })

  test("clock skew is just an offset to the receiver", () => {
    const {registry, receiver} = harness()
    registry.enroll({deviceId: "ring-1", kind: "ring", model: "SIM-RING", firmwareVersion: "sim-1.0.0", protocolVersion: 1})
    const skewed = new SimulatedDevice("ring-1", "ring", {accountId: "acct", capabilities: [], faults: {clockSkewMs: 9_000_000}})
    expect(receiver.receive(skewed.emit("ring.gesture", {g: "tap"}), "ring-1").ok).toBe(true)
  })
})
