/**
 * @fileoverview Hybrid scoring.
 *
 * Embeddings are good at meaning and bad at identifiers. "Tanu", "ANI-53",
 * "₹13 lakh" and "2026-10-28" all sit in roughly the same uninformative region
 * of a sentence-embedding space, so a pure-cosine ranker answers "what did I
 * promise Tanu?" with whatever memory is vaguely about promises. The exact term
 * exists to stop that: a literal hit on a rare token outranks everything.
 */

import {tokenize} from "./embeddings"
import type {Memory} from "./types"

/**
 * Tuning weights. They are summed, not multiplied, so each one's ceiling is its
 * weight. Tune by holding a labelled query set and moving one at a time:
 *  - semantic too high: paraphrases of common phrasings crowd out the right answer.
 *  - exact too high: any memory containing the query word wins, however stale.
 *  - recency too high: the assistant forgets anything older than last week.
 *  - pin too high: pinned memories answer every question.
 * The defaults were chosen so that one exact rare-token hit (0.45) beats a
 * strong-but-generic semantic match (0.55 * 0.8 = 0.44), which is the behaviour
 * the tests pin down.
 */
export const SCORING_WEIGHTS = {
  semantic: 0.55,
  keyword: 0.15,
  exact: 0.45,
  recency: 0.1,
  pin: 0.08,
} as const

/** Memories older than this contribute no recency at all. */
export const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

/** A token shorter than this is too common to count as an exact match. */
const MIN_EXACT_TOKEN = 3

/** Tokens so common that an exact hit on them means nothing. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "when", "where", "who",
  "did", "was", "are", "you", "your", "his", "her", "its", "about", "from",
  "have", "has", "had", "not", "but", "all", "can", "will", "would", "should",
])

export interface ScoreParts {
  semantic: number
  keyword: number
  exact: number
  recency: number
  pin: number
}

/**
 * Fraction of query tokens present in the memory. Cheap, and it carries the
 * weight when the semantic term is unavailable (offline, or consent off).
 */
export function keywordScore(queryTokens: string[], memoryTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0
  let hits = 0
  for (const t of queryTokens) if (memoryTokens.has(t)) hits++
  return hits / queryTokens.length
}

/**
 * Exact-match term. A query token counts when it is rare — a name, a number, an
 * identifier — rather than ordinary vocabulary. Digits always count, because a
 * number in a query is almost always the point of the query.
 */
export function exactScore(queryTokens: string[], memory: Memory, memoryTokens: Set<string>): number {
  const candidates = queryTokens.filter(t => !STOPWORDS.has(t) && (t.length >= MIN_EXACT_TOKEN || /\d/.test(t)))
  if (candidates.length === 0) return 0
  const tagSet = new Set(memory.tags.map(t => t.toLowerCase()))
  let best = 0
  for (const t of candidates) {
    const hasDigit = /\d/.test(t)
    if (tagSet.has(t)) best = Math.max(best, 1)
    else if (memoryTokens.has(t)) best = Math.max(best, hasDigit ? 1 : 0.9)
    // A number may be written differently in the text ("13 lakh" vs "13lakh").
    else if (hasDigit && memory.text.toLowerCase().includes(t)) best = Math.max(best, 0.8)
  }
  return best
}

/** 1 at now, 0.5 one half-life ago, approaching 0 after that. */
export function recencyScore(memory: Memory, now: number): number {
  const age = Math.max(0, now - memory.updatedAt)
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS)
}

export function combine(parts: ScoreParts): number {
  return (
    SCORING_WEIGHTS.semantic * parts.semantic +
    SCORING_WEIGHTS.keyword * parts.keyword +
    SCORING_WEIGHTS.exact * parts.exact +
    SCORING_WEIGHTS.recency * parts.recency +
    SCORING_WEIGHTS.pin * parts.pin
  )
}

/** Tokens of a memory's text and tags, for the keyword and exact terms. */
export function memoryTokens(memory: Memory): Set<string> {
  const set = new Set(tokenize(memory.text))
  for (const tag of memory.tags) for (const t of tokenize(tag)) set.add(t)
  return set
}
