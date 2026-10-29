/**
 * @fileoverview Panel geometry — what a card has to fit inside.
 *
 * Geometry is DERIVED from three numbers (pixel size, cell size, usable rows)
 * rather than hardcoded per card, because the two targets differ by 5x in
 * pixels and the cards have to be written once.
 *
 * On the safe area: it is a property of the OPTICS, not of the pixel count.
 * The dev-board OLED is a bench panel on a desk with no optics in front of it,
 * so every row is usable and the only constraint is that text fits. The
 * waveguide HUD lands a virtual image in the wearer's field of view, and there
 * the centre of that image must stay clear — a card over the centre of vision
 * is the one failure mode that makes a HUD dangerous rather than merely
 * annoying. So TARGET_HUD splits its rows into a top band for content and a
 * bottom strip for status, with the middle left empty.
 *
 * ESTIMATE, not measurement: the TARGET_HUD cell size below is scaled from the
 * stand-in font by pixel ratio to hold roughly the same apparent text size.
 * No optical engine exists yet, so the angular subtense is unverified. Once
 * there is a waveguide on a face, the cell size is measured and this constant
 * changes; nothing else should need to.
 */

export type PanelPreset = "STANDIN_OLED" | "TARGET_HUD"

/** A horizontal band of rows that cards may occupy. */
export interface Band {
  /** First row index, 0 = top text row. */
  row: number
  /** How many rows the band holds. */
  rows: number
}

export interface PanelProfile {
  preset: PanelPreset
  /** Panel pixels. Matches CUSTOM_GLASSES_RESOLUTIONS in the phone profile. */
  width: number
  height: number
  /** Character cell in pixels. The firmware font is 6x10 (font6x10.h). */
  cellW: number
  cellH: number
  /** Characters per text row. */
  cols: number
  /** Text rows the panel holds in total. */
  rows: number
  /** Where card content goes. */
  content: Band
  /** A single row for state ("Listening", battery), or null when there is no room. */
  status: Band | null
  /**
   * Rows deliberately left empty because they fall over the centre of vision.
   * Empty on a bench panel. Cards are never laid out here.
   */
  keepClear: Band | null
}

function profile(p: {
  preset: PanelPreset
  width: number
  height: number
  cellW: number
  cellH: number
  content: Band
  status: Band | null
  keepClear: Band | null
}): PanelProfile {
  return {
    ...p,
    cols: Math.floor(p.width / p.cellW),
    rows: Math.floor(p.height / p.cellH),
  }
}

/**
 * 128x64 SSD1306-class OLED on the nRF5340 dev board, 6x10 font.
 * 21 cols x 6 rows. The phone's capability profile caps text at 4 lines, so
 * content is 4 rows and the last row carries state.
 */
export const STANDIN_OLED: PanelProfile = profile({
  preset: "STANDIN_OLED",
  width: 128,
  height: 64,
  cellW: 6,
  cellH: 10,
  content: {row: 0, rows: 4},
  status: {row: 5, rows: 1},
  keepClear: null,
})

/**
 * 640x480 waveguide HUD, font scaled 4x to 24x40 to hold apparent size.
 * 26 cols x 12 rows. Content sits in the top 5 rows (matching the profile's
 * maxTextLines), rows 5-9 are left clear of the centre of vision, and the
 * bottom row carries state.
 */
export const TARGET_HUD: PanelProfile = profile({
  preset: "TARGET_HUD",
  width: 640,
  height: 480,
  cellW: 24,
  cellH: 40,
  content: {row: 0, rows: 5},
  status: {row: 11, rows: 1},
  keepClear: {row: 5, rows: 5},
})

export const PANELS: Record<PanelPreset, PanelProfile> = {STANDIN_OLED, TARGET_HUD}

/** Rows a card may write to, in order. Never includes the keep-clear band. */
export function contentRows(p: PanelProfile): number[] {
  const rows: number[] = []
  for (let i = 0; i < p.content.rows; i++) rows.push(p.content.row + i)
  return rows
}
