/**
 * @fileoverview Building the model tiers from configuration.
 *
 * `ModelRouter` already took a list of `ModelClient`s, which was most of the
 * work. What was missing is that nothing stopped a caller constructing those
 * clients against a hardcoded vendor — and that one line is what would close
 * off on-premise deployment entirely.
 *
 * ADR-003's sharpest consequence: if heavy queries require OUR cloud, the
 * product is not on-premise deployable. It is on-premise deployable with a
 * hole in it, and the hole is the capability the Track A buyer is paying for.
 *
 * Three answers exist — a site GPU, explicit degradation, or a
 * customer-supplied endpoint — and none of them need deciding now. What needs
 * doing now is keeping the third available, which costs a config field today
 * and a migration later.
 *
 * So every tier is described by configuration, and the transport is the
 * OpenAI-compatible chat-completions shape. That is not an endorsement of a
 * vendor; it is the de-facto wire format that vLLM, llama.cpp's server, Ollama
 * and the hosted providers all speak, which means a plant already running
 * something can be pointed at it with no code change.
 *
 * ABSENT IS NOT THE SAME AS FAILED. A deployment with no heavy tier configured
 * is a deliberate choice, and the wearer should be told the capability is not
 * part of this install. A heavy tier that is configured and unreachable is a
 * fault, and the wearer should be told to try again. Collapsing those two into
 * one "something went wrong" is how an on-premise install looks broken when it
 * is working exactly as specified.
 */

import type {ModelClient} from "./ports"

export interface ModelTierConfig {
  /** Reported as `via` on an answer, so the "why" view can show which tier. */
  name: string
  /** Base URL of an OpenAI-compatible server. No trailing slash required. */
  baseUrl: string
  /** Model identifier as that server names it. */
  model: string
  /** Per-tier timeout. The router's own default applies when absent. */
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
  /**
   * Which tier this is. Only `heavy` is treated specially, because it is the
   * one whose absence is a deployment decision rather than a fault.
   */
  role?: "small" | "heavy"
  /**
   * Where the endpoint runs, which bounds what it may be shown (egress.ts).
   * Left out, it is treated as "cloud" — an endpoint nobody described is
   * assumed to be the farthest one, because the opposite default is how a
   * leak gets configured. A plant's own server should say "site"; a model on
   * the phone or puck should say "device".
   */
  locality?: "device" | "site" | "cloud"
}

export interface AssistantModelConfig {
  /** Smallest first. The router tries them in order. */
  tiers: ModelTierConfig[]
}

/**
 * How a key reaches a client: a callback the host supplies, never a value read
 * from the repository or the config file. A self-hosted endpoint inside a plant
 * usually needs none at all, which is why this is optional rather than
 * required.
 */
export type ApiKeyProvider = (tier: ModelTierConfig) => Promise<string | null>

export class TierNotConfiguredError extends Error {
  constructor(readonly role: string) {
    super(`No ${role} model tier is configured in this deployment.`)
    this.name = "TierNotConfiguredError"
  }
}

/**
 * A client for any OpenAI-compatible chat-completions endpoint, streaming.
 *
 * Deliberately built on `fetch` and hand-parsed SSE rather than a vendor SDK:
 * the miniapp sandbox allows fetch over http/https, a vendor SDK would pull a
 * dependency that only speaks to that vendor, and ADR-001's rule about keeping
 * the transport behind a port applies here for the same reason.
 */
export function createOpenAICompatibleClient(
  tier: ModelTierConfig,
  opts: {fetchImpl?: typeof fetch; apiKey?: ApiKeyProvider} = {},
): ModelClient {
  const doFetch = opts.fetchImpl ?? fetch
  const base = tier.baseUrl.replace(/\/+$/, "")

  return {
    name: tier.name,
    locality: tier.locality ?? "cloud",
    async *complete(prompt: string, signal: AbortSignal): AsyncIterable<string> {
      const headers: Record<string, string> = {"content-type": "application/json"}
      const key = opts.apiKey ? await opts.apiKey(tier) : null
      if (key) headers.authorization = `Bearer ${key}`

      const res = await doFetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model: tier.model,
          stream: true,
          messages: [{role: "user", content: prompt}],
          ...(tier.maxTokens !== undefined ? {max_tokens: tier.maxTokens} : {}),
          ...(tier.temperature !== undefined ? {temperature: tier.temperature} : {}),
        }),
      })

      if (!res.ok || !res.body) {
        // The status is included because a 401 from a plant's own gateway and a
        // 503 from a cold model server need different responses from whoever
        // is holding the logs.
        throw new Error(`${tier.name}: HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ""

      while (true) {
        const {done, value} = await reader.read()
        if (done) break
        buffered += decoder.decode(value, {stream: true})

        // SSE frames are separated by a blank line, and a chunk boundary can
        // land mid-frame, so only complete frames are consumed.
        let cut = buffered.indexOf("\n\n")
        while (cut !== -1) {
          const frame = buffered.slice(0, cut)
          buffered = buffered.slice(cut + 2)
          const text = parseSseFrame(frame)
          if (text === DONE) return
          if (text) yield text
          cut = buffered.indexOf("\n\n")
        }
      }
    },
  }
}

const DONE = Symbol("sse-done")

/** Pull the delta text out of one SSE frame, or DONE, or null for anything else. */
function parseSseFrame(frame: string): string | typeof DONE | null {
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload === "[DONE]") return DONE
    if (!payload) continue
    try {
      const json = JSON.parse(payload)
      const delta = json?.choices?.[0]?.delta?.content
      if (typeof delta === "string" && delta.length > 0) return delta
    } catch {
      // A malformed frame is skipped rather than failing the stream: a proxy
      // injecting a keep-alive comment should not end an answer.
      continue
    }
  }
  return null
}

/**
 * Build the clients a router needs from configuration.
 *
 * Throws when there are no tiers at all, because an assistant with no model
 * and no explanation is worse than one that refuses to start.
 */
export function buildTiers(
  config: AssistantModelConfig,
  opts: {fetchImpl?: typeof fetch; apiKey?: ApiKeyProvider} = {},
): {clients: ModelClient[]; hasHeavyTier: boolean} {
  if (config.tiers.length === 0) {
    throw new Error("No model tiers configured. At least one is required.")
  }
  return {
    clients: config.tiers.map(t => createOpenAICompatibleClient(t, opts)),
    hasHeavyTier: config.tiers.some(t => t.role === "heavy"),
  }
}

/**
 * What to tell the wearer when nothing answered.
 *
 * Two different sentences on purpose. "Not part of this install" is a true
 * statement about a deliberate deployment choice and invites no retry;
 * "can't reach" is a fault and invites one. An on-premise site with no GPU
 * should never see the second.
 */
export function unavailableMessage(hasHeavyTier: boolean): string {
  return hasHeavyTier
    ? "Can't reach the assistant right now."
    : "Detailed answers aren't set up on this device."
}
