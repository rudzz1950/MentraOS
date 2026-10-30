import {describe, expect, test} from "bun:test"

import {
  buildTiers,
  createOpenAICompatibleClient,
  unavailableMessage,
  type ModelTierConfig,
} from "../providers"

const tier = (over: Partial<ModelTierConfig> = {}): ModelTierConfig => ({
  name: "small",
  baseUrl: "http://localhost:8000",
  model: "qwen2.5-1.5b-instruct",
  ...over,
})

/** An SSE body built from deltas, framed the way a real server frames them. */
function sseBody(deltas: string[], opts: {done?: boolean; split?: boolean} = {}): ReadableStream {
  const frames = deltas.map(
    d => `data: ${JSON.stringify({choices: [{delta: {content: d}}]})}\n\n`,
  )
  if (opts.done !== false) frames.push("data: [DONE]\n\n")
  const text = frames.join("")
  const bytes = new TextEncoder().encode(text)

  return new ReadableStream({
    start(c) {
      if (opts.split) {
        // Cut the stream mid-frame, which is what actually happens on a real
        // connection and is where a naive line parser breaks.
        const mid = Math.floor(bytes.length / 2)
        c.enqueue(bytes.slice(0, mid))
        c.enqueue(bytes.slice(mid))
      } else {
        c.enqueue(bytes)
      }
      c.close()
    },
  })
}

function fakeFetch(
  body: ReadableStream | null,
  opts: {status?: number; capture?: (url: string, init: RequestInit) => void} = {},
) {
  return (async (url: string, init: RequestInit) => {
    opts.capture?.(url, init)
    return {ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, body} as unknown as Response
  }) as unknown as typeof fetch
}

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = ""
  for await (const c of it) out += c
  return out
}

describe("talking to an OpenAI-compatible endpoint", () => {
  test("streams the deltas", async () => {
    const c = createOpenAICompatibleClient(tier(), {fetchImpl: fakeFetch(sseBody(["Twenty", "-eight", " degrees"]))})
    expect(await collect(c.complete("q", new AbortController().signal))).toBe("Twenty-eight degrees")
  })

  test("survives a chunk boundary mid-frame", async () => {
    const c = createOpenAICompatibleClient(tier(), {
      fetchImpl: fakeFetch(sseBody(["alpha ", "bravo ", "charlie"], {split: true})),
    })
    expect(await collect(c.complete("q", new AbortController().signal))).toBe("alpha bravo charlie")
  })

  test("stops at [DONE] rather than waiting for the socket", async () => {
    const c = createOpenAICompatibleClient(tier(), {fetchImpl: fakeFetch(sseBody(["one"]))})
    expect(await collect(c.complete("q", new AbortController().signal))).toBe("one")
  })

  test("a malformed frame is skipped, not fatal", async () => {
    // A proxy injecting a keep-alive should not end an answer.
    const text = [
      'data: {"choices":[{"delta":{"content":"good"}}]}\n\n',
      "data: not-json\n\n",
      ": keep-alive\n\n",
      'data: {"choices":[{"delta":{"content":" more"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("")
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    })
    const c = createOpenAICompatibleClient(tier(), {fetchImpl: fakeFetch(body)})
    expect(await collect(c.complete("q", new AbortController().signal))).toBe("good more")
  })

  test("an HTTP error carries the status, because 401 and 503 need different responses", async () => {
    const c = createOpenAICompatibleClient(tier(), {fetchImpl: fakeFetch(null, {status: 401})})
    await expect(collect(c.complete("q", new AbortController().signal))).rejects.toThrow(/401/)
  })

  test("the endpoint and model come from config, not from code", async () => {
    let seenUrl = ""
    let seenBody: Record<string, unknown> = {}
    const c = createOpenAICompatibleClient(
      tier({baseUrl: "https://llm.plant.internal/", model: "llama-3.2-3b"}),
      {
        fetchImpl: fakeFetch(sseBody(["x"]), {
          capture: (url, init) => {
            seenUrl = url
            seenBody = JSON.parse(init.body as string)
          },
        }),
      },
    )
    await collect(c.complete("q", new AbortController().signal))
    // Trailing slash in config must not produce a double slash.
    expect(seenUrl).toBe("https://llm.plant.internal/v1/chat/completions")
    expect(seenBody.model).toBe("llama-3.2-3b")
    expect(seenBody.stream).toBe(true)
  })

  test("no auth header when the host supplies no key", async () => {
    // A self-hosted endpoint inside a plant usually needs none.
    let headers: Record<string, string> = {}
    const c = createOpenAICompatibleClient(tier(), {
      fetchImpl: fakeFetch(sseBody(["x"]), {
        capture: (_u, init) => {
          headers = init.headers as Record<string, string>
        },
      }),
    })
    await collect(c.complete("q", new AbortController().signal))
    expect(headers.authorization).toBeUndefined()
  })

  test("the key comes from a host callback, never from config", async () => {
    let headers: Record<string, string> = {}
    const c = createOpenAICompatibleClient(tier(), {
      apiKey: async () => "secret-from-host",
      fetchImpl: fakeFetch(sseBody(["x"]), {
        capture: (_u, init) => {
          headers = init.headers as Record<string, string>
        },
      }),
    })
    await collect(c.complete("q", new AbortController().signal))
    expect(headers.authorization).toBe("Bearer secret-from-host")
    // And the config object itself holds no secret.
    expect(JSON.stringify(tier())).not.toContain("secret")
  })

  test("the abort signal is handed to fetch", async () => {
    let seen: AbortSignal | undefined
    const ctrl = new AbortController()
    const c = createOpenAICompatibleClient(tier(), {
      fetchImpl: fakeFetch(sseBody(["x"]), {
        capture: (_u, init) => {
          seen = init.signal as AbortSignal
        },
      }),
    })
    await collect(c.complete("q", ctrl.signal))
    expect(seen).toBe(ctrl.signal)
  })
})

