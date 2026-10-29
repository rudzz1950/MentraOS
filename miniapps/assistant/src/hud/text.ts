/**
 * @fileoverview Fitting text into a fixed grid.
 *
 * The rule that matters: a card is built from lines that may give way and
 * lines that must survive intact. Wrapping a card as one blob of text is what
 * truncated "Say send to confirm" off a confirmation card and left something
 * that read as "already sent" (ANI-58). So every line declares whether it can
 * be dropped or shortened, and the fitter honours that rather than trimming
 * whatever happens to fall off the end.
 */

import type {PanelProfile} from "./panel"

/** One line of a card, with its own rules about being shortened. */
export interface CardLine {
  text: string
  /**
   * "keep"  — never dropped, never truncated. Must be <= cols or it is an
   *           authoring error and the fitter throws, because silently losing
   *           half of a critical line is the bug this type exists to prevent.
   * "clip"  — truncated with an ellipsis when too long.
   * "wrap"  — flows onto further rows while rows remain.
   * "drop"  — the first thing sacrificed when rows run out.
   */
  fit: "keep" | "clip" | "wrap" | "drop"
}

export class CardTooBigError extends Error {}

const ELLIPSIS = "…"

export function clip(text: string, cols: number): string {
  if (text.length <= cols) return text
  if (cols <= 1) return text.slice(0, cols)
  return text.slice(0, cols - 1) + ELLIPSIS
}

/** Greedy word wrap. Words longer than a row are hard-split rather than lost. */
export function wrap(text: string, cols: number): string[] {
  const out: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word
    while (w.length > cols) {
      if (line) {
        out.push(line)
        line = ""
      }
      out.push(w.slice(0, cols))
      w = w.slice(cols)
    }
    if (!line) line = w
    else if (line.length + 1 + w.length <= cols) line += " " + w
    else {
      out.push(line)
      line = w
    }
  }
  if (line) out.push(line)
  return out
}

/**
 * Lay lines out into the rows available.
 *
 * Budget is spent in priority order: "keep" lines are reserved first, then
 * "clip", then "wrap" takes what is left, and "drop" lines are only placed if
 * there is still room. A wrapped block that does not fit is clipped at its
 * last placed row so the reader can see it was cut.
 */
export function layout(lines: CardLine[], panel: PanelProfile): string[] {
  const cols = panel.cols
  const budget = panel.content.rows

  for (const l of lines) {
    if (l.fit === "keep" && l.text.length > cols) {
      throw new CardTooBigError(
        `a "keep" line needs ${l.text.length} cols but the panel has ${cols}: ${JSON.stringify(l.text)}`,
      )
    }
  }

  const reserved = lines.filter(l => l.fit === "keep").length
  if (reserved > budget) {
    throw new CardTooBigError(`${reserved} "keep" lines but only ${budget} rows`)
  }

  // Rows left for everything that is not a "keep" line.
  let free = budget - reserved
  const placed: (string[] | null)[] = lines.map(() => null)

  // "clip" first: one row each, in order, while free rows remain.
  lines.forEach((l, i) => {
    if (l.fit !== "clip") return
    if (free <= 0) return
    placed[i] = [clip(l.text, cols)]
    free--
  })

  // "wrap" next: takes as many of the remaining rows as it needs.
  lines.forEach((l, i) => {
    if (l.fit !== "wrap") return
    if (free <= 0) return
    const rows = wrap(l.text, cols)
    const taken = rows.slice(0, free)
    // Mark a cut so a truncated answer never reads as a complete one.
    if (rows.length > taken.length && taken.length > 0) {
      taken[taken.length - 1] = clip(taken[taken.length - 1] + " " + rows[taken.length], cols)
    }
    placed[i] = taken
    free -= taken.length
  })

  // "drop" last: only if something is still free.
  lines.forEach((l, i) => {
    if (l.fit !== "drop") return
    if (free <= 0) return
    placed[i] = [clip(l.text, cols)]
    free--
  })

  lines.forEach((l, i) => {
    if (l.fit === "keep") placed[i] = [l.text]
  })

  return placed.flatMap(p => p ?? [])
}
