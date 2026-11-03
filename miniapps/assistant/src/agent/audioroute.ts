/**
 * @fileoverview Microphone and speaker together, before echo cancellation exists. ANI-176 (software part).
 *
 * The glasses gaining a speaker (ANI-160) changes barge-in. bargein.ts was
 * written for a world where speech came out of earbuds the mic cannot hear,
 * or a phone speaker it can. A speaker in the frame is the worst case: inches
 * from the microphones, so without acoustic echo cancellation the assistant
 * hears itself, the VAD fires on its own voice, and VAD-triggered barge-in
 * would cut every answer off after a syllable — the self-triggering loop
 * ANI-176's 30-minute test exists to catch.
 *
 * So the barge-in trigger and the VAD's behaviour while speaking are a
 * function of the audio route and whether echo cancellation (ANI-74) is
 * actually running on this frame — reported by the device, never assumed:
 *
 *   route                     AEC    barge-in trigger   VAD while speaking
 *   earbuds (BT)              any    vad                normal
 *   glasses speaker           yes    vad                normal
 *   glasses speaker           no     transcript         raised threshold
 *   phone speaker             any    transcript         raised threshold
 *   call active               any    off                call owns the mic
 *
 * "transcript" barge-in needs words, which the assistant's own voice also
 * produces; the stabiliser (stabilize.ts) plus a minimum word count keep the
 * echo of a sentence from counting, and the measured false-stop rate on the
 * physical frame decides whether that is enough. That measurement is the
 * hardware half of ANI-176 and is not claimed here.
 */

import type {BargeInTrigger} from "./bargein"

export type AudioRoute = "earbuds" | "glasses_speaker" | "phone_speaker"

export interface RoutePolicy {
  bargeIn: BargeInTrigger
  /** Extra VAD threshold in dB while the assistant is speaking. 0 means unchanged. */
  vadBoostDbWhileSpeaking: number
  /** Minimum committed words before transcript barge-in fires. */
  minWords: number
  reason: string
}

export function routePolicy(route: AudioRoute, opts: {aecActive: boolean; callActive: boolean}): RoutePolicy {
  if (opts.callActive) return {bargeIn: "off", vadBoostDbWhileSpeaking: 0, minWords: 0, reason: "the call owns the microphone"}
  if (route === "earbuds") return {bargeIn: "vad", vadBoostDbWhileSpeaking: 0, minWords: 0, reason: "the microphone cannot hear the earbuds"}
  if (route === "glasses_speaker" && opts.aecActive) return {bargeIn: "vad", vadBoostDbWhileSpeaking: 0, minWords: 0, reason: "echo cancellation removes the assistant's own voice"}
  return {
    bargeIn: "transcript",
    vadBoostDbWhileSpeaking: route === "glasses_speaker" ? 12 : 6,
    minWords: 2,
    reason: "without echo cancellation the microphone hears the assistant; only words count",
  }
}

/**
 * The mixed-use soak ANI-176 asks for, as a checklist the physical test fills
 * in. A simulated run cannot satisfy any item (pce/simulator.ts canCloseRequirement).
 */
export const MIXED_USE_SOAK = {
  durationMin: 30,
  scenarios: [
    "assistant answers on the glasses speaker, wearer silent: zero self-interruptions",
    "wearer interrupts mid-answer: playback stops within the barge-in budget",
    "street noise at 70 dBA: no false stops; WER within the project threshold",
    "indoor reverberation: no false stops",
    "wind: no false stops; wearer voice not clipped",
    "incoming call during an answer: assistant yields, call audio routes per ANI-54",
    "call ends: assistant resumes listening without replaying the interrupted answer",
  ],
  record: ["false stops per hour", "stop latency p50/p95 (ms)", "WER quiet / street", "route and AEC state per segment"],
} as const