describe("building tiers from config", () => {
  test("one client per tier, in order", () => {
    const {clients} = buildTiers({
      tiers: [tier({name: "small"}), tier({name: "large", role: "heavy"})],
    })
    expect(clients.map(c => c.name)).toEqual(["small", "large"])
  })

  test("it knows whether a heavy tier exists", () => {
    expect(buildTiers({tiers: [tier()]}).hasHeavyTier).toBe(false)
    expect(buildTiers({tiers: [tier({role: "heavy"})]}).hasHeavyTier).toBe(true)
  })

  test("no tiers at all is refused at construction", () => {
    // An assistant with no model and no explanation is worse than one that
    // refuses to start.
    expect(() => buildTiers({tiers: []})).toThrow(/at least one/i)
  })

  test("a self-hosted endpoint needs no code change", () => {
    const {clients, hasHeavyTier} = buildTiers({
      tiers: [
        tier({name: "on-puck", baseUrl: "http://127.0.0.1:8080", model: "qwen2.5-1.5b"}),
        tier({
          name: "site-gpu",
          baseUrl: "http://llm.plant.internal:8000",
          model: "llama-3.3-70b",
          role: "heavy",
        }),
      ],
    })
    expect(clients.length).toBe(2)
    expect(hasHeavyTier).toBe(true)
  })
})

describe("absent is not the same as failed", () => {
  test("a configured but unreachable heavy tier invites a retry", () => {
    expect(unavailableMessage(true)).toMatch(/can't reach/i)
  })

  test("no heavy tier at all states a deployment fact instead", () => {
    // An on-premise site with no GPU is working as specified, not broken, and
    // should never be told to try again.
    const msg = unavailableMessage(false)
    expect(msg).toMatch(/aren't set up/i)
    expect(msg).not.toMatch(/can't reach/i)
  })

  test("the two messages are different, which is the whole point", () => {
    expect(unavailableMessage(true)).not.toBe(unavailableMessage(false))
  })
})
