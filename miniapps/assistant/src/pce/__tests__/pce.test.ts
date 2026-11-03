/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {ActionRegistry, BUILTIN_ACTIONS, payloadHash, validate, type ActionDefinition} from "../actions"
import {PolicyEngine, type ConsentEvent, type ConsentGrant, type DeviceContext} from "../policy"
import {DeviceRegistry, type DeviceHello} from "../registry"
import {SessionManager} from "../session"

const clock = () => {
  const c = {t: 1_000_000, now: () => c.t}
  return c
}

const glassesHello = (over: Partial<DeviceHello["descriptor"]> = {}, caps: DeviceHello["capabilities"] = [
  {id: "display", state: "supported", params: {width: 128, height: 64}},
  {id: "camera.still", state: "supported"},
  {id: "speaker", state: "unavailable"},
  {id: "mic.lc3", state: "permission_denied"},
], commands = ["display_text", "clear_display"]): DeviceHello => ({
  descriptor: {deviceId: "gl-1", kind: "glasses", model: "MYGL-DK1", firmwareVersion: "0.3.0", protocolVersion: 1, ...over},
  capabilities: caps,
  commands,
})
const ringHello = (): DeviceHello => ({
  descriptor: {deviceId: "ring-1", kind: "ring", model: "R1", firmwareVersion: "1.0.0", protocolVersion: 1},
  capabilities: [{id: "haptics", state: "supported"}, {id: "ring.gestures", state: "supported"}],
  commands: ["haptic"],
})
const phoneHello = (): DeviceHello => ({
  descriptor: {deviceId: "phone", kind: "phone", model: "Pixel", firmwareVersion: "app-1", protocolVersion: 1},
  capabilities: [],
  commands: [],
})

describe("ANI-197: the device registry", () => {
  function reg() {
    const c = clock()
    const r = new DeviceRegistry(c.now)
    r.enroll({deviceId: "gl-1", kind: "glasses", model: "MYGL-DK1", firmwareVersion: "0.3.0", protocolVersion: 1})
    return {r, c}
  }

  test("nothing is supported until the device says so this session", () => {
    const {r} = reg()
    expect(r.capability("gl-1", "display").state).toBe("unknown")
    expect(r.check("gl-1", ["display"])).toMatchObject({ok: false, reason: "not_connected"})
    r.negotiate(glassesHello())
    expect(r.check("gl-1", ["display"])).toEqual({ok: true})
  })

  test("the five states are distinguished and reported with a typed reason", () => {
    const {r} = reg()
    r.negotiate(glassesHello())
    expect(r.check("gl-1", ["speaker"])).toMatchObject({ok: false, reason: "unavailable", capability: "speaker"})
    expect(r.check("gl-1", ["mic.lc3"])).toMatchObject({ok: false, reason: "permission_denied"})
    expect(r.check("gl-1", ["haptics"])).toMatchObject({ok: false, reason: "unknown"})
    r.updateCapability("gl-1", "camera.still", "degraded")
    expect(r.check("gl-1", ["camera.still"])).toMatchObject({ok: false, reason: "degraded"})
    expect(r.check("gl-1", ["camera.still"], {allowDegraded: true})).toEqual({ok: true})
  })

  test("a stale cache is not trusted: after a disconnect everything is unknown again", () => {
    const {r} = reg()
    r.negotiate(glassesHello())
    r.markStale("gl-1")
    expect(r.capability("gl-1", "display").state).toBe("unknown")
    expect(r.available()).toEqual([])
  })

  test("a firmware update that removes a capability removes it, and says so", () => {
    const {r} = reg()
    r.negotiate(glassesHello())
    const changes: unknown[] = []
    r.onChange(ch => changes.push(ch))
    r.negotiate(glassesHello({firmwareVersion: "0.4.0"}, [{id: "display", state: "supported"}], ["display_text", "canvas"]))
    expect(r.check("gl-1", ["camera.still"])).toMatchObject({ok: false, reason: "unknown"})
    expect(changes[0]).toMatchObject({
      deviceId: "gl-1",
      changed: expect.arrayContaining([{id: "camera.still", from: "supported", to: "unknown"}]),
      commandsAdded: ["canvas"],
      commandsRemoved: ["clear_display"],
    })
    expect(r.get("gl-1")!.firmwareVersion).toBe("0.4.0")
  })

  test("protocol versions outside the supported range are refused", () => {
    const {r} = reg()
    expect(r.negotiate(glassesHello({protocolVersion: 2}))).toEqual({ok: false, reason: "protocol_too_new"})
    expect(r.negotiate(glassesHello({protocolVersion: -1}))).toEqual({ok: false, reason: "protocol_too_old"})
    expect(r.negotiate(glassesHello({protocolVersion: 0})).ok).toBe(true)
  })

  test("an unenrolled or revoked device cannot negotiate", () => {
    const {r} = reg()
    expect(r.negotiate(glassesHello({deviceId: "stranger"}))).toEqual({ok: false, reason: "not_enrolled"})
    r.revoke("gl-1")
    expect(r.negotiate(glassesHello())).toEqual({ok: false, reason: "revoked"})
    expect(r.check("gl-1", ["display"])).toMatchObject({reason: "device_revoked"})
  })
})

