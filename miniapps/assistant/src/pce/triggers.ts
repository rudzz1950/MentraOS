/**
 * @fileoverview Speaking up without being asked. ANI-209.
 *
 * A proactive assistant that is wrong or noisy is worse than none: the
 * wearer learns to ignore it, and then misses the one that mattered. So a
 * suggestion appears only when ALL of these hold, and each refusal says why:
 *
 *   - it comes from a rule the wearer enabled and has not snoozed;
 *   - the signal that fired it is permitted (location, ambient audio and
 *     camera rules need an explicit opt-in on top of being enabled);
 *   - the same subject has not been raised within the rule's interval, and a
 *     burst of signals is one suggestion, not ten;
 *   - the hourly budget has room — a safety rule may exceed it, and still
 *     counts against it;
 *   - policy allows the interruption now (quiet hours, DND, meetings, driving
 *     — evaluated by the PolicyEngine, not re-implemented here).
 *
 * Deterministic rules and model suggestions are kept apart. A model may only
 * PROPOSE text for a rule that already fired; it cannot create a trigger, and
 * its proposal is marked as such in the explanation.
 *
 * Every suggestion carries `why`: the rule, the signals and their times. A
 * suggestion that cannot explain itself is not shown.
 */

import type {Clock} from "../agent/ports"
import {RollingWindow} from "../util/window"
import type {DeviceContext, PolicyEngine} from "./policy"

export type TriggerKind =
  | "calendar"
  | "task_reminder"
  | "device_state"
  /** Only summaries the wearer approved; never raw readings, never inferences. */
  | "wellness_summary"
  | "location"
  | "ambient_audio"
  | "camera"

/** These need an explicit opt-in as well as being enabled. */
export const OPT_IN_KINDS: ReadonlySet<TriggerKind> = new Set(["location", "ambient_audio", "camera"])

export interface TriggerRule {
  id: string
  kind: TriggerKind
  description: string
  enabled: boolean
  /** Set by the wearer for the opt-in kinds. Absent or false means off. */
  optedIn?: boolean
  priority: "safety" | "high" | "normal" | "low"
  /** The same subject is not raised again within this long. */
  minIntervalMs: number
  snoozedUntil?: number
}

export interface Signal {
  kind: TriggerKind
  /** What it is about, for deduplication: an event id, a task id, "battery". */
  subject: string
  at: number
  /** The text a deterministic rule would say. */
  text: string
  /** Whether the source permission (calendar, location, mic, camera) is currently granted. */
  permitted: boolean
}

export type Outcome =
  | {shown: true; suggestion: Suggestion}
  | {shown: false; ruleId?: string; reason: string}

export interface Suggestion {
  ruleId: string
  text: string
  priority: TriggerRule["priority"]
  why: {rule: string; signals: {kind: TriggerKind; subject: string; at: number}[]; textFrom: "rule" | "model"}
}

/**
 * Words that would make a suggestion about a sensitive trait. A wellness
 * summary may say "you slept 5 hours"; it may not say "you seem depressed".
 */
const SENSITIVE_INFERENCE = /\b(depress\w*|anxi\w*|pregnan\w*|diabet\w*|disorder|illness|disease|diagnos\w*|addict\w*|sexual\w*|religio\w*|caste|politic\w*)\b/i

export class Proactive {
  private rules = new Map<string, TriggerRule>()
  private lastRaised = new Map<string, number>()
  private budget: RollingWindow
  readonly log: Outcome[] = []

  constructor(
    private readonly deps: {
      clock: Clock
      policy: PolicyEngine
      context: () => DeviceContext
      /** Suggestions per rolling hour. Four by default. */
      hourlyBudget?: number
    },
  ) {
    this.budget = new RollingWindow(deps.clock, deps.hourlyBudget ?? 4, 3_600_000)
  }

  // ---- controls --------------------------------------------------------

  addRule(r: TriggerRule): void {
    if (r.kind === "wellness_summary" && r.priority === "safety") {
      // A wellness rule raising itself to safety priority would get past
      // every budget and quiet hour on the strength of a consumer sensor.
      throw new Error("A wellness rule cannot be safety priority")
    }
    this.rules.set(r.id, {...r})
  }
  enable(id: string, on: boolean): void {
    this.must(id).enabled = on
  }
  optIn(id: string, on: boolean): void {
    this.must(id).optedIn = on
  }
  snooze(id: string, untilMs: number): void {
    this.must(id).snoozedUntil = untilMs
  }
  tune(id: string, minIntervalMs: number): void {
    if (!(minIntervalMs >= 60_000)) throw new Error("Interval below one minute")
    this.must(id).minIntervalMs = minIntervalMs
  }
  remove(id: string): void {
    this.rules.delete(id)
  }
  list(): TriggerRule[] {
    return [...this.rules.values()].map(r => ({...r}))
  }

  // ---- evaluation ------------------------------------------------------

  /**
   * One signal against one rule. `modelText`, when given, replaces the rule's
   * own text and is marked as model-written; it cannot fire a rule by itself.
   */
  evaluate(ruleId: string, signal: Signal, modelText?: string): Outcome {
    const out = this.decide(ruleId, signal, modelText)
    this.log.push(out)
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200)
    return out
  }

  private decide(ruleId: string, signal: Signal, modelText?: string): Outcome {
    const now = this.deps.clock.now()
    const no = (reason: string): Outcome => ({shown: false, ruleId, reason})
    const rule = this.rules.get(ruleId)
    if (!rule) return no("no_such_rule")
    if (!rule.enabled) return no("rule_disabled")
    if (rule.snoozedUntil !== undefined && now < rule.snoozedUntil) return no("snoozed")
    if (rule.kind !== signal.kind) return no("signal_kind_mismatch")
    if (OPT_IN_KINDS.has(rule.kind) && !rule.optedIn) return no("not_opted_in")
    if (!signal.permitted) return no("signal_not_permitted")

    const text = (modelText ?? signal.text).trim()
    if (!text || text.length > 160) return no("text_invalid")
    if (SENSITIVE_INFERENCE.test(text)) return no("sensitive_inference")

    const key = `${ruleId}|${signal.subject}`
    const last = this.lastRaised.get(key)
    if (last !== undefined && now - last < rule.minIntervalMs) return no("repeat_suppressed")

    const safety = rule.priority === "safety"
    if (!safety && this.budget.exhausted()) return no("budget_exhausted")
    if (rule.priority === "low" && this.budget.remaining() <= 1) return no("budget_reserved_for_higher_priority")

    const d = this.deps.policy.authorizeAction(
      {actionId: `proactive.${rule.kind}`, risk: "observe", payloadHash: key, output: "interrupt", urgent: safety, deviceTrusted: true},
      this.deps.context(),
    )
    if (d.decision !== "allow") return no(`policy_${d.reason}`)

    this.lastRaised.set(key, now)
    if (safety) this.budget.forceTake()
    else this.budget.tryTake()
    return {
      shown: true,
      suggestion: {
        ruleId,
        text,
        priority: rule.priority,
        why: {rule: rule.description, signals: [{kind: signal.kind, subject: signal.subject, at: signal.at}], textFrom: modelText ? "model" : "rule"},
      },
    }
  }

  /** "Why did you say that?" — the explanation of the most recent suggestion from a rule. */
  explain(ruleId: string): Suggestion["why"] | null {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const o = this.log[i]
      if (o.shown && o.suggestion.ruleId === ruleId) return o.suggestion.why
    }
    return null
  }

  private must(id: string): TriggerRule {
    const r = this.rules.get(id)
    if (!r) throw new Error(`No trigger ${id}`)
    return r
  }
}
