/**
 * @fileoverview Is the wearer in a vehicle, and are they the one driving.
 *
 * THE HONEST LIMIT, STATED FIRST. Driving cannot be detected from the glasses'
 * IMU. A car on a smooth road is indistinguishable from a chair: both are a
 * steady 1 g with small vibration. The IMU can separate still from walking and
 * nothing more. So this module does not classify motion from accelerometer
 * data and pretend otherwise — it consumes the two signals that can actually
 * tell, and degrades honestly when neither is present:
 *
 *   1. Platform activity recognition (Android ActivityRecognition, iOS
 *      CMMotionActivity). Purpose-built, power-optimised, and reports
 *      "automotive" directly. MentraOS has no binding for it yet; that is a
 *      native task, and this module takes it as a port.
 *   2. GPS speed. Sustained speed above a walking pace means a vehicle,
 *      whoever is at the wheel.
 *
 * Classifying on the glasses was the other option and is worse: contract v0
 * carries no motion message, so it would need a v1 addition, and streaming IMU
 * over BLE to compute something the phone already knows would spend radio and
 * battery for a worse answer.
 *
 * WHICH WAY TO BE WRONG. A false negative shows a message body to someone
 * driving. A false positive reduces cards for someone sitting in a car park.
 * The first is dangerous and the second is annoying, so every threshold here
 * is biased towards deciding "driving", and leaving that state is deliberately
 * slower than entering it.
 *
 * THE PASSENGER PROBLEM. No sensor distinguishes a driver from a passenger, so
 * this is a product decision rather than a technical one and all three answers
 * are implemented rather than guessed:
 *
 *   "assume_driver" — in a vehicle means driving. Safe; wrong for every
 *                     passenger, on every journey.
 *   "ask_once"      — ask once per trip and remember the answer for that trip,
 *                     treating them as the driver until they say otherwise.
 *   "manual_only"   — never infer; the wearer sets it.
 *
 * The default is "assume_driver" because it is the one that cannot hurt
 * anybody, not because it is the best experience.
 */

import type {Clock, Unsubscribe} from "./ports"

export type Activity = "still" | "walking" | "running" | "automotive" | "cycling" | "unknown"

export interface ActivitySample {
  activity: Activity
  /** 0..100, as both platforms report it. Low confidence is ignored. */
  confidence: number
}

/** Metres per second, from a location fix. */
export interface SpeedSample {
  speedMps: number
  /** Horizontal accuracy in metres; a poor fix is not trusted for speed. */
  accuracyM?: number
}

export interface MotionSource {
  onActivity?(handler: (s: ActivitySample) => void): Unsubscribe
  onSpeed?(handler: (s: SpeedSample) => void): Unsubscribe
}

export type PassengerPolicy = "assume_driver" | "ask_once" | "manual_only"

export interface MotionStateOptions {
  clock: Clock
  policy?: PassengerPolicy
  /** Below this, a platform activity report is not acted on. */
  minConfidence?: number
  /** Sustained speed at or above this means a vehicle. 7 m/s = 25 km/h. */
  vehicleMps?: number
  /** Speed must hold for this long before entering the vehicle state. */
  enterMs?: number
  /**
   * And must stay below for this much longer before leaving it. Longer than
   * `enterMs` on purpose: traffic lights must not flicker the HUD.
   */
  exitMs?: number
  /** A fix worse than this is ignored for speed. */
  maxAccuracyM?: number
}

const DEFAULTS = {
  minConfidence: 50,
  vehicleMps: 7,
  enterMs: 3000,
  exitMs: 60_000,
  maxAccuracyM: 50,
}

export class MotionState {
  private readonly clock: Clock
  private readonly o: typeof DEFAULTS
  readonly policy: PassengerPolicy

  private inVehicle = false
  /** When the evidence for the pending change first appeared. */
  private pendingSince: number | null = null
  private pendingValue = false

  /** Set by the wearer; overrides everything while not null. */
  private manual: boolean | null = null
  /** The answer to "are you driving" for the current trip. */
  private tripAnswer: boolean | null = null
  private lastActivity: Activity = "unknown"
  /** True once there has been any usable evidence at all. */
  private haveEvidence = false

  constructor(opts: MotionStateOptions) {
    this.clock = opts.clock
    this.policy = opts.policy ?? "assume_driver"
    this.o = {
      minConfidence: opts.minConfidence ?? DEFAULTS.minConfidence,
      vehicleMps: opts.vehicleMps ?? DEFAULTS.vehicleMps,
      enterMs: opts.enterMs ?? DEFAULTS.enterMs,
      exitMs: opts.exitMs ?? DEFAULTS.exitMs,
      maxAccuracyM: opts.maxAccuracyM ?? DEFAULTS.maxAccuracyM,
    }
  }