describe("ANI-199: the session", () => {
  function rig() {
    const c = clock()
    const registry = new DeviceRegistry(c.now)
    registry.enroll({deviceId: "gl-1", kind: "glasses", model: "MYGL-DK1", firmwareVersion: "0.3.0", protocolVersion: 1})
    registry.enroll({deviceId: "ring-1", kind: "ring", model: "R1", firmwareVersion: "1.0.0", protocolVersion: 1})
    const s = new SessionManager({registry, now: c.now})
    s.addDevice("gl-1", "glasses")
    s.addDevice("ring-1", "ring")
    return {s, c, registry}
  }

  test("pairing both devices gives one ready session", () => {
    const {s} = rig()
    s.start()
    expect(s.sessionState).toBe("establishing")
    s.connected(glassesHello())
    expect(s.sessionState).toBe("partial")
    expect(s.mode()).toBe("glasses_only")
    s.connected(ringHello())
    expect(s.sessionState).toBe("ready")
    expect(s.status()).toEqual({state: "ready", mode: "full", message: "Ready."})
  })

  test("losing the ring leaves the glasses exactly as they were", () => {
    const {s, registry} = rig()
    s.start()
    s.connected(glassesHello())
    s.connected(ringHello())
    s.disconnected("ring-1")
    expect(s.sessionState).toBe("partial")
    expect(s.status().message).toBe("Glasses only: ring not connected.")
    expect(s.linkState("gl-1")).toBe("connected")
    expect(registry.check("gl-1", ["display"])).toEqual({ok: true})
    expect(registry.check("ring-1", ["haptics"])).toMatchObject({ok: false, reason: "not_connected"})
  })

  test("each degraded mode is defined", () => {
    const {s} = rig()
    s.start()
    expect(s.mode()).toBe("phone_only")
    s.connected(ringHello())
    expect(s.mode()).toBe("ring_only")
    expect(s.status().message).toBe("Ring only: glasses not connected.")
  })

  test("weak signal or low battery degrades the link, and says so", () => {
    const {s} = rig()
    s.start()
    s.connected(glassesHello())
    s.connected(ringHello())
    s.health("ring-1", {batteryPercent: 8})
    expect(s.linkState("ring-1")).toBe("degraded")
    expect(s.status().message).toBe("Connected, weak signal or low battery.")
    s.health("ring-1", {batteryPercent: 60})
    expect(s.linkState("ring-1")).toBe("connected")
  })

  test("reconnect: expired and consequential commands are never replayed", () => {
    const {s, c} = rig()
    s.start()
    s.connected(glassesHello())
    s.disconnected("gl-1")
    s.hold({id: "card", deviceId: "gl-1", consequential: false, expiresAt: c.t + 10_000, payload: {}})
    s.hold({id: "old-card", deviceId: "gl-1", consequential: false, expiresAt: c.t + 100, payload: {}})
    s.hold({id: "send-msg", deviceId: "gl-1", consequential: true, expiresAt: c.t + 10_000, payload: {}})
    c.t += 500
    s.connected(glassesHello())
    const r = s.restore("gl-1")
    expect(r.send.map(p => p.id)).toEqual(["card"])
    expect(r.dropped).toEqual([{id: "old-card", reason: "expired"}, {id: "send-msg", reason: "consequential"}])
    expect(s.restore("gl-1").send).toEqual([])
  })

  test("reconnect backoff doubles, and the active glasses go first", () => {
    const {s, c} = rig()
    s.start()
    s.connected(glassesHello())
    s.connected(ringHello())
    s.disconnected("ring-1")
    s.disconnected("gl-1")
    expect(s.reconnectDue()).toEqual(["gl-1", "ring-1"])
    expect(s.reconnectDue()).toEqual([])
    c.t += 1000
    expect(s.reconnectDue()).toEqual(["gl-1", "ring-1"])
    c.t += 1999
    expect(s.reconnectDue()).toEqual([])
    c.t += 1
    expect(s.reconnectDue()).toEqual(["gl-1", "ring-1"])
  })

  test("a second pair of glasses is never made active automatically", () => {
    const {s, registry} = rig()
    registry.enroll({deviceId: "gl-2", kind: "glasses", model: "MYGL-DK1", firmwareVersion: "0.3.0", protocolVersion: 1})
    s.addDevice("gl-2", "glasses")
    expect(s.activeDevice("glasses")).toBe("gl-1")
    s.start()
    s.connected(glassesHello({deviceId: "gl-2"}))
    expect(s.mode()).toBe("phone_only")
    s.setActive("glasses", "gl-2")
    expect(s.mode()).toBe("glasses_only")
  })

  test("revoking a device drops its queued commands and its active role", () => {
    const {s, c} = rig()
    s.start()
    s.connected(glassesHello())
    s.hold({id: "x", deviceId: "gl-1", consequential: false, expiresAt: c.t + 10_000, payload: {}})
    s.revoked("gl-1")
    expect(s.activeDevice("glasses")).toBeUndefined()
    expect(s.connected(glassesHello())).toEqual({ok: false, reason: "revoked"})
    expect(s.restore("gl-1").send).toEqual([])
  })

  test("app process death: every link comes back disconnected, commands do not survive", () => {
    const {s, c, registry} = rig()
    s.start()
    s.connected(glassesHello())
    s.connected(ringHello())
    s.hold({id: "x", deviceId: "gl-1", consequential: false, expiresAt: c.t + 10_000, payload: {}})
    const snap = JSON.parse(JSON.stringify(s.snapshot()))
    const back = SessionManager.restore(snap, {registry, now: c.now})
    expect(back.sessionState).toBe("recovering")
    expect(back.linkState("gl-1")).toBe("disconnected")
    expect(registry.check("gl-1", ["display"])).toMatchObject({ok: false, reason: "not_connected"})
    expect(back.restore("gl-1").send).toEqual([])
    back.connected(glassesHello())
    back.connected(ringHello())
    expect(back.sessionState).toBe("ready")
  })

  test("suspend, wake and teardown", () => {
    const {s} = rig()
    s.start()
    s.connected(glassesHello())
    s.connected(ringHello())
    s.suspend()
    expect(s.status().message).toBe("Paused.")
    s.wake()
    expect(s.sessionState).toBe("ready")
    s.end("phone_replaced")
    expect(s.sessionState).toBe("ended")
    expect(s.id).toBeNull()
  })
})

