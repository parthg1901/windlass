// Live check of the Responses provider against the real API with the saved ChatGPT sign-in.
//
//   bun scripts/provider-live.ts            run every case (a to f)
//   bun scripts/provider-live.ts b e        run selected cases
//
// Cases: a plain text, b two-step tool conversation with stateless replay, c parallel calls,
// d final call with toolChoice "none", e prefix cache with a stable cacheKey, f abort then a
// normal request. One `VERDICT` line per case.
//
// Every request spends the owner's ChatGPT plan allowance: prompts are tiny, the model is small,
// and a full run makes 10 inference requests plus one model-list request. Nothing here prints,
// logs or writes the access token; the provider only puts it in the Authorization header.

import { RESOURCE, accessToken } from "../packages/core/src/auth/chatgpt.ts"
import { OpenAIResponsesProvider, listModels } from "../packages/core/src/provider/openai-responses.ts"
import type { StreamEvent } from "../packages/core/src/provider/provider.ts"
import type { Usage } from "../packages/core/src/provider/usage.ts"
import type { InputItem, ModelRequest } from "../packages/core/src/request/request.ts"

const MODEL = process.env.LIVE_MODEL ?? "gpt-6-luna"
let requests = 0

/** The `reasoning` settings the server echoed on the last `response.created`, for diagnosis. */
let echoedReasoning = "?"

const provider = new OpenAIResponsesProvider({
  accessToken,
  baseUrl: RESOURCE,
  // Tees the response body to read the echoed reasoning settings. Headers are not touched or printed.
  fetch: async (input, init) => {
    const response = await fetch(input, init)
    if (!response.body) return response
    const [mine, theirs] = response.body.tee()
    echoedReasoning = "?"
    void (async () => {
      const reader = mine.getReader()
      const decoder = new TextDecoder()
      let text = ""
      while (echoedReasoning === "?") {
        const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
        echoedReasoning = /"reasoning":(\{[^}]*\})/.exec(text)?.[1] ?? "?"
      }
      await reader.cancel().catch(() => {})
    })()
    return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers })
  },
  readBlob: () => {
    throw new Error("no media in the live script")
  },
})

const weather = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
}

const user = (text: string): InputItem => ({ type: "message", role: "user", content: [{ type: "text", text }] })

function request(input: readonly InputItem[], options: Partial<ModelRequest> & { effort?: string; cacheKey?: string } = {}): ModelRequest {
  return {
    params: {
      model: MODEL,
      reasoningEffort: options.effort ?? "low",
      textVerbosity: null,
      parallelToolCalls: true,
      cacheKey: options.cacheKey ?? crypto.randomUUID(),
    },
    tools: options.tools ?? [],
    instructions: options.instructions ?? "You are a terse assistant.",
    input,
    toolChoice: options.toolChoice ?? "auto",
  }
}

interface Run {
  events: StreamEvent[]
  text: string
  usage: Usage | null
  terminal: StreamEvent | null
  ms: number
}

async function run(model: ModelRequest, signal = new AbortController().signal, onEvent?: (event: StreamEvent) => void): Promise<Run> {
  requests++
  const started = Date.now()
  const events: StreamEvent[] = []
  for await (const event of provider.stream(model, signal)) {
    events.push(event)
    onEvent?.(event)
  }
  const terminal = events.findLast((event) => event.type === "finish" || event.type === "error") ?? null
  const usageEvent = events.find((event) => event.type === "usage")
  return {
    events,
    text: events.flatMap((event) => (event.type === "text.end" ? [event.text] : [])).join(""),
    usage: usageEvent?.type === "usage" ? usageEvent.usage : null,
    terminal,
    ms: Date.now() - started,
  }
}

/** The output of a step as the request builder would replay it: reasoning, text and calls in order. */
function replay(events: readonly StreamEvent[]): InputItem[] {
  return events.flatMap((event): InputItem[] => {
    if (event.type === "reasoning.end") return [{ type: "reasoning", text: event.text, providerData: event.providerData }]
    if (event.type === "text.end") return [{ type: "assistant_text", text: event.text, providerData: event.providerData }]
    if (event.type === "tool_call.end")
      return [{ type: "tool_call", callId: event.callId, name: event.name, input: event.input, providerData: event.providerData }]
    return []
  })
}

const calls = (events: readonly StreamEvent[]) =>
  events.flatMap((event) => (event.type === "tool_call.end" ? [event] : []))

const ending = (result: Run) =>
  result.terminal?.type === "finish"
    ? `finish ${result.terminal.reason}`
    : result.terminal?.type === "error"
      ? `error ${result.terminal.error.kind}: ${result.terminal.error.message}`
      : "no terminal event"

const tokens = (usage: Usage | null) =>
  usage ? `in ${usage.inputTokens} (cached ${usage.cachedInputTokens}) out ${usage.outputTokens} (reasoning ${usage.reasoningTokens})` : "no usage"

