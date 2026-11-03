/**
 * @fileoverview Getting a usable label out of a capture before any model sees it. ANI-235.
 *
 * Most bad answers about a package start as a bad photo. So before the vision
 * model is asked anything, the capture is:
 *
 *   oriented     from its EXIF orientation, so text is upright for OCR;
 *   sized        to a bounded long edge — enough for label text, no more
 *                tokens or latency than that;
 *   checked      for blur (variance of the Laplacian), glare (saturated
 *                pixels), exposure (mean and clipping) and minimum text height.
 *                A failure is a retake request naming the problem, not a guess;
 *   cropped      to label regions (ingredients, nutrition, allergens, price,
 *                product identity) found from a first OCR pass, so the second
 *                pass reads each region at full resolution;
 *   read         by an OcrEngine behind a port — the library is not chosen
 *                yet — with each line's text, box in full-image coordinates,
 *                confidence and language preserved;
 *   identified   optionally by barcode, checksum-validated, and marked
 *                untrusted: a barcode is a hint, not a catalogue entry.
 *
 * Every derivative carries the capture's consent scope and expiry (ANI-169),
 * and the original capture reference for provenance.
 *
 * OCR text is DATA. A line that reads like a UPI link or an instruction is
 * flagged and stays text: payments come only from the QR decoder path
 * (pay/upi.ts) after an explicit scan, never from label OCR.
 *
 * The thresholds below are starting values. ANI-238 calibrates them on real
 * captures from the glasses camera; they are not measured yet.
 */

import type {Region} from "./answer"

export interface GrayImage {
  width: number
  height: number
  /** One byte of luma per pixel, row-major. */
  data: Uint8Array
}

export const QUALITY_THRESHOLDS = {
  /** Variance of the 4-neighbour Laplacian below this is blurred. */
  minSharpness: 60,
  /** Fraction of pixels at or above 250 that counts as glare. */
  maxGlareFraction: 0.08,
  minMean: 45,
  maxMean: 215,
  /** Fraction at or below 5 (crushed shadows). */
  maxDarkClip: 0.35,
  /** Smallest readable text line, in pixels of the normalised image. */
  minTextHeightPx: 12,
  maxLongEdge: 1600,
} as const

export type QualityProblem = "blurred" | "glare" | "too_dark" | "too_bright" | "text_too_small"

export interface QualityReport {
  ok: boolean
  sharpness: number
  glareFraction: number
  mean: number
  darkClip: number
  problems: QualityProblem[]
}

/** EXIF orientation 1..8 as a rotation and a mirror. */
export function orientation(exif: number): {rotate: 0 | 90 | 180 | 270; mirror: boolean} {
  switch (exif) {
    case 2: return {rotate: 0, mirror: true}
    case 3: return {rotate: 180, mirror: false}
    case 4: return {rotate: 180, mirror: true}
    case 5: return {rotate: 90, mirror: true}
    case 6: return {rotate: 90, mirror: false}
    case 7: return {rotate: 270, mirror: true}
    case 8: return {rotate: 270, mirror: false}
    default: return {rotate: 0, mirror: false}
  }
}

/** Upright dimensions, then scaled so the long edge is within the bound. Never upscaled. */
export function normalisedSize(width: number, height: number, exif = 1, maxLongEdge: number = QUALITY_THRESHOLDS.maxLongEdge): {width: number; height: number; scale: number} {
  const {rotate} = orientation(exif)
  const [w, h] = rotate === 90 || rotate === 270 ? [height, width] : [width, height]
  const scale = Math.min(1, maxLongEdge / Math.max(w, h))
  return {width: Math.round(w * scale), height: Math.round(h * scale), scale}
}

