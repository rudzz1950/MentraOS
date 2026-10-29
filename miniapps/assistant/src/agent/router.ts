/**
 * @fileoverview What kind of utterance was that?
 *
 * A microphone on someone's face hears everything: their question, their half
 * of a phone call, and the conversation at the next table. Deciding what is
 * addressed to the assistant is the difference between a device that helps and
 * one that interrupts. Getting this wrong in the "ignore" direction is a missed
 * question; getting it wrong the other way is the assistant talking over a
 * meeting, which is much worse. It is biased accordingly.
 */

export type Intent =
  /** Answer it. No side effects. */
  | "question"
  /** Do something. May need confirmation. */
  | "action"
  /** Remember this. */
  | "note"
  /** Not addressed to us. Say and do nothing. */
  | "not_for_me"

const ACTION_VERBS = [
  "remind", "send", "message", "text", "email", "call", "schedule", "book",
  "set", "add", "create", "cancel", "delete", "turn on", "turn off", "play",
  "pause", "navigate", "start", "stop",
]

const NOTE_PHRASES = ["remember that", "remember this", "note that", "make a note", "don't forget"]

const QUESTION_WORDS = ["what", "who", "when", "where", "why", "how", "which", "is", "are", "do", "does", "can", "should"]

/**
 * `addressed` says whether the wake word fired or the user tapped. Without it
 * the utterance is overheard speech, and the bar for acting on it is total:
 * ambient speech is never an action, however much it sounds like one.
 */
export function classify(text: string, addressed: boolean): Intent {
  const t = text.trim().toLowerCase()
  if (!t) return "not_for_me"
  if (!addressed) return "not_for_me"

  if (NOTE_PHRASES.some(p => t.includes(p))) return "note"

  const first = t.split(/\s+/)[0]
  // An action verb at the start is an instruction; the same verb mid-sentence
  // usually is not ("what time should I set off" is a question).
  if (ACTION_VERBS.some(v => t.startsWith(v + " ") || t.startsWith(v))) return "action"

  if (t.endsWith("?") || QUESTION_WORDS.includes(first)) return "question"

  // Addressed, but not obviously anything. Treat as a question: answering an
  // instruction as a question is harmless, acting on a question is not.
  return "question"
}