function verdict(name: string, pass: boolean, detail: string) {
  console.log(`VERDICT ${name}: ${pass ? "PASS" : "FAIL"} - ${detail}`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const cases: Record<string, () => Promise<void>> = {
  async a() {
    const result = await run(request([user("Say hello in three words.")]))
    const pass = result.terminal?.type === "finish" && result.terminal.reason === "stop" && result.text.length > 0 && result.usage !== null
    verdict("a plain text", pass, `${ending(result)}; text ${JSON.stringify(result.text)}; ${tokens(result.usage)}; ${result.ms} ms`)
  },

  async b() {
    // High effort and a prompt that needs a little thought: at low (and often at medium) this
    // model emits no reasoning item, and then there is nothing to replay.
    const options = { tools: [weather], effort: "high", cacheKey: crypto.randomUUID(), instructions: "" }
    const first = [user(
        "Without writing out your working: is 3^20 larger than 2^31? If it is, get the weather for Paris, otherwise for Rome. Use get_weather.",
      )]
    const step1 = await run(request(first, options))
    const step1Echo = echoedReasoning
    const call = calls(step1.events)[0]
    if (!call) return verdict("b two-step replay", false, `step 1 made no call: ${ending(step1)}`)
    const replayed = replay(step1.events)
    const step2 = await run(
      request(
        [...first, ...replayed, { type: "tool_result", callId: call.callId, output: '{"temp_c":14,"sky":"cloudy"}', attachments: [] }],
        options,
      ),
    )
    const reasoning = replayed.some((item) => item.type === "reasoning")
    const pass =
      step1.terminal?.type === "finish" &&
      step1.terminal.reason === "tool_calls" &&
      step2.terminal?.type === "finish" &&
      step2.terminal.reason === "stop" &&
      step2.text.includes("14")
    // The model decides whether to reason; when it does not, only call and result replay was exercised.
    if (pass && !reasoning) console.log("note b: no reasoning item this run, so reasoning replay was not exercised (PARTIAL)")
    verdict(
      "b two-step replay",
      pass,
      `step 1 ${ending(step1)}, ${tokens(step1.usage)}, echoed reasoning ${step1Echo}, replaying [${replayed.map((item) => item.type).join(", ")}] (reasoning ${reasoning ? "replayed" : "not emitted"}); step 2 ${ending(step2)} with ${step2.events.filter((event) => event.type === "reasoning.end").length} reasoning item(s); text ${JSON.stringify(step2.text.slice(0, 80))}; step 2 ${tokens(step2.usage)}`,
    )
  },

  async c() {
    const result = await run(
      request([user("Get the weather in Paris and in Tokyo. Call get_weather once for each city, in parallel.")], { tools: [weather] }),
    )
    const made = calls(result.events)
    const ids = new Set(made.map((call) => call.callId))
    const pass = result.terminal?.type === "finish" && result.terminal.reason === "tool_calls" && made.length >= 2 && ids.size === made.length
    verdict("c parallel calls", pass, `${ending(result)}; calls ${made.map((call) => `${call.name}${call.input}`).join(" | ")}; ${tokens(result.usage)}`)
  },

  async d() {
    const result = await run(
      request([user("What is the weather in Paris? Use the get_weather tool if you can; otherwise say you cannot check.")], {
        tools: [weather],
        toolChoice: "none",
      }),
    )
    const made = calls(result.events)
    const pass = result.terminal?.type === "finish" && result.terminal.reason === "stop" && made.length === 0 && result.text.length > 0
    verdict("d toolChoice none", pass, `${ending(result)}; calls ${made.length}; text ${JSON.stringify(result.text.slice(0, 80))}`)
  },

  async e() {
    // About 2,500 tokens of fixed instructions: well above the 1,024-token minimum cacheable prefix.
    const instructions = [
      "You are a terse assistant. Follow the house rules below; they never change.",
      ...Array.from(
        { length: 120 },
        (_, index) => `Rule ${index + 1}: when you edit module-${index + 1}.ts keep exports sorted and imports grouped by origin.`,
      ),
    ].join("\n")
    const cacheKey = crypto.randomUUID()
    const cached: number[] = []
    const inputs: number[] = []
    let failures = ""
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(10_000)
      const result = await run(request([user("Reply with OK.")], { instructions, cacheKey }))
      if (result.terminal?.type !== "finish") failures += ` call ${attempt + 1}: ${ending(result)};`
      cached.push(result.usage?.cachedInputTokens ?? -1)
      inputs.push(result.usage?.inputTokens ?? -1)
    }
    const pass = failures === "" && (cached[1] ?? 0) > 0 && (cached[2] ?? 0) > 0
    verdict("e prefix cache", pass, `cached input tokens ${cached.join(", ")} of ${inputs.join(", ")} (10 s apart, one session-id);${failures}`)
  },

  async f() {
    const controller = new AbortController()
    let abortedAt = 0
    const aborted = await run(request([user("Count from 1 to 300, separated by spaces.")]), controller.signal, (event) => {
      if (event.type === "text.delta" && abortedAt === 0) {
        abortedAt = Date.now()
        controller.abort()
      }
    })
    const stoppedIn = abortedAt === 0 ? -1 : Date.now() - abortedAt
    const next = await run(request([user("Say OK.")]))
    const pass =
      abortedAt > 0 && aborted.terminal === null && stoppedIn < 1_000 && next.terminal?.type === "finish" && next.terminal.reason === "stop"
    verdict(
      "f abort then request",
      pass,
      `aborted stream: ${aborted.events.length} event(s), ${aborted.terminal === null ? "no terminal event" : ending(aborted)}, stopped ${stoppedIn} ms after abort; next request ${ending(next)}`,
    )
  },
}

const selected = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(cases)
// The model list is checked on a full run only, to keep partial reruns cheap.
if (process.argv.length <= 2) {
  const models = await listModels({ accessToken, baseUrl: RESOURCE })
  requests++
  const listed = models.some((model) => model.slug === MODEL)
  console.log(`VERDICT models: ${listed ? "PASS" : "FAIL"} - ${models.length} listed; ${MODEL} ${listed ? "present" : "absent"}`)
}
for (const name of selected) {
  const runCase = cases[name]
  if (!runCase) throw new Error(`unknown case ${name}; cases are ${Object.keys(cases).join(" ")}`)
  try {
    await runCase()
  } catch (error) {
    verdict(name, false, `threw ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`requests: ${requests}`)
