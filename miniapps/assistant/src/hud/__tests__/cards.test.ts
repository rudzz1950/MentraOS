import {describe, expect, it} from "bun:test"

import * as card from "../cards"
import {contentRows, PANELS, STANDIN_OLED, TARGET_HUD} from "../panel"
import {CardTooBigError, clip, layout, wrap, type CardLine} from "../text"

const oled = {panel: STANDIN_OLED}
const hud = {panel: TARGET_HUD}
const everyPanel = Object.values(PANELS).map(p => [p.preset, {panel: p}] as const)

describe("panel geometry", () => {
  it("derives columns and rows from pixels and cell size", () => {
    expect(STANDIN_OLED.cols).toBe(21) // 128 / 6
    expect(STANDIN_OLED.rows).toBe(6) // 64 / 10
    expect(TARGET_HUD.cols).toBe(26) // 640 / 24
    expect(TARGET_HUD.rows).toBe(12) // 480 / 40
  })

  it("keeps the centre of the HUD clear and the bench panel fully usable", () => {
    expect(STANDIN_OLED.keepClear).toBeNull()
    expect(TARGET_HUD.keepClear).toEqual({row: 5, rows: 5})
  })

  it("never lays content into the keep-clear band", () => {
    for (const [, ctx] of everyPanel) {
      const p = ctx.panel
      if (!p.keepClear) continue
      const clear = new Set<number>()
      for (let i = 0; i < p.keepClear.rows; i++) clear.add(p.keepClear.row + i)
      for (const row of contentRows(p)) expect(clear.has(row)).toBe(false)
    }
  })

  it("keeps every band inside the panel", () => {
    for (const [, ctx] of everyPanel) {
      const p = ctx.panel
      for (const band of [p.content, p.status, p.keepClear]) {
        if (!band) continue
        expect(band.row).toBeGreaterThanOrEqual(0)
        expect(band.row + band.rows).toBeLessThanOrEqual(p.rows)
      }
    }
  })

  it("does not overlap content with status", () => {
    for (const [, ctx] of everyPanel) {
      const p = ctx.panel
      if (!p.status) continue
      expect(p.content.row + p.content.rows).toBeLessThanOrEqual(p.status.row)
    }
  })
})

describe("clip and wrap", () => {
  it("leaves short text alone", () => {
    expect(clip("hello", 21)).toBe("hello")
  })

  it("marks a clip with an ellipsis so the reader sees the cut", () => {
    expect(clip("abcdefghij", 5)).toBe("abcd…")
  })

  it("wraps on words", () => {
    expect(wrap("the quick brown fox", 10)).toEqual(["the quick", "brown fox"])
  })

  it("hard-splits a word longer than the row rather than losing it", () => {
    expect(wrap("supercalifragilistic", 8)).toEqual(["supercal", "ifragili", "stic"])
    expect(wrap("hi supercalifragilistic", 8).join("")).toContain("stic")
  })

  it("survives empty and whitespace-only text", () => {
    expect(wrap("", 10)).toEqual([])
    expect(wrap("   \t ", 10)).toEqual([])
  })
})

