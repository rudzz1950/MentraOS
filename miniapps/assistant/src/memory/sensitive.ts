/**
 * @fileoverview The one rule the agent cannot talk itself out of.
 *
 * The agent may not *infer* a sensitive attribute about the user. It may store
 * what the user states about themselves, because that is the user's own fact —
 * but an `inferred_preference` that looks like a health, religion, politics,
 * sexuality, finance, biometric or ethnicity claim is refused at the service
 * boundary, before it reaches storage. This is enforced here rather than in a
 * prompt because a prompt is a request and this is a rule.
 *
 * The matcher is deliberately blunt and will refuse some harmless inferences.
 * That is the right failure direction: a missed inference costs a little
 * personalization, a stored one costs the user's trust.
 */

export type SensitiveCategory =
  | "health"
  | "religion"
  | "politics"
  | "sexuality"
  | "ethnicity"
  | "finance"
  | "biometric"

const PATTERNS: [SensitiveCategory, RegExp][] = [
  [
    "health",
    /\b(diagnos\w*|symptom\w*|illness|disease|depress\w*|anxiet\w*|anxious|therapy|therapist|medication|meds|prescri\w*|disorder|disabled|disability|pregnan\w*|addict\w*|sober|cancer|diabet\w*|adhd|autis\w*|bipolar|insomnia|chronic)\b/i,
  ],
  ["religion", /\b(religio\w*|muslim|hindu|christian|catholic|jewish|sikh|buddhist|atheist|agnostic|church|mosque|temple|synagogue|fasting|ramadan|lent)\b/i],
  ["politics", /\b(politic\w*|votes?|voted|voting|party|bjp|congress|liberal|conservative|leftist|right.?wing|election)\b/i],
  ["sexuality", /\b(sexual\w*|sexuality|gay|lesbian|bisexual|queer|straight|transgender|trans\b|orientation)\b/i],
  ["ethnicity", /\b(caste|race|racial|ethnic\w*|brahmin|dalit|tribe|tribal|immigrant|nationality)\b/i],
  ["finance", /\b(salary|income|debt|loan|credit score|bankrupt\w*|broke|poor|wealthy|net worth|savings)\b/i],
  ["biometric", /\b(fingerprint|face.?print|iris scan|dna|genetic|biometric|heart rate|blood pressure)\b/i],
]

export class SensitiveInferenceError extends Error {
  constructor(readonly category: SensitiveCategory) {
    super(
      `Refusing to store an inferred memory that reads as a ${category} attribute. ` +
        `Sensitive categories may only be stored when the user states them directly.`,
    )
    this.name = "SensitiveInferenceError"
  }
}

/** The first category the text trips, or null. */
export function detectSensitive(text: string): SensitiveCategory | null {
  for (const [category, pattern] of PATTERNS) if (pattern.test(text)) return category
  return null
}
