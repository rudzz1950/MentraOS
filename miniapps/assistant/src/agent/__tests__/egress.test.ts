/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {MemoryService} from "../../memory/memory"
import {MemoryBlobStore, MemoryKeyValueStore} from "../../memory/ports"
import {allows, DEVICE_ONLY, memoryReach, type ConsentPolicy, type Locality} from "../egress"
import {ModelRouter} from "../model"
import type {Clock, Hud, ModelClient, Voice} from "../ports"
import {buildTiers} from "../providers"
import {Assistant} from "../turn"

const T0 = 1_761_000_000_000
const clock: Clock = {now: () => T0}

const hud: Hud = {show: async () => {}, clear: async () => {}}
const voice: Voice = {speak: async () => {}, stop: async () => {}}

/** A model at a stated place that records every prompt it was sent. */
class Tier implements ModelClient {
  prompts: string[] = []
  constructor(
    readonly name: string,
    readonly locality: Locality | undefined,
    private readonly reply: string | null = "ok",
  ) {}
  async *complete(prompt: string): AsyncIterable<string> {
    this.prompts.push(prompt)
    if (this.reply === null) throw new Error("down")
    yield this.reply
  }
}

async function rig(tiers: ModelClient[], consent?: ConsentPolicy) {
  const memory = new MemoryService({
    storage: new MemoryKeyValueStore(),
    blobs: new MemoryBlobStore(),
    now: () => T0,
    embeddingsEnabled: true,
  })
  // The wearer's own note, and something someone else said in the room.
  await memory.add({class: "episodic", text: "vendor meeting is on Friday", source: {turnId: "t1", turnAt: T0}})
  await memory.add({
    class: "episodic",
    text: "Asha said the vendor will slip two weeks",
    source: {turnId: "t2", turnAt: T0, provenance: "captured", scopeId: "meeting-42"},
  })
  const assistant = new Assistant({
    transcripts: {on: () => () => {}},
    hud,
    voice,
    memory,
    router: new ModelRouter(tiers, 50),
    clock,
    consent,
  })
  return {assistant, memory}
}

describe("captured memories do not leave the device by default", () => {
  test("a cloud tier answers without what someone else said", async () => {
    const cloud = new Tier("cloud", "cloud", "Friday.")
    const {assistant} = await rig([cloud])
    const r = await assistant.handle("when is the vendor meeting", true)

    expect(r.answer).toBe("Friday.")
    expect(cloud.prompts[0]).toContain("vendor meeting is on Friday")
    expect(cloud.prompts[0]).not.toContain("Asha")
    expect(r.withheld).toBe(1)
  })

  test("a device tier sees it", async () => {
    const device = new Tier("phone", "device")
    const {assistant} = await rig([device])
    const r = await assistant.handle("when is the vendor meeting", true)
    expect(device.prompts[0]).toContain("Asha said the vendor will slip")
    expect(r.withheld).toBeUndefined()
  })

  test("a tier that does not say where it runs is treated as cloud", async () => {
    const unknown = new Tier("mystery", undefined)
    const {assistant} = await rig([unknown])
    await assistant.handle("when is the vendor meeting", true)
    expect(unknown.prompts[0]).not.toContain("Asha")
  })

  test("falling through tiers rebuilds the prompt for each one", async () => {
    // The device tier is down; the cloud tier must not inherit its prompt.
    const device = new Tier("phone", "device", null)
    const cloud = new Tier("cloud", "cloud", "Friday.")
    const {assistant} = await rig([device, cloud])
    const r = await assistant.handle("when is the vendor meeting", true)
    expect(device.prompts[0]).toContain("Asha")
    expect(cloud.prompts[0]).not.toContain("Asha")
    expect(r.via).toBe("cloud")
  })
})

describe("an answer is as private as what it was built from", () => {
  test("a device answer drawn from a captured memory never reaches a later cloud prompt", async () => {
    // Turn one: answered on the phone from Asha's words. Turn two: a follow-up
    // that only the cloud answers. The history would have carried her words
    // across in the "Answered:" line.
    const device = new Tier("phone", "device", "Asha thinks it slips two weeks.")
    const cloud = new Tier("cloud", "cloud", "Noted.")
    const {assistant} = await rig([device, cloud])
    await assistant.handle("when is the vendor meeting", true)

    device.prompts.length = 0
    const onlyCloud = new Tier("cloud", "cloud", "Sure.")
    ;(assistant as unknown as {opts: {router: ModelRouter}}).opts.router = new ModelRouter([onlyCloud], 50)
    const r = await assistant.handle("and what about the week after", true)
    expect(onlyCloud.prompts[0]).not.toContain("slips two weeks")
    expect(r.withheld).toBeGreaterThanOrEqual(1)
  })

  test("a cloud answer built only from shareable context stays in history for the next cloud turn", async () => {
    const cloud = new Tier("cloud", "cloud", "Friday.")
    const {assistant} = await rig([cloud])
    await assistant.handle("when is the vendor meeting", true)
    await assistant.handle("and who is attending", true)
    expect(cloud.prompts[1]).toContain("Answered: Friday.")
  })
})

describe("the consent policy decides how far a scope may go", () => {
  test("a scope granted for the site reaches a site tier and not the cloud", async () => {
    const policy: ConsentPolicy = {reach: id => (id === "meeting-42" ? "site" : null)}
    const site = new Tier("plant", "site", null)
    const cloud = new Tier("cloud", "cloud")
    const {assistant} = await rig([site, cloud], policy)
    await assistant.handle("when is the vendor meeting", true)
    expect(site.prompts[0]).toContain("Asha")
    expect(cloud.prompts[0]).not.toContain("Asha")
  })

  test("an unknown scope is device-only, never unrestricted", () => {
    const m = {source: {turnId: "t", turnAt: 0, provenance: "captured", scopeId: "gone"}} as never
    expect(memoryReach(m, {reach: () => null})).toBe("device")
    expect(memoryReach(m, DEVICE_ONLY)).toBe("device")
  })

  test("the wearer's own notes are unrestricted, as before", () => {
    const m = {source: {turnId: "t", turnAt: 0}} as never
    expect(memoryReach(m, DEVICE_ONLY)).toBe("cloud")
  })

  test("reach ordering", () => {
    expect(allows("device", "device")).toBe(true)
    expect(allows("device", "site")).toBe(false)
    expect(allows("site", "site")).toBe(true)
    expect(allows("site", "cloud")).toBe(false)
    expect(allows("cloud", "device")).toBe(true)
  })
})

describe("configured tiers say where they run", () => {
  test("a configured tier with no locality is cloud; a stated one is kept", () => {
    const {clients} = buildTiers({
      tiers: [
        {name: "hosted", baseUrl: "https://example.invalid", model: "m"},
        {name: "plant", baseUrl: "http://10.0.0.5:8000", model: "m", locality: "site"},
      ],
    })
    expect(clients.map(c => c.locality)).toEqual(["cloud", "site"])
  })
})