describe("ANI-206: the policy engine", () => {
  const ctx: DeviceContext = {driving: false, inMeeting: false, doNotDisturb: false, localMinutes: 12 * 60}
  function rig() {
    const c = clock()
    const p = new PolicyEngine({now: c.now, verify: e => e.signature === `ok:${e.eventId}`})
    let n = 0
    const grant = (over: Partial<ConsentGrant> = {}): ConsentGrant => {
      const eventId = over.eventId ?? `g${++n}`
      return {kind: "grant", eventId, scopeId: "meeting-42", purposes: ["assistant_answer"], categories: ["transcript"], maxReach: "site",
        issuedAt: c.t, expiresAt: c.t + 3_600_000, signature: `ok:${eventId}`, ...over}
    }
    const revoke = (over: Partial<ConsentEvent> = {}): ConsentEvent => {
      const eventId = over.eventId ?? `r${++n}`
      return {kind: "revoke", eventId, scopeId: "meeting-42", issuedAt: c.t, signature: `ok:${eventId}`, ...over} as ConsentEvent
    }
    return {p, c, grant, revoke}
  }

  test("data needs a live grant for its purpose, category and destination", () => {
    const {p, grant} = rig()
    const req = {scopeId: "meeting-42", category: "transcript" as const, purpose: "assistant_answer" as const, destination: "site" as const}
    expect(p.authorizeData(req).reason).toBe("scope_unknown")
    p.apply(grant())
    expect(p.authorizeData(req).decision).toBe("allow")
    expect(p.authorizeData({...req, destination: "cloud"})).toMatchObject({decision: "redact", reason: "destination_beyond_consent"})
    expect(p.authorizeData({...req, purpose: "analytics"})).toMatchObject({decision: "deny", reason: "purpose_or_category_not_granted"})
    expect(p.authorizeData({...req, category: "audio"})).toMatchObject({decision: "deny"})
    expect(p.authorizeData({category: "memory", purpose: "assistant_answer", destination: "cloud"})).toMatchObject({decision: "allow", reason: "self_reported"})
  })

  test("grants expire", () => {
    const {p, c, grant} = rig()
    p.apply(grant())
    c.t += 3_600_001
    expect(p.authorizeData({scopeId: "meeting-42", category: "transcript", purpose: "assistant_answer", destination: "device"}).reason).toBe("scope_expired")
  })

  test("revocation wins over a grant that arrives after it, whatever its timestamp", () => {
    const {p, c, grant, revoke} = rig()
    const delayed = grant({issuedAt: c.t - 10_000})
    p.apply(revoke())
    expect(p.apply(delayed)).toBe(false)
    expect(p.authorizeData({scopeId: "meeting-42", category: "transcript", purpose: "assistant_answer", destination: "device"}).reason).toBe("scope_revoked")
    expect(p.reach("meeting-42")).toBeNull()
    expect(p.audits().some(a => a.reason === "scope_revoked" && a.decision === "ignored")).toBe(true)
  })

  test("forged and replayed consent events change nothing", () => {
    const {p, grant} = rig()
    expect(p.apply({...grant(), signature: "forged"})).toBe(false)
    expect(p.reach("meeting-42")).toBeNull()
    const g = grant()
    expect(p.apply(g)).toBe(true)
    expect(p.apply(g)).toBe(false)
    expect(p.audits().map(a => a.reason)).toContain("replayed")
  })

  test("voice identity can be neither granted nor used", () => {
    const {p, grant} = rig()
    expect(p.apply(grant({categories: ["voice_identity"]}))).toBe(false)
    expect(p.authorizeData({category: "voice_identity", purpose: "assistant_answer", destination: "device"}).decision).toBe("deny")
  })

  test("it is the ConsentPolicy the model router uses, per purpose", () => {
    const {p, grant} = rig()
    p.apply(grant({purposes: ["assistant_answer"], maxReach: "site"}))
    p.apply(grant({purposes: ["vision_qa"], maxReach: "cloud"}))
    expect(p.reach("meeting-42")).toBe("site")
    expect(p.forPurpose("vision_qa").reach("meeting-42")).toBe("cloud")
    expect(p.forPurpose("navigation").reach("meeting-42")).toBeNull()
  })

  test("a consequential action needs a confirmation for exactly this payload, once", () => {
    const {p, c} = rig()
    const req = {actionId: "message.send", risk: "consequential" as const, payloadHash: "h1", output: "silent" as const, deviceTrusted: true}
    expect(p.authorizeAction(req, ctx)).toMatchObject({decision: "require_confirmation"})
    const token = p.confirm("message.send", "h1")
    expect(p.authorizeAction({...req, payloadHash: "h2", confirmationToken: token}, ctx).reason).toBe("confirmation_for_other_payload")
    const fresh = p.confirm("message.send", "h1")
    expect(p.authorizeAction({...req, confirmationToken: fresh}, ctx).decision).toBe("allow")
    expect(p.authorizeAction({...req, confirmationToken: fresh}, ctx).reason).toBe("confirmation_unknown_or_used")
    const late = p.confirm("message.send", "h1")
    c.t += 60_001
    expect(p.authorizeAction({...req, confirmationToken: late}, ctx).reason).toBe("confirmation_expired")
  })

  test("driving degrades, DND, meetings and quiet hours defer; urgent output is never held", () => {
    const {p} = rig()
    const card = {actionId: "hud.show_card", risk: "state_change" as const, payloadHash: "h", output: "interrupt" as const, deviceTrusted: true}
    expect(p.authorizeAction(card, {...ctx, driving: true}).decision).toBe("degrade")
    expect(p.authorizeAction(card, {...ctx, doNotDisturb: true}).decision).toBe("defer")
    expect(p.authorizeAction(card, {...ctx, inMeeting: true}).decision).toBe("defer")
    expect(p.authorizeAction(card, {...ctx, localMinutes: 23 * 60, quietHours: [22 * 60, 7 * 60]}).reason).toBe("quiet_hours")
    expect(p.authorizeAction(card, {...ctx, localMinutes: 6 * 60, quietHours: [22 * 60, 7 * 60]}).reason).toBe("quiet_hours")
    expect(p.authorizeAction(card, {...ctx, localMinutes: 8 * 60, quietHours: [22 * 60, 7 * 60]}).decision).toBe("allow")
    expect(p.authorizeAction({...card, urgent: true}, {...ctx, driving: true, doNotDisturb: true}).decision).toBe("allow")
  })

  test("an untrusted device and denied data deny the action", () => {
    const {p} = rig()
    const base = {actionId: "x.y", risk: "state_change" as const, payloadHash: "h", output: "silent" as const, deviceTrusted: true}
    expect(p.authorizeAction({...base, deviceTrusted: false}, ctx).reason).toBe("device_not_trusted")
    expect(p.authorizeAction({...base, data: [{scopeId: "nope", category: "image", purpose: "vision_qa", destination: "cloud"}]}, ctx).reason).toBe("data_scope_unknown")
  })

  test("fails closed when a rule throws", () => {
    const c = clock()
    const p = new PolicyEngine({now: c.now, verify: () => true})
    const broken = {scopeId: "s", category: "transcript", purpose: "assistant_answer", get destination(): never {
      throw new Error("boom")
    }} as never
    p.apply({kind: "grant", eventId: "g", scopeId: "s", purposes: ["assistant_answer"], categories: ["transcript"], maxReach: "cloud", issuedAt: c.t, expiresAt: c.t + 1000, signature: "x"})
    expect(p.authorizeData(broken)).toMatchObject({decision: "deny", reason: "evaluation_error"})
  })

  test("audit records carry no content", () => {
    const {p} = rig()
    p.authorizeData({scopeId: "meeting-42", category: "transcript", purpose: "assistant_answer", destination: "cloud"})
    for (const a of p.audits()) expect(Object.keys(a).sort()).toEqual(["at", "decision", "policyVersion", "reason", "ref", "subject"])
  })
})