export function quality(img: GrayImage, opts: {textHeightsPx?: number[]} = {}): QualityReport {
  const {width: w, height: h, data} = img
  if (data.length !== w * h || w < 3 || h < 3) throw new Error("image dimensions do not match its data")
  let sum = 0
  let glare = 0
  let dark = 0
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    sum += v
    if (v >= 250) glare++
    if (v <= 5) dark++
  }
  const n = data.length
  const mean = sum / n

  // Variance of the Laplacian over the interior: low means few sharp edges.
  let lsum = 0
  let lsq = 0
  let count = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i]
      lsum += lap
      lsq += lap * lap
      count++
    }
  }
  const lmean = lsum / count
  const sharpness = lsq / count - lmean * lmean

  const t = QUALITY_THRESHOLDS
  const problems: QualityProblem[] = []
  if (sharpness < t.minSharpness) problems.push("blurred")
  if (glare / n > t.maxGlareFraction) problems.push("glare")
  if (mean < t.minMean || dark / n > t.maxDarkClip) problems.push("too_dark")
  if (mean > t.maxMean) problems.push("too_bright")
  const heights = opts.textHeightsPx ?? []
  if (heights.length && Math.max(...heights) < t.minTextHeightPx) problems.push("text_too_small")
  return {ok: problems.length === 0, sharpness, glareFraction: glare / n, mean, darkClip: dark / n, problems}
}

/** What to tell the wearer for a failed check. */
export function retakeAdvice(problems: QualityProblem[]): string {
  const say: Record<QualityProblem, string> = {
    blurred: "hold still",
    glare: "tilt away from the light",
    too_dark: "find more light",
    too_bright: "move out of direct light",
    text_too_small: "move closer",
  }
  return problems.length ? `I can't read the label: ${problems.map(p => say[p]).join(", ")}, and try again.` : ""
}

export type LabelField = "ingredients" | "nutrition" | "allergens" | "price" | "product"

/*
 * JavaScript's \b only knows ASCII word characters, so it can never match
 * around Devanagari or the rupee sign. Those alternatives are matched
 * without it.
 */
const FIELD_WORDS: Record<LabelField, RegExp> = {
  ingredients: /\bingredients?\b|सामग्री|घटक/i,
  nutrition: /\b(nutrition(al)?|energy|kcal|protein|carbohydrate|sugars?|fat)\b|पोषण/i,
  allergens: /\b(allerg\w*|contains|may contain|traces)\b|एलर्जी/i,
  price: /\bm\.?r\.?p\b|\bprice\b|₹|\brs\.?\s?\d|मूल्य/i,
  product: /\b(net (wt|weight|qty|quantity)|brand)\b|शुद्ध/i,
}

export interface OcrLine {
  text: string
  /** In normalised [0,1] coordinates of the full image. */
  region: Region
  confidence: number
  language?: string
}

export interface Crop {
  field: LabelField | "full"
  region: Region
}

/**
 * Regions worth reading at full resolution, from a first OCR pass. Each crop
 * extends below its heading (a label's content follows its heading) with a
 * margin, is clamped to the image, and overlapping crops merge.
 */
export function planCrops(firstPass: OcrLine[], opts: {margin?: number; below?: number} = {}): Crop[] {
  const margin = opts.margin ?? 0.02
  const below = opts.below ?? 0.25
  const crops: Crop[] = []
  for (const field of Object.keys(FIELD_WORDS) as LabelField[]) {
    const hits = firstPass.filter(l => FIELD_WORDS[field].test(l.text))
    if (!hits.length) continue
    const x0 = Math.min(...hits.map(l => l.region.x)) - margin
    const y0 = Math.min(...hits.map(l => l.region.y)) - margin
    const x1 = Math.max(...hits.map(l => l.region.x + l.region.w)) + margin
    const y1 = Math.max(...hits.map(l => l.region.y + l.region.h)) + below
    crops.push({field, region: clamp({x: x0, y: y0, w: x1 - x0, h: y1 - y0})})
  }
  // Whole-image fallback when nothing was recognised, so nothing is lost to cropping.
  if (!crops.length) return [{field: "full", region: {x: 0, y: 0, w: 1, h: 1}}]
  return mergeOverlapping(crops)
}

function clamp(r: Region): Region {
  const x = Math.max(0, r.x)
  const y = Math.max(0, r.y)
  return {x, y, w: Math.min(1, r.x + r.w) - x, h: Math.min(1, r.y + r.h) - y}
}

