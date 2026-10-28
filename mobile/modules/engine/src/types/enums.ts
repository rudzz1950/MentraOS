export {HardwareType, HardwareRequirementLevel} from "@mentra/miniapp/hardware"

export enum DeviceTypes {
  NONE = "None",
  SIMULATED = "Simulated Glasses",
  AR99 = "AR99",
  G1 = "Even Realities G1",
  G2 = "Even Realities G2",
  LIVE = "Mentra Live",
  MACH1 = "Mentra Mach1",
  Z100 = "Vuzix Z100",
  NEX = "Mentra Display",
  FRAME = "Brilliant Frame",
  NIMO = "NIMO",
  /** Your own glasses (Sprint 1). Rename here and in CUSTOM_GLASSES_MODEL_NAME only. */
  CUSTOM = "Custom Glasses",
}

export enum ControllerTypes {
  R1 = "Even Realities R1",
}