describe("ANI-205: the action registry", () => {
  const ctx: DeviceContext = {driving: false, inMeeting: false, doNotDisturb: false, localMinutes: 720}
  function rig() {
    const c = clock()
    const devices = new DeviceRegistry(c.now)
    devices.enroll({deviceId: "gl-1", kind: "glasses", model: "MYGL-DK1", firmwareVersion: "0.3.0", protocolVersion: 1})
    devices.enroll({deviceId: "phone", kind: "phone", model: "Pixel", firmwareVersion: "app-1", protocolVersion: 1})
    devices.negotiate(glassesHello())
    devices.negotiate(phoneHello())
    const policy = new PolicyEngine({now: c.now, verify: () => true})
    const targets: Record<string, string | undefined> = {glasses: "gl-1", phone: "phone", ring: undefined}
    const actions = new ActionRegistry({devices, policy, target: d => targets[d], now: c.now})
    for (const a of BUILTIN_ACTIONS) actions.register(a)
    return {actions, policy, devices, c, targets}
  }

  test("the tool list shows only what a connected device can do", () => {
    const {actions} = rig()
    const names = actions.tools().map(t => t.name)
    expect(names).toContain("hud.show_card")
    expect(names).toContain("camera.request_capture")
    // No speaker on these glasses, and no ring connected.
    expect(names).not.toContain("audio.play")
    expect(names).not.toContain("ring.haptic")
  })

  test("unknown actions, versions, fields and bad types are refused", () => {
    const {actions} = rig()
    expect(actions.prepare({action: "ble.raw_write", args: {}}, ctx)).toMatchObject({ok: false, reason: "unknown_action"})
    expect(actions.prepare({action: "hud.show_card", version: 9, args: {line1: "x"}}, ctx)).toMatchObject({reason: "unknown_version"})
    expect(actions.prepare({action: "hud.show_card", args: {line1: "x", packet: "0xA0"}}, ctx)).toMatchObject({reason: "invalid_args", detail: "args.packet: unknown field"})
    expect(actions.prepare({action: "hud.show_card", args: {}}, ctx)).toMatchObject({reason: "invalid_args", detail: "args.line1: required"})
    expect(actions.prepare({action: "hud.show_card", args: {line1: 7}}, ctx)).toMatchObject({reason: "invalid_args"})
    expect(actions.prepare({action: "hud.navigate", args: {direction: "sideways"}}, ctx)).toMatchObject({reason: "invalid_args"})
    expect(actions.prepare({action: "calendar.read_next", args: {count: 2.5}}, ctx)).toMatchObject({reason: "invalid_args"})
    expect(actions.prepare({action: "message.draft", args: {to: "a", body: "x".repeat(5000)}}, ctx)).toMatchObject({reason: "too_large"})
  })

  test("a missing capability is a typed, explainable refusal", () => {
    const {actions, targets} = rig()
    expect(actions.prepare({action: "audio.play", args: {text: "hi"}}, ctx)).toMatchObject({ok: false, reason: "device_unavailable", detail: "speaker: unavailable"})
    expect(actions.prepare({action: "ring.haptic", args: {pattern: "tick"}}, ctx)).toMatchObject({reason: "device_unavailable", detail: "no active ring"})
    targets.glasses = "gl-1"
    expect(actions.prepare({action: "hud.show_card", args: {line1: "ok"}}, ctx).ok).toBe(true)
  })

  test("sending a message needs a confirmation bound to that exact message", () => {
    const {actions, policy} = rig()
    const args = {to: "Asha", body: "Running 5 min late"}
    const first = actions.prepare({action: "message.send", args}, ctx)
    expect(first).toMatchObject({ok: false, reason: "policy", decision: {decision: "require_confirmation"}})
    if (first.ok || first.reason !== "policy") throw new Error("expected policy refusal")
    expect(first.summary).toContain("Running 5 min late")
    const token = policy.confirm("message.send", first.payloadHash!)
    // The body was edited after the yes: the token does not carry over.
    expect(actions.prepare({action: "message.send", args: {...args, body: "Running 50 min late"}, confirmationToken: token}, ctx))
      .toMatchObject({reason: "policy", decision: {reason: "confirmation_for_other_payload"}})
    const again = policy.confirm("message.send", first.payloadHash!)
    expect(actions.prepare({action: "message.send", args, confirmationToken: again}, ctx).ok).toBe(true)
  })

  test("a consequential action cannot be registered without a confirmation policy", () => {
    const {actions} = rig()
    const bad: ActionDefinition = {...BUILTIN_ACTIONS.find(a => a.id === "message.send")!, id: "payment.send", confirmation: undefined}
    expect(() => actions.register(bad)).toThrow(/confirmation/)
    expect(() => actions.register(BUILTIN_ACTIONS[0])).toThrow(/twice/)
  })

  test("versions: the newest non-deprecated is the default; an old one still runs, flagged", () => {
    const {actions} = rig()
    const v1 = BUILTIN_ACTIONS.find(a => a.id === "hud.show_card")!
    actions.register({...v1, version: 2, params: {type: "object", properties: {title: {type: "string", maxLength: 64}}, required: ["title"]}})
    const r1 = actions.prepare({action: "hud.show_card", args: {title: "x"}}, ctx)
    expect(r1.ok && r1.plan.action.version).toBe(2)
    const def = BUILTIN_ACTIONS.find(a => a.id === "hud.navigate")!
    actions.register({...def, version: 2, deprecated: {replacedBy: "hud.navigate@3"}})
    const r2 = actions.prepare({action: "hud.navigate", version: 2, args: {direction: "next"}}, ctx)
    expect(r2.ok && r2.plan.deprecatedWarning).toContain("deprecated")
    // The tool list offers v1, the newest non-deprecated.
    expect(actions.tools().find(t => t.name === "hud.navigate")!.version).toBe(1)
  })

  test("execution times out, never runs a 'once' payload twice, and logs no arguments", async () => {
    const {actions} = rig()
    const p = actions.prepare({action: "task.create", args: {title: "Call the vendor"}}, ctx)
    if (!p.ok) throw new Error("expected ok")
    let runs = 0
    const ok = await actions.execute(p.plan, async () => ++runs)
    const again = await actions.execute(p.plan, async () => ++runs)
    expect(runs).toBe(1)
    expect(again).toEqual(ok)
    const slow = actions.prepare({action: "hud.show_card", args: {line1: "x"}}, ctx)
    if (!slow.ok) throw new Error("expected ok")
    const t = await actions.execute({...slow.plan, action: {...slow.plan.action, timeoutMs: 5}}, () => new Promise(() => {}))
    expect(t.status).toBe("timeout")
    const failed = await actions.execute(slow.plan, async () => {
      throw new Error("BLE write failed")
    })
    expect(failed.status).toBe("error")
    expect(JSON.stringify(actions.outcomes)).not.toContain("Call the vendor")
  })

  test("payload hashes ignore key order and change with any value", () => {
    expect(payloadHash("a", 1, {x: 1, y: 2})).toBe(payloadHash("a", 1, {y: 2, x: 1}))
    expect(payloadHash("a", 1, {x: 1})).not.toBe(payloadHash("a", 1, {x: 2}))
    expect(payloadHash("a", 1, {x: 1})).not.toBe(payloadHash("a", 2, {x: 1}))
  })

  test("the schema validator", () => {
    expect(validate({type: "array", items: {type: "boolean"}, maxItems: 2}, [true, false, true])).toContain("more than 2")
    expect(validate({type: "string", maxLength: 5, pattern: "^[a-z]+$"}, "ab1")).toContain("does not match")
    expect(validate({type: "object", properties: {}}, [])).toContain("expected object")
  })
})