describe("layout budget", () => {
  it("never drops a keep line, whatever else is competing", () => {
    const lines: CardLine[] = [
      {text: "x".repeat(200), fit: "wrap"},
      {text: "must survive", fit: "keep"},
    ]
    const rows = layout(lines, STANDIN_OLED)
    expect(rows).toContain("must survive")
    expect(rows.length).toBeLessThanOrEqual(STANDIN_OLED.content.rows)
  })

  it("refuses a keep line that cannot fit, rather than truncating it silently", () => {
    expect(() => layout([{text: "y".repeat(40), fit: "keep"}], STANDIN_OLED)).toThrow(CardTooBigError)
  })

  it("refuses more keep lines than there are rows", () => {
    const lines: CardLine[] = Array.from({length: 9}, () => ({text: "ok", fit: "keep" as const}))
    expect(() => layout(lines, STANDIN_OLED)).toThrow(CardTooBigError)
  })

  it("drops drop lines before touching wrap lines", () => {
    const lines: CardLine[] = [
      {text: "one two three four five six seven eight nine ten eleven twelve thirteen", fit: "wrap"},
      {text: "optional", fit: "drop"},
    ]
    expect(layout(lines, STANDIN_OLED)).not.toContain("optional")
  })

  it("keeps a drop line when there is room", () => {
    expect(layout([{text: "short", fit: "wrap"}, {text: "optional", fit: "drop"}], STANDIN_OLED)).toContain("optional")
  })

  it("marks a cut wrap block so a truncated answer never reads as complete", () => {
    const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november"
    const rows = layout([{text: long, fit: "wrap"}], STANDIN_OLED)
    expect(rows.length).toBe(STANDIN_OLED.content.rows)
    expect(rows[rows.length - 1]).toContain("…")
  })

  it("never exceeds the row budget or the column width", () => {
    const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike"
    for (const [, ctx] of everyPanel) {
      const rows = layout(
        [{text: long, fit: "wrap"}, {text: "Say send to confirm", fit: "keep"}],
        ctx.panel,
      )
      expect(rows.length).toBeLessThanOrEqual(ctx.panel.content.rows)
      for (const r of rows) expect(r.length).toBeLessThanOrEqual(ctx.panel.cols)
    }
  })
})

describe("every card fits every panel", () => {
  const build = (ctx: {panel: typeof STANDIN_OLED}) => [
    card.listening("what is the weather like this afternoon in bengaluru", ctx),
    card.thinking(ctx),
    card.answer("Twenty-eight degrees and overcast, with rain likely after four.", ctx),
    card.confirm("send_message: tell amma I will be late for dinner tonight", ctx),
    card.noted(ctx),
    card.error("Can't reach the assistant right now.", ctx),
    card.call("Anirudh Bharadwaj", ctx),
    card.message("Amma", "Are you coming home for dinner or should I keep it aside?", ctx),
    card.navigation("In 200 m", "Turn right onto Hosur Road", ctx),
    card.reminder("4:30 PM", "Standup with the firmware team", ctx),
    card.home("4:12 PM", "72%", ctx),
  ]

  for (const [name, ctx] of everyPanel) {
    it(`fits on ${name}`, () => {
      for (const c of build(ctx)) {
        expect(c.rows.length).toBeLessThanOrEqual(ctx.panel.content.rows)
        for (const row of c.rows) expect(row.length).toBeLessThanOrEqual(ctx.panel.cols)
        for (const row of c.drivingRows ?? []) expect(row.length).toBeLessThanOrEqual(ctx.panel.cols)
      }
    })

    it(`renders something on ${name} — no card is blank`, () => {
      for (const c of build(ctx)) {
        expect(c.rows.join("").trim().length).toBeGreaterThan(0)
      }
    })
  }
})

describe("the confirmation card", () => {
  it("always shows the ask, even when the summary is long", () => {
    const long = card.confirm("send_message: " + "x".repeat(300), oled)
    expect(long.rows).toContain("Say send to confirm")
  })

  it("shortens the summary rather than the ask", () => {
    const c = card.confirm("send_message: tell amma I will be late tonight", oled)
    expect(c.rows[0]).toContain("…")
    expect(c.rows[c.rows.length - 1]).toBe("Say send to confirm")
  })

  it("holds until answered", () => {
    expect(card.confirm("x", oled).ttlMs).toBeNull()
  })
})