  /** Subscribe to whichever signals the platform actually offers. */
  attach(source: MotionSource): Unsubscribe {
    const subs: Unsubscribe[] = []
    if (source.onActivity) subs.push(source.onActivity(s => this.onActivity(s)))
    if (source.onSpeed) subs.push(source.onSpeed(s => this.onSpeed(s)))
    return () => subs.forEach(u => u())
  }

  onActivity(s: ActivitySample): void {
    if (s.confidence < this.o.minConfidence) return
    this.haveEvidence = true
    this.lastActivity = s.activity
    // Cycling is not driving, but it is not a context for reading either. It
    // is left to the caller: this module answers the vehicle question only.
    this.propose(s.activity === "automotive")
  }

  onSpeed(s: SpeedSample): void {
    if (s.accuracyM !== undefined && s.accuracyM > this.o.maxAccuracyM) return
    if (!Number.isFinite(s.speedMps) || s.speedMps < 0) return
    this.haveEvidence = true
    this.propose(s.speedMps >= this.o.vehicleMps)
  }

  /**
   * Hysteresis. Entering the vehicle state is quick; leaving it takes much
   * longer, so a red light or a petrol stop does not turn the message body
   * back on while the wearer is still at the wheel.
   */
  private propose(vehicle: boolean): void {
    if (vehicle === this.inVehicle) {
      this.pendingSince = null
      return
    }
    const now = this.clock.now()
    if (this.pendingSince === null || this.pendingValue !== vehicle) {
      this.pendingSince = now
      this.pendingValue = vehicle
      return
    }
    const needed = vehicle ? this.o.enterMs : this.o.exitMs
    if (now - this.pendingSince >= needed) {
      this.inVehicle = vehicle
      this.pendingSince = null
      // A new trip asks again; ending one forgets the answer.
      if (!vehicle) this.tripAnswer = null
    }
  }

  /**
   * Re-evaluate without new evidence, so a pending transition can complete on
   * a timer rather than waiting for the next sample. Harmless when idle.
   */
  tick(): void {
    if (this.pendingSince === null) return
    this.propose(this.pendingValue)
  }

  /** The wearer's own switch. null hands control back to the sensors. */
  setManual(driving: boolean | null): void {
    this.manual = driving
  }

  /** The answer to the once-per-trip question. */
  answerForThisTrip(isDriver: boolean): void {
    this.tripAnswer = isDriver
  }

  /** True when the "ask_once" policy owes the wearer a question. */
  get needsAsking(): boolean {
    return this.policy === "ask_once" && this.inVehicle && this.tripAnswer === null
  }

  get vehicle(): boolean {
    return this.inVehicle
  }

  get activity(): Activity {
    return this.lastActivity
  }

  /**
   * The predicate the turn loop and the card gate consume.
   *
   * With no usable signal at all this returns false — the honest answer, since
   * nothing here can tell. That is a real gap, not a safe default: a build with
   * no activity binding and no location permission has no driving protection,
   * and `sensing` says so rather than letting it pass unnoticed.
   */
  driving(): boolean {
    if (this.manual !== null) return this.manual
    switch (this.policy) {
      case "manual_only":
        return false
      case "ask_once":
        // Treated as the driver until they say they are not.
        return this.inVehicle && this.tripAnswer !== false
      case "assume_driver":
        return this.inVehicle
    }
  }

  /**
   * False when nothing is feeding this: no platform activity, no usable speed.
   * The caller should surface that rather than imply the HUD is protected.
   */
  get sensing(): boolean {
    return this.manual !== null || this.haveEvidence
  }
}

/**
 * Still versus walking from the accelerometer — the only motion question an
 * IMU can honestly answer. Offered for the HUD's own use (a card can be held
 * back while the wearer is walking) and explicitly NOT as a driving signal.
 *
 * @param magnitudes recent |a| samples in g.
 */
export function stillOrWalking(magnitudes: number[]): "still" | "walking" | "unknown" {
  if (magnitudes.length < 8) return "unknown"
  const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length
  const variance = magnitudes.reduce((a, b) => a + (b - mean) ** 2, 0) / magnitudes.length
  // A seated or standing wearer sits under about 0.01 g^2; a stride is an
  // order of magnitude above that.
  return variance > 0.02 ? "walking" : "still"
}
