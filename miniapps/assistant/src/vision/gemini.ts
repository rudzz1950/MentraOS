/**
 * @fileoverview Gemini as one implementation of the VisionModel port. ANI-234.
 *
 * Three constraints shape this file:
 *
 *   NO KEY IN THE APP. The request goes to OUR backend (or an approved
 *   Firebase AI Logic path), which holds the Gemini credential and forwards
 *   the call. The phone sends a short-lived token the host fetches for each
 *   request. The config refuses anything that looks like an embedded Google
 *   API key, so one cannot be shipped by pasting it into a settings file.
 *
 *   NOTHING GEMINI-SHAPED LEAKS OUT. The wire format (generateContent with an
 *   inline image and a JSON response schema) lives here. Callers see the
 *   VisionModel port and VisionUnavailableError, nothing else.
 *
 *   BOUNDED, CANCELLABLE AND QUIET. A timeout per attempt, a small number of
 *   retries on 429 and 5xx only, honouring Retry-After, a per-session rate
 *   limit, and cancellation through the caller's signal. Telemetry reports
 *   request id, model, status, latency, attempts and image size — never the
 *   image, the question or the answer.
 */

import type {Locality} from "../agent/egress"
import {VisionUnavailableError, type VisionModel, type VisionRequest} from "./ports"

export interface GeminiConfig {
  name?: string
  /**
   * Our proxy's base URL. The adapter calls
   * `${baseUrl}/v1beta/models/${model}:generateContent`, which the backend
   * forwards to Gemini or to a customer-managed Vertex AI deployment.
   */
  baseUrl: string
  model: string
  /** Where the endpoint runs; a hosted Gemini is "cloud". */
  locality?: Locality
  temperature?: number
  maxOutputTokens?: number
  /** The JSON Schema the answer must fit (structured output). */
  responseSchema?: object
  /** Passed through to the backend unchanged. */
  safetySettings?: {category: string; threshold: string}[]
  timeoutMs?: number
  /** Retries after the first attempt, on 429 and 5xx only. */
  maxRetries?: number
  /** Requests per rolling minute from this session. */
  maxPerMinute?: number
}

export interface GeminiDeps {
  /** A short-lived, scoped token for one request. Never a permanent key. */
  token: () => Promise<string>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  telemetry?: (t: {requestId: string; model: string; status: string; latencyMs: number; attempts: number; imageBytes: number}) => void
}

/** A Google API key begins "AIza" and is 39 characters. It belongs on a server. */
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{35}/

function base64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function createGeminiVision(cfg: GeminiConfig, deps: GeminiDeps): VisionModel {
  if (GOOGLE_KEY.test(JSON.stringify(cfg)) || /[?&]key=/i.test(cfg.baseUrl)) {
    throw new Error("A Gemini API key must not be configured in the app. Route through the backend with a short-lived token.")
  }
  if (!/^https:\/\//i.test(cfg.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(cfg.baseUrl)) {
    throw new Error("The vision backend must be HTTPS.")
  }
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const timeoutMs = cfg.timeoutMs ?? 8000
  const maxRetries = cfg.maxRetries ?? 2
  const maxPerMinute = cfg.maxPerMinute ?? 10
  const recent: number[] = []
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`

  return {
    name: cfg.name ?? `gemini:${cfg.model}`,
    locality: cfg.locality ?? "cloud",

    async ask(req: VisionRequest, signal?: AbortSignal): Promise<unknown> {
      const started = now()
      while (recent.length && started - recent[0] > 60_000) recent.shift()
      if (recent.length >= maxPerMinute) throw new VisionUnavailableError("quota", "per-session limit reached")
      recent.push(started)

      const body = JSON.stringify({
        contents: [{
          role: "user",
          parts: [{text: req.prompt}, {inlineData: {mimeType: req.image.mimeType, data: base64(req.image.bytes)}}],
        }],
        generationConfig: {
          responseMimeType: "application/json",
          ...(cfg.responseSchema ? {responseSchema: cfg.responseSchema} : {}),
          ...(cfg.temperature !== undefined ? {temperature: cfg.temperature} : {}),
          ...(cfg.maxOutputTokens !== undefined ? {maxOutputTokens: cfg.maxOutputTokens} : {}),
        },
        ...(cfg.safetySettings ? {safetySettings: cfg.safetySettings} : {}),
      })

      let attempts = 0
      const report = (status: string) =>
        deps.telemetry?.({requestId: req.requestId, model: cfg.model, status, latencyMs: now() - started, attempts, imageBytes: req.image.bytes.length})

      while (true) {
        attempts++
        if (signal?.aborted) {
          report("cancelled")
          throw new DOMException("cancelled", "AbortError")
        }
        const ctrl = new AbortController()
        const relay = () => ctrl.abort()
        signal?.addEventListener("abort", relay, {once: true})
        const timer = setTimeout(() => ctrl.abort(), timeoutMs)
        let res: Response
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${await deps.token()}`,
              "x-request-id": req.requestId,
            },
            body,
            signal: ctrl.signal,
          })
        } catch (e) {
          if (signal?.aborted) {
            report("cancelled")
            throw new DOMException("cancelled", "AbortError")
          }
          if (attempts <= maxRetries) continue
          report("timeout")
          throw new VisionUnavailableError("timeout", e instanceof Error ? e.message : String(e))
        } finally {
          clearTimeout(timer)
          signal?.removeEventListener("abort", relay)
        }

        if (res.status === 429 || res.status >= 500) {
          if (attempts <= maxRetries) {
            const ra = Number(res.headers.get("retry-after"))
            await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 250 * 2 ** (attempts - 1))
            continue
          }
          report(`http_${res.status}`)
          throw new VisionUnavailableError(res.status === 429 ? "rate_limited" : "unavailable", `HTTP ${res.status}`)
        }
        if (!res.ok) {
          report(`http_${res.status}`)
          throw new VisionUnavailableError("unavailable", `HTTP ${res.status}`)
        }

        let json: {
          candidates?: {finishReason?: string; content?: {parts?: {text?: string}[]}}[]
          promptFeedback?: {blockReason?: string}
        }
        try {
          json = await res.json()
        } catch {
          report("bad_response")
          throw new VisionUnavailableError("bad_response", "not JSON")
        }
        if (json.promptFeedback?.blockReason) {
          report("blocked")
          throw new VisionUnavailableError("blocked", json.promptFeedback.blockReason)
        }
        const cand = json.candidates?.[0]
        if (cand?.finishReason === "SAFETY") {
          report("blocked")
          throw new VisionUnavailableError("blocked", "SAFETY")
        }
        const text = (cand?.content?.parts ?? []).map(p => p.text ?? "").join("")
        try {
          const out = JSON.parse(text)
          report("ok")
          return out
        } catch {
          report("bad_response")
          throw new VisionUnavailableError("bad_response", "answer was not JSON")
        }
      }
    },
  }
}