describe("driving policy", () => {
  it("suppresses the assistant's own cards", () => {
    for (const c of [
      card.answer("long answer", oled),
      card.thinking(oled),
      card.listening("partial", oled),
      card.confirm("send_message: hi", oled),
      card.noted(oled),
    ]) {
      expect(card.gate(c, true)).toBeNull()
    }
  })

  it("shows navigation and calls unchanged", () => {
    const nav = card.navigation("In 200 m", "Turn right onto Hosur Road", oled)
    expect(card.gate(nav, true)?.rows).toEqual(nav.rows)
    const ring = card.call("Amma", oled)
    expect(card.gate(ring, true)?.rows).toEqual(ring.rows)
  })

  it("strips the message body but keeps the sender", () => {
    const m = card.message("Amma", "Are you coming home for dinner tonight?", oled)
    const driving = card.gate(m, true)!
    expect(driving.rows).toContain("Amma")
    expect(driving.rows.join(" ")).not.toContain("dinner")
    expect(driving.rows.join(" ")).toContain("Message")
  })

  it("strips the reminder text but keeps the time", () => {
    const r = card.reminder("4:30 PM", "Standup with the firmware team", oled)
    const driving = card.gate(r, true)!
    expect(driving.rows).toContain("4:30 PM")
    expect(driving.rows.join(" ")).not.toContain("firmware")
  })

  it("shows everything when not driving", () => {
    const m = card.message("Amma", "Dinner?", oled)
    expect(card.gate(m, false)!.rows.join(" ")).toContain("Dinner?")
  })

  it("gives every card a driving behaviour and a reduced form when it claims one", () => {
    for (const [, ctx] of everyPanel) {
      const all = [
        card.listening("p", ctx),
        card.thinking(ctx),
        card.answer("a", ctx),
        card.confirm("s", ctx),
        card.noted(ctx),
        card.error("e", ctx),
        card.call("c", ctx),
        card.message("s", "b", ctx),
        card.navigation("d", "i", ctx),
        card.reminder("w", "x", ctx),
        card.home("t", "b", ctx),
      ]
      for (const c of all) {
        expect(["full", "reduced", "suppressed"]).toContain(c.driving)
        if (c.driving === "reduced") expect(c.drivingRows).toBeDefined()
      }
    }
  })
})

describe("priority", () => {
  it("ranks a call over navigation over an answer", () => {
    expect(card.PRIORITY.call).toBeGreaterThan(card.PRIORITY.navigation)
    expect(card.PRIORITY.navigation).toBeGreaterThan(card.PRIORITY.answer)
  })

  it("puts the home screen at the bottom so anything replaces it", () => {
    for (const kind of Object.keys(card.PRIORITY) as card.CardKind[]) {
      if (kind !== "home") expect(card.PRIORITY[kind]).toBeGreaterThan(card.PRIORITY.home)
    }
  })

  it("gives a confirmation more weight than the answer it follows", () => {
    expect(card.PRIORITY.confirm).toBeGreaterThan(card.PRIORITY.answer)
  })
})

describe("timing", () => {
  it("holds the states that are live and expires the rest", () => {
    expect(card.listening("x", oled).ttlMs).toBeNull()
    expect(card.thinking(oled).ttlMs).toBeNull()
    expect(card.navigation("d", "i", oled).ttlMs).toBeNull()
    expect(card.home("t", "b", oled).ttlMs).toBeNull()
    expect(card.answer("a", oled).ttlMs).toBeGreaterThan(0)
    expect(card.message("s", "b", oled).ttlMs).toBeGreaterThan(0)
    expect(card.reminder("w", "x", oled).ttlMs).toBeGreaterThan(0)
    expect(card.noted(oled).ttlMs).toBeGreaterThan(0)
  })

  it("holds a note long enough to read and no longer", () => {
    const ttl = card.noted(oled).ttlMs!
    expect(ttl).toBeGreaterThanOrEqual(1500)
    expect(ttl).toBeLessThanOrEqual(3000)
  })
})

describe("the larger panel earns its pixels", () => {
  it("shows more of a long answer than the stand-in does", () => {
    const text = "Twenty-eight degrees and overcast in Bengaluru, with rain likely after four this afternoon."
    const small = card.answer(text, oled).rows.join(" ").length
    const large = card.answer(text, hud).rows.join(" ").length
    expect(large).toBeGreaterThan(small)
  })

  it("shows the whole message body where the stand-in cuts it", () => {
    const body = "Are you coming home for dinner tonight or should I keep it aside?"
    expect(card.message("Amma", body, hud).rows.join(" ")).toContain("aside")
    expect(card.message("Amma", body, oled).rows.join(" ")).not.toContain("aside")
  })
})