function overlaps(a: Region, b: Region): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function mergeOverlapping(crops: Crop[]): Crop[] {
  const out = [...crops]
  for (let changed = true; changed;) {
    changed = false
    for (let i = 0; i < out.length && !changed; i++) {
      for (let j = i + 1; j < out.length && !changed; j++) {
        if (overlaps(out[i].region, out[j].region)) {
          const a = out[i].region
          const b = out[j].region
          const x = Math.min(a.x, b.x)
          const y = Math.min(a.y, b.y)
          out[i] = {field: out[i].field, region: {x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y}}
          out.splice(j, 1)
          changed = true
        }
      }
    }
  }
  return out
}

/** The OCR library, whichever is chosen. Returns lines in the crop's own normalised coordinates. */
export interface OcrEngine {
  readonly name: string
  recognize(captureRef: string, crop: Region): Promise<OcrLine[]>
}

/** Map a line from crop coordinates back to the full image. */
export function toFullImage(line: OcrLine, crop: Region): OcrLine {
  return {
    ...line,
    region: {x: crop.x + line.region.x * crop.w, y: crop.y + line.region.y * crop.h, w: line.region.w * crop.w, h: line.region.h * crop.h},
  }
}

/** GTIN-8, UPC-A (12) or EAN-13 with a valid check digit; null otherwise. */
export function validGtin(digits: string): string | null {
  if (!/^(\d{8}|\d{12}|\d{13})$/.test(digits)) return null
  const d = [...digits].map(Number)
  const check = d.pop()!
  const sum = d.reverse().reduce((s, v, i) => s + v * (i % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10 === check ? digits : null
}

const PAYMENT_LIKE = /upi:\/\/|\bpa=|\bpay (?:now|to)\b|\bscan to pay\b/i

export interface PreparedCapture {
  captureRef: string
  /** The original, untouched capture, for provenance. */
  originalRef: string
  scopeId: string
  expiresAt: number
  size: {width: number; height: number}
  quality: QualityReport
  lines: (OcrLine & {field: Crop["field"]; paymentLike: boolean})[]
  barcode?: {gtin: string; trusted: false}
  ocrEngine: string
}

/**
 * The second OCR pass over planned crops. Returns a retake request instead
 * of text when the image fails its checks.
 */
export async function prepare(input: {
  captureRef: string
  originalRef: string
  scopeId: string
  expiresAt: number
  now: number
  image: GrayImage
  exif?: number
  firstPass: OcrLine[]
  barcodeDigits?: string
  ocr: OcrEngine
}): Promise<{ok: true; capture: PreparedCapture} | {ok: false; reason: "expired" | "quality"; advice: string; quality?: QualityReport}> {
  if (input.expiresAt <= input.now) return {ok: false, reason: "expired", advice: "That picture has expired. Take a new one."}
  const size = normalisedSize(input.image.width, input.image.height, input.exif)
  const heights = input.firstPass.map(l => l.region.h * size.height)
  const q = quality(input.image, {textHeightsPx: heights})
  if (!q.ok) return {ok: false, reason: "quality", advice: retakeAdvice(q.problems), quality: q}

  const lines: PreparedCapture["lines"] = []
  for (const crop of planCrops(input.firstPass)) {
    for (const l of await input.ocr.recognize(input.captureRef, crop.region)) {
      const full = toFullImage(l, crop.region)
      lines.push({...full, field: crop.field, paymentLike: PAYMENT_LIKE.test(full.text)})
    }
  }
  const gtin = input.barcodeDigits ? validGtin(input.barcodeDigits) : null
  return {
    ok: true,
    capture: {
      captureRef: input.captureRef,
      originalRef: input.originalRef,
      scopeId: input.scopeId,
      expiresAt: input.expiresAt,
      size: {width: size.width, height: size.height},
      quality: q,
      lines,
      barcode: gtin ? {gtin, trusted: false} : undefined,
      ocrEngine: input.ocr.name,
    },
  }
}
