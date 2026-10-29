/**
 * @fileoverview Custom Glasses hardware capabilities
 *
 * Capability profile for the user's own glasses, driven over the MentraOS BLE
 * protocol (see myglasses/proto/LINK_CONTRACT.md). Resolution has two presets:
 * the Sprint 1 stand-in OLED on the dev board, and the planned waveguide HUD.
 */

import type {Capabilities, DisplayCapabilities} from "../hardware"

/** Single place to rename the device. Must match DeviceTypes.CUSTOM. */
export const CUSTOM_GLASSES_MODEL_NAME = "Custom Glasses"

export type CustomGlassesDisplayPreset = "STANDIN_OLED" | "TARGET_HUD"

export const CUSTOM_GLASSES_RESOLUTIONS: Record<CustomGlassesDisplayPreset, {width: number; height: number}> = {
  /** 128x64 SSD1306-class OLED on the nRF5340 dev board (Sprint 1). */
  STANDIN_OLED: {width: 128, height: 64},
  /** Planned monochrome green micro-LED + waveguide engine. */
  TARGET_HUD: {width: 640, height: 480},
}

export const CUSTOM_GLASSES_DEFAULT_PRESET: CustomGlassesDisplayPreset = "STANDIN_OLED"

function displayFor(preset: CustomGlassesDisplayPreset): DisplayCapabilities {
  const resolution = CUSTOM_GLASSES_RESOLUTIONS[preset]
  return {
    count: 1,
    isColor: false,
    color: "green",
    canDisplayBitmap: true,
    resolution,
    maxTextLines: preset === "STANDIN_OLED" ? 4 : 5,
    adjustBrightness: preset === "TARGET_HUD",
  }
}

/** Build the capability profile for a display preset. */
export function createCustomGlassesCapabilities(
  preset: CustomGlassesDisplayPreset = CUSTOM_GLASSES_DEFAULT_PRESET,
): Capabilities {
  return {
    modelName: CUSTOM_GLASSES_MODEL_NAME,

    hasCamera: false,
    camera: null,

    hasDisplay: true,
    display: displayFor(preset),

    // One PDM mic on the dev board. The firmware runs voice activity detection
    // itself and gates the stream on it, so the radio stays quiet in silence.
    hasMicrophone: true,
    microphone: {count: 1, hasVAD: true},

    hasSpeaker: false,
    speaker: null,

    // IMU used for head-up wake only; raw data not exposed to miniapps yet.
    hasIMU: true,
    imu: {headUpAngle: {min: 0, max: 60}},

    hasButton: true,
    button: {
      count: 1,
      buttons: [{type: "press", events: ["press", "double_press", "long_press"], isCapacitive: false}],
    },

    hasLight: false,
    light: null,

    power: {hasExternalBattery: false},
    hasWifi: false,
    // Firmware OTA (MCUboot/SMP) is not wired into the app yet.
    hasOta: false,
  }
}

/** Default profile registered in HARDWARE_CAPABILITIES. */
export const customGlasses: Capabilities = createCustomGlassesCapabilities()
