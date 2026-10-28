import {DisplayProfile} from "./types"

/**
 * Custom Glasses display profile (Sprint 1 stand-in OLED).
 *
 * The firmware renders a fixed-width 6 px font (5x7 glyph + 1 px gap) at a
 * 16 px line pitch on a 128x64 panel: 21 characters x 4 lines. Only printable
 * ASCII is guaranteed; the firmware draws '?' for anything else, so every
 * script is measured at the same 6 px advance.
 */
export const CUSTOM_GLYPH_WIDTH_PX = 6

export const CUSTOM_PROFILE: DisplayProfile = {
  id: "custom-glasses",
  name: "Custom Glasses",

  displayWidthPx: 126, // 21 glyphs x 6 px; 2 px right margin on the 128 px panel
  displayHeightPx: 64,
  maxLines: 4,
  lineHeightPx: 16,

  // Must not exceed the firmware's DisplayText.text buffer (LINK_CONTRACT v0: 240 bytes).
  maxPayloadBytes: 240,
  // Worst case ATT payload at the default MTU of 23 (20 bytes) minus the 4-byte header.
  bleChunkSize: 16,

  fontMetrics: {
    glyphWidths: new Map<string, number>(),
    defaultGlyphWidth: CUSTOM_GLYPH_WIDTH_PX,
    renderFormula: (glyphWidth: number) => glyphWidth,
    uniformScripts: {
      cjk: CUSTOM_GLYPH_WIDTH_PX,
      hiragana: CUSTOM_GLYPH_WIDTH_PX,
      katakana: CUSTOM_GLYPH_WIDTH_PX,
      korean: CUSTOM_GLYPH_WIDTH_PX,
      cyrillic: CUSTOM_GLYPH_WIDTH_PX,
    },
    fallback: {
      latinMaxWidth: CUSTOM_GLYPH_WIDTH_PX,
      unknownBehavior: "useLatinMax",
    },
  },

  constraints: {
    minCharsBeforeHyphen: 3,
    noStartChars: [".", ",", "!", "?", ":", ";", ")", "]", "}"],
    noEndChars: ["(", "[", "{"],
  },
}

export const CUSTOM_HYPHEN_WIDTH_PX = CUSTOM_GLYPH_WIDTH_PX
export const CUSTOM_SPACE_WIDTH_PX = CUSTOM_GLYPH_WIDTH_PX
