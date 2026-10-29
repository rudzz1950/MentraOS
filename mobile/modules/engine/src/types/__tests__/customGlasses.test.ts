import {describe, expect, test} from "bun:test"

import {
  CUSTOM_GLASSES_DEFAULT_PRESET,
  CUSTOM_GLASSES_MODEL_NAME,
  CUSTOM_GLASSES_RESOLUTIONS,
  createCustomGlassesCapabilities,
  customGlasses,
} from "../capabilities/custom-glasses"
import {DeviceTypes} from "../enums"
import {getModelCapabilities} from "../hardware"
import {CUSTOM_GLYPH_WIDTH_PX, CUSTOM_PROFILE} from "../../utils/display/profiles/custom"
import {TextMeasurer} from "../../utils/display/measurer"
import {TextWrapper} from "../../utils/display/wrapper"

describe("Custom Glasses capabilities", () => {
  test("the device type and the profile name are the same string", () => {
    // The driver looks the profile up by model name, so a rename must touch both.
    expect(DeviceTypes.CUSTOM).toBe(CUSTOM_GLASSES_MODEL_NAME)
    expect(getModelCapabilities(DeviceTypes.CUSTOM)).toBe(customGlasses)
  })

  test("describes the Sprint 1 hardware: mono green display, one mic, no camera", () => {
    expect(customGlasses.hasDisplay).toBe(true)
    expect(customGlasses.display).toMatchObject({
      count: 1,
      isColor: false,
      color: "green",
      canDisplayBitmap: true,
      resolution: {width: 128, height: 64},
      maxTextLines: 4,
    })
    expect(customGlasses.hasMicrophone).toBe(true)
    expect(customGlasses.microphone).toEqual({count: 1, hasVAD: true})
    expect(customGlasses.hasCamera).toBe(false)
    expect(customGlasses.camera).toBeNull()
    expect(customGlasses.hasSpeaker).toBe(false)
    expect(customGlasses.hasIMU).toBe(true)
    expect(customGlasses.imu).toEqual({headUpAngle: {min: 0, max: 60}})
    expect(customGlasses.hasButton).toBe(true)
    expect(customGlasses.hasWifi).toBe(false)
    expect(customGlasses.hasOta).toBe(false)
  })

  test("defaults to the stand-in OLED and can be built for the target HUD", () => {
    expect(CUSTOM_GLASSES_DEFAULT_PRESET).toBe("STANDIN_OLED")
    expect(CUSTOM_GLASSES_RESOLUTIONS.STANDIN_OLED).toEqual({width: 128, height: 64})

    const target = createCustomGlassesCapabilities("TARGET_HUD")
    expect(target.display?.resolution).toEqual({width: 640, height: 480})
    expect(target.display?.adjustBrightness).toBe(true)
    // Same model name either way: the preset changes geometry, not identity.
    expect(target.modelName).toBe(CUSTOM_GLASSES_MODEL_NAME)
    // The exported default must not be mutated by building another preset.
    expect(customGlasses.display?.resolution).toEqual({width: 128, height: 64})
  })
})

describe("Custom Glasses display profile", () => {
  test("fits 21 fixed-width characters on each of 4 lines", () => {
    expect(CUSTOM_PROFILE.maxLines).toBe(4)
    expect(Math.floor(CUSTOM_PROFILE.displayWidthPx / CUSTOM_GLYPH_WIDTH_PX)).toBe(21)
    expect(CUSTOM_PROFILE.displayHeightPx).toBe(64)
    // A frame must fit the firmware's text buffer and the smallest MTU.
    expect(CUSTOM_PROFILE.maxPayloadBytes).toBeLessThanOrEqual(240)
    expect(CUSTOM_PROFILE.bleChunkSize).toBe(16)
  })

  test("every glyph measures the same width, including non-Latin ones", () => {
    const measurer = new TextMeasurer(CUSTOM_PROFILE)
    expect(measurer.measureText("MMMM")).toBe(4 * CUSTOM_GLYPH_WIDTH_PX)
    expect(measurer.measureText("iiii")).toBe(4 * CUSTOM_GLYPH_WIDTH_PX)
    expect(measurer.measureText("日本語")).toBe(3 * CUSTOM_GLYPH_WIDTH_PX)
  })

  test("wraps at 21 characters", () => {
    const wrapper = new TextWrapper(new TextMeasurer(CUSTOM_PROFILE))
    const {lines} = wrapper.wrap("abcdefghijklmnopqrstuvwxyz")
    expect(lines[0].length).toBeLessThanOrEqual(21)
    expect(lines.length).toBeGreaterThan(1)
  })
})
