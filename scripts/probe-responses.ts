// Live probes that settle open questions about the Responses API under Sign in with ChatGPT.
//
//   bun scripts/probe-responses.ts <name> [<name> ...]   run selected probes
//   bun scripts/probe-responses.ts all                   run every probe once
//   bun scripts/probe-responses.ts list                  list probe names
//
// Every probe prints `VERDICT <name>: ...` lines. Raw request bodies and SSE responses are saved
// under captures/ (git-ignored). Credentials never reach a capture: request headers are recorded
// without Authorization, and cookie or account-like response headers are dropped or masked.
//
// Each request spends the owner's ChatGPT plan allowance, so probes are tiny and shared steps are
// memoized within one run.

import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { RESOURCE, accessToken } from "../packages/core/src/auth/chatgpt.ts"

const MODEL = process.env.PROBE_MODEL ?? "gpt-6-luna"
const CAPTURES = join(import.meta.dir, "..", "captures")
const RUN = new Date().toISOString().replace(/[:.]/g, "-")
let requests = 0

type Json = Record<string, unknown>
type Item = Json & { type: string; id?: string }
type Event = Json & { type: string }

type Result = {
  label: string
  status: number
  headers: Record<string, string>
  raw: string
  events: Event[]
  frames: { eventLines: number; doneSentinel: boolean; comments: number }
  errorBody?: unknown
  aborted?: boolean
}

// ---------------------------------------------------------------- transport

async function send(
  label: string,
  body: Json,
  options: { headers?: Record<string, string>; abortAfter?: (event: Event) => boolean; zstd?: boolean } = {},
): Promise<Result> {
  requests++
  const json = JSON.stringify(body)
  const extra = { "Content-Type": "application/json", ...options.headers, ...(options.zstd ? { "Content-Encoding": "zstd" } : {}) }
  const controller = new AbortController()
  const response = await fetch(`${RESOURCE}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, ...extra },
    body: options.zstd ? Bun.zstdCompressSync(new TextEncoder().encode(json)) : json,
    signal: controller.signal,
  })
  const headers = safeHeaders(response.headers)
  const result: Result = {
    label,
    status: response.status,
    headers,
    raw: "",
    events: [],
    frames: { eventLines: 0, doneSentinel: false, comments: 0 },
  }
  if (!response.ok || !response.body) {
    result.raw = await response.text()
    result.errorBody = parseJson(result.raw) ?? result.raw
    await save(result, body, extra)
    return result
  }
  let buffer = ""
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const text = decoder.decode(chunk.value, { stream: true })
      result.raw += text
      buffer += text.replace(/\r\n/g, "\n")
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        const event = readFrame(frame, result)
        if (!event) continue
        result.events.push(event)
        if (options.abortAfter?.(event)) {
          controller.abort()
          result.aborted = true
          throw new Error("aborted by probe")
        }
      }
    }
    const tail = readFrame(buffer, result)
    if (tail) result.events.push(tail)
  } catch (error) {
    if (!result.aborted) throw error
  }
  await save(result, body, extra)
  return result
}

function readFrame(frame: string, result: Result) {
  const lines = frame.split("\n").filter((line) => line.length > 0)
  result.frames.eventLines += lines.filter((line) => line.startsWith("event:")).length
  result.frames.comments += lines.filter((line) => line.startsWith(":")).length
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data) return undefined
  if (data === "[DONE]") {
    result.frames.doneSentinel = true
    return undefined
  }
  return JSON.parse(data) as Event
}

function safeHeaders(headers: Headers) {
  return Object.fromEntries(
    [...headers]
      .filter(([name]) => !/cookie|authorization/i.test(name))
      .map(([name, value]) => [name, /account|organization|user|project/i.test(name) ? "<masked>" : value]),
  )
}

async function save(result: Result, body: Json, requestHeaders: Record<string, string>) {
  await mkdir(CAPTURES, { recursive: true })
  const stem = join(CAPTURES, `${RUN}-${String(requests).padStart(2, "0")}-${result.label}`)
  await Bun.write(
    `${stem}.json`,
    JSON.stringify(
      {
        request: { url: `${RESOURCE}/responses`, headers: requestHeaders, body },
        response: { status: result.status, headers: result.headers, frames: result.frames, aborted: result.aborted ?? false },
      },
      null,
      2,
    ),
  )
  await Bun.write(`${stem}.sse`, result.raw)
}

const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- helpers

const base = (extra: Json = {}): Json => ({
  model: MODEL,
  store: false,
  stream: true,
  reasoning: { effort: "low", summary: "auto" },
  ...extra,
})

const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })

const weatherTool = (description = "Get the current weather for a city.") => ({
  type: "function",
  name: "get_weather",
  description,
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  strict: true,
})

const WEATHER_PROMPT = "What is the weather in Paris right now? Use the get_weather tool."
const WEATHER_OUTPUT = '{"temp_c":14,"sky":"cloudy"}'

const terminal = (r: Result) =>
  r.events.findLast((e) => ["response.completed", "response.failed", "response.incomplete", "error"].includes(e.type))
const completed = (r: Result) => r.events.find((e) => e.type === "response.completed") as
  | (Event & { response: Json & { usage?: Json; output?: Item[] } })
  | undefined
const doneItems = (r: Result) =>
  r.events.filter((e) => e.type === "response.output_item.done").map((e) => e.item as Item)
const calls = (r: Result) => doneItems(r).filter((item) => item.type === "function_call")
const text = (r: Result) =>
  r.events
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => e.delta)
    .join("")
const usage = (r: Result) => completed(r)?.response.usage as
  | (Json & { input_tokens: number; output_tokens: number; input_tokens_details?: Json })
  | undefined
const cached = (r: Result) => (usage(r)?.input_tokens_details?.cached_tokens as number | undefined) ?? 0

// Event order with consecutive repeats collapsed, e.g. `a, b×5, c`.
function order(r: Result) {
  const out: Array<[string, number]> = []
  for (const event of r.events) {
    const last = out.at(-1)
    if (last && last[0] === event.type) last[1]++
    else out.push([event.type, 1])
  }
  return out.map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join(" → ")
}

function outcome(r: Result) {
  if (r.status !== 200) return `HTTP ${r.status} ${JSON.stringify(r.errorBody).slice(0, 400)}`
  const end = terminal(r)
  if (!end) return `HTTP 200, no terminal event${r.aborted ? " (aborted)" : ""}`
  if (end.type === "response.completed") return "HTTP 200 completed"
  return `HTTP 200 ${end.type} ${JSON.stringify(end).slice(0, 400)}`
}

const verdict = (name: string, line: string) => console.log(`VERDICT ${name}: ${line}`)
const detail = (line: string) => console.log(`  ${line}`)

function memo<T>(fn: () => Promise<T>) {
  let value: Promise<T> | undefined
  return () => (value ??= fn())
}

// Step 1 of a tool-using conversation, shared by the tools, replay and reasoning probes.
const stepOne = memo(() => remember("step1-function-call", base({ tools: [weatherTool()], input: [user(WEATHER_PROMPT)] })))

// Low effort on gpt-6-luna emits no reasoning item for the weather prompt, so the reasoning probe
// uses medium effort and a prompt that needs a little thought before the call.
const REASONING_PROMPT =
  "Compute 17 * 23. If the result is odd, get the weather for Paris, otherwise for Rome. Use get_weather."
const reasoningStepOne = memo(() =>
  remember(
    "reasoning-step1",
    base({ reasoning: { effort: "medium", summary: "auto" }, tools: [weatherTool()], input: [user(REASONING_PROMPT)] }),
  ),
)

// Builds step 2 from a step 1's items. `shape` rewrites the replayed items; null drops an item.
async function stepTwo(
  label: string,
  shape: (item: Item) => Item | null,
  output: (call: Item) => Json,
  first: () => Promise<Result> = stepOne,
) {
  const step = await first()
  const items = doneItems(step)
    .map(shape)
    .filter((item): item is Item => item !== null)
  if (!calls(step).length) throw new Error("step 1 produced no function call")
  const request = JSON.parse(stepRequests.get(step) ?? "{}") as Json & { input: Item[] }
  return send(label, { ...request, input: [...request.input, ...items, ...calls(step).map(output)] })
}

const stepRequests = new WeakMap<Result, string>()
const remember = async (label: string, body: Json) => {
  const result = await send(label, body)
  stepRequests.set(result, JSON.stringify(body))
  return result
}

const callOutput = (call: Item) => ({ type: "function_call_output", call_id: call.call_id, output: WEATHER_OUTPUT })
const strip = (item: Item, ...keys: string[]) =>
  Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key))) as Item
const minimalCall = (item: Item) =>
  item.type === "function_call" ? { type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments } : item

const replays = {
  verbatim: memo(() => stepTwo("step2-verbatim", (item) => item, callOutput)),
  noReasoningNoIds: memo(() =>
    stepTwo("step2-minimal", (item) => (item.type === "reasoning" ? null : minimalCall(item)), callOutput),
  ),
}

// ---------------------------------------------------------------- probes

const probes: Record<string, () => Promise<void>> = {
  async tools() {
    const r = await stepOne()
    const call = calls(r)[0]
    verdict("tools", `top-level function tool: ${outcome(r)}; model called it: ${call ? `yes (${call.name} ${call.arguments})` : "no"}`)
    detail(`order: ${order(r)}`)
    if (call) detail(`function_call item keys: ${Object.keys(call).join(", ")}`)
    const added = r.events.find((e) => e.type === "response.output_item.added" && (e.item as Item).type === "function_call")
    if (added) detail(`output_item.added function_call: ${JSON.stringify(added.item)}`)
    const delta = r.events.find((e) => e.type === "response.function_call_arguments.delta")
    if (delta) detail(`arguments.delta keys: ${Object.keys(delta).join(", ")}`)
    const output = completed(r)?.response.output
    detail(`response.completed output array length: ${output?.length ?? "absent"}`)
  },

  async replay() {
    const verbatim = await replays.verbatim()
    verdict("replay", `verbatim items (ids, status) + function_call_output: ${outcome(verbatim)}; text: ${JSON.stringify(text(verbatim).slice(0, 80))}`)
    const minimal = await replays.noReasoningNoIds()
    verdict("replay", `minimal {type,call_id,name,arguments} without id, no reasoning item: ${outcome(minimal)}; text: ${JSON.stringify(text(minimal).slice(0, 80))}`)
    const fake = await stepTwo(
      "step2-fake-id",
      (item) => (item.type === "function_call" ? { ...minimalCall(item), id: "fc_probe0000000000000000" } : item),
      callOutput,
    )
    verdict("replay", `function_call with an invented id: ${outcome(fake)}`)
    const noCallId = await stepTwo("step2-output-without-call-id", minimalCall, () => ({
      type: "function_call_output",
      output: WEATHER_OUTPUT,
    }))
    verdict("replay", `function_call_output without call_id: ${outcome(noCallId)}`)
  },

  async reasoning() {
    const first = await reasoningStepOne()
    const reasoning = doneItems(first).find((item) => item.type === "reasoning")
    verdict(
      "reasoning",
      `medium effort, no include: ${outcome(first)}; reasoning item ${reasoning ? "present" : "absent"}; encrypted_content ${
        typeof reasoning?.encrypted_content === "string" ? `present (${(reasoning.encrypted_content as string).length} chars)` : "absent"
      }; keys: ${reasoning ? Object.keys(reasoning).join(", ") : "-"}`,
    )
    detail(`order: ${order(first)}`)
    const added = first.events.find((e) => e.type === "response.output_item.added" && (e.item as Item).type === "reasoning")
    if (added) detail(`output_item.added reasoning: ${JSON.stringify(added.item).slice(0, 200)}`)
    if (!reasoning) return verdict("reasoning", "no reasoning item; replay questions not answered")
    const included = await send(
      "reasoning-include",
      base({
        reasoning: { effort: "medium", summary: "auto" },
        tools: [weatherTool()],
        input: [user(REASONING_PROMPT)],
        include: ["reasoning.encrypted_content"],
      }),
    )
    const includedItem = doneItems(included).find((item) => item.type === "reasoning")
    verdict(
      "reasoning",
      `with include: ${outcome(included)}; reasoning item ${includedItem ? "present" : "absent"}; encrypted_content ${typeof includedItem?.encrypted_content === "string" ? "present" : "absent"}`,
    )
    const verbatim = await stepTwo("reasoning-step2-verbatim", (item) => item, callOutput, reasoningStepOne)
    verdict("reasoning", `replay with reasoning item verbatim: ${outcome(verbatim)}; input_tokens ${usage(verbatim)?.input_tokens}; text ${JSON.stringify(text(verbatim).slice(0, 60))}`)
    const omitted = await stepTwo(
      "reasoning-step2-omitted",
      (item) => (item.type === "reasoning" ? null : minimalCall(item)),
      callOutput,
      reasoningStepOne,
    )
    verdict("reasoning", `reasoning omitted, function_call kept: ${outcome(omitted)}; input_tokens ${usage(omitted)?.input_tokens}`)
    const noId = await stepTwo(
      "reasoning-step2-no-id",
      (item) => (item.type === "reasoning" ? strip(item, "id") : minimalCall(item)),
      callOutput,
      reasoningStepOne,
    )
    verdict("reasoning", `reasoning item without id: ${outcome(noId)}; input_tokens ${usage(noId)?.input_tokens}`)
    const tampered = await stepTwo(
      "reasoning-step2-tampered",
      (item) => (item.type === "reasoning" ? { ...item, encrypted_content: "gAAAAAprobe-not-valid" } : minimalCall(item)),
      callOutput,
      reasoningStepOne,
    )
    verdict("reasoning", `reasoning with corrupted encrypted_content: ${outcome(tampered)}`)
  },

  async instructions() {
    const viaInstructions = await send("instructions-field", base({ instructions: "Reply with one word.", input: [user("Say hi.")] }))
    verdict("instructions", `top-level instructions: ${outcome(viaInstructions)}; text ${JSON.stringify(text(viaInstructions))}`)
    const developer = await send(
      "instructions-developer",
      base({
        input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "Reply with one word." }] }, user("Say hi.")],
      }),
    )
    verdict("instructions", `developer message: ${outcome(developer)}; text ${JSON.stringify(text(developer))}`)
    const system = await send(
      "instructions-system",
      base({ input: [{ type: "message", role: "system", content: [{ type: "input_text", text: "Reply with one word." }] }, user("Say hi.")] }),
    )
    verdict("instructions", `system message: ${outcome(system)}`)
  },

  async rejected() {
    const temperature = await send("rejected-temperature", base({ temperature: 0.5, input: [user("Say hi.")] }))
    verdict("rejected", `temperature: ${outcome(temperature)}`)
    detail(`content-type: ${temperature.headers["content-type"]}`)
    const unknown = await send("rejected-unknown-field", base({ probe_unknown_field: 1, input: [user("Say hi.")] }))
    verdict("rejected", `unknown field: ${outcome(unknown)}`)
  },

  async text() {
    const r = await plainText()
    verdict("text", `plain answer: ${outcome(r)}; text ${JSON.stringify(text(r))}`)
    detail(`order: ${order(r)}`)
  },

  // Analyses every capture on disk, so run it last (or after `all`).
  async framing() {
    if (!(await captureFiles()).length) await plainText()
    const files = await captureFiles()
    const counts = new Map<string, number>()
    const lastEvents = new Map<string, number>()
    const stats = { eventLines: 0, done: 0, comments: 0, streams: 0, obfuscation: 0, responseId: 0 }
    for (const file of files) {
      const meta = (await Bun.file(join(CAPTURES, file)).json()) as { response: { status: number; frames: Result["frames"]; aborted: boolean } }
      if (meta.response.status !== 200) continue
      stats.streams++
      stats.eventLines += meta.response.frames.eventLines
      stats.comments += meta.response.frames.comments
      if (meta.response.frames.doneSentinel) stats.done++
      const raw = await Bun.file(join(CAPTURES, file.replace(/\.json$/, ".sse"))).text()
      const events = raw
        .replace(/\r\n/g, "\n")
        .split("\n\n")
        .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()))
        .filter((data) => data && data !== "[DONE]")
        .map((data) => parseJson(data) as Event | undefined)
        .filter((event): event is Event => event !== undefined)
      for (const event of events) {
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
        if ("obfuscation" in event) stats.obfuscation++
        if ("response_id" in event) stats.responseId++
      }
      const last = events.at(-1)?.type
      if (last && !meta.response.aborted) lastEvents.set(last, (lastEvents.get(last) ?? 0) + 1)
    }
    verdict(
      "framing",
      `${stats.streams} streams: event: lines ${stats.eventLines ? `yes (${stats.eventLines})` : "no"}; [DONE] ${stats.done ? `yes (${stats.done} streams)` : "never"}; comment/keepalive lines ${stats.comments}`,
    )
    verdict("framing", `last event per non-aborted stream: ${[...lastEvents].map(([t, n]) => `${t}×${n}`).join(", ")}`)
    verdict("framing", `response.metadata seen ${counts.get("response.metadata") ?? 0} times; events with obfuscation ${stats.obfuscation}; events with response_id ${stats.responseId}`)
    console.log("  distinct event types:")
    for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${type} ${n}`)
    const metadata = await firstEventOfType("response.metadata")
    if (metadata) detail(`response.metadata example keys: ${JSON.stringify(Object.keys(metadata))} ${JSON.stringify(metadata).slice(0, 400)}`)
  },

  async usage() {
    const r = await plainText()
    const u = usage(r)
    verdict("usage", `usage keys: ${u ? Object.keys(u).join(", ") : "absent"}`)
    console.log(`  ${JSON.stringify(u, null, 2).replace(/\n/g, "\n  ")}`)
    const response = completed(r)?.response
    if (response) detail(`response.completed keys: ${Object.keys(response).join(", ")}`)
  },

  async cache() {
    const nonce = crypto.randomUUID().slice(0, 8)
    const filler = fillerPrefix(nonce)
    const request = (last: string, description?: string, extra: Json = {}) =>
      base({
        tools: [weatherTool(description)],
        input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: filler }] }, user(last)],
        ...extra,
      })
    const key = { prompt_cache_key: `probe-${nonce}` }
    const a1 = await send("cache-a1-cold", request("Reply with OK.", undefined, key))
    await Bun.sleep(2000)
    const a2 = await send("cache-a2-same", request("Reply with OK.", undefined, key))
    verdict("cache", `same request twice (key): input ${usage(a1)?.input_tokens}, cached ${cached(a1)} → ${cached(a2)}`)
    detail(`a1 input_tokens_details ${JSON.stringify(usage(a1)?.input_tokens_details)}`)
    detail(`a2 input_tokens_details ${JSON.stringify(usage(a2)?.input_tokens_details)}`)
    const a3 = await send("cache-a3-new-user", request("Reply with YES.", undefined, key))
    verdict("cache", `only last user message changed: cached ${cached(a3)} of ${usage(a3)?.input_tokens}`)
    const a4 = await send("cache-a4-tool-desc", request("Reply with OK.", "Fetch the current weather for one city.", key))
    verdict("cache", `one tool description changed: cached ${cached(a4)} of ${usage(a4)?.input_tokens}`)

    const noKeyNonce = crypto.randomUUID().slice(0, 8)
    const noKey = (n: string) =>
      base({
        tools: [weatherTool()],
        input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: fillerPrefix(noKeyNonce) }] }, user(n)],
      })
    await send("cache-b1-nokey-cold", noKey("Reply with OK."))
    await Bun.sleep(2000)
    const b2 = await send("cache-b2-nokey-same", noKey("Reply with OK."))
    verdict("cache", `no prompt_cache_key, no header, same request twice: cached ${cached(b2)} of ${usage(b2)?.input_tokens}`)

    const sessionNonce = crypto.randomUUID().slice(0, 8)
    const session = { "session-id": crypto.randomUUID() }
    const withSession = (n: string) =>
      base({
        tools: [weatherTool()],
        input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: fillerPrefix(sessionNonce) }] }, user(n)],
      })
    await send("cache-c1-session-cold", withSession("Reply with OK."), { headers: session })
    await Bun.sleep(2000)
    const c2 = await send("cache-c2-session-same", withSession("Reply with OK."), { headers: session })
    verdict("cache", `session-id header only, same request twice: cached ${cached(c2)} of ${usage(c2)?.input_tokens}`)
  },

  // Second cache round: which parts of the session-id behaviour hold, and does a key alone ever hit.
  async cache2() {
    const nonce = crypto.randomUUID().slice(0, 8)
    const filler = fillerPrefix(nonce)
    const request = (last: string, description?: string, extra: Json = {}) =>
      base({
        tools: [weatherTool(description)],
        input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: filler }] }, user(last)],
        ...extra,
      })
    const session = { "session-id": crypto.randomUUID() }
    const s1 = await send("cache2-s1-cold", request("Reply with OK."), { headers: session })
    await Bun.sleep(2000)
    const s2 = await send("cache2-s2-same", request("Reply with OK."), { headers: session })
    verdict("cache2", `session-id, same request twice: cached ${cached(s1)} → ${cached(s2)} of ${usage(s2)?.input_tokens}`)
    const s3 = await send("cache2-s3-new-user", request("Reply with YES."), { headers: session })
    verdict("cache2", `session-id, only last user message changed: cached ${cached(s3)} of ${usage(s3)?.input_tokens}`)
    const s4 = await send("cache2-s4-tool-desc", request("Reply with OK.", "Fetch the current weather for one city."), { headers: session })
    verdict("cache2", `session-id, one tool description changed: cached ${cached(s4)} of ${usage(s4)?.input_tokens}`)
    const s5 = await send("cache2-s5-other-session", request("Reply with OK."), { headers: { "session-id": crypto.randomUUID() } })
    verdict("cache2", `same prefix, different session-id: cached ${cached(s5)} of ${usage(s5)?.input_tokens}`)
    const s6 = await send("cache2-s6-key-only", request("Reply with OK.", undefined, { prompt_cache_key: `probe-${nonce}` }))
    verdict("cache2", `same (warm) prefix, prompt_cache_key and no session-id: cached ${cached(s6)} of ${usage(s6)?.input_tokens}`)
    const k1 = fillerPrefix(`${nonce}-k`)
    const keyed = () =>
      base({
        prompt_cache_key: `probe-${nonce}-k`,
        tools: [weatherTool()],
        input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: k1 }] }, user("Reply with OK.")],
      })
    await send("cache2-k1-cold", keyed())
    await Bun.sleep(6000)
    const k2 = await send("cache2-k2-same", keyed())
    verdict("cache2", `prompt_cache_key only, 6 s apart (second attempt): cached ${cached(k2)} of ${usage(k2)?.input_tokens}`)
  },

  async headers() {
    if (!(await captureFiles()).length) await plainText()
    const file = (await captureFiles()).findLast((f) => f.includes("text-plain") || f.includes("step1")) ?? (await captureFiles()).at(-1)!
    const meta = (await Bun.file(join(CAPTURES, file)).json()) as { response: { headers: Record<string, string> } }
    verdict("headers", `${Object.keys(meta.response.headers).length} headers on a 200 stream (cookies dropped, account-like values masked)`)
    for (const [name, value] of Object.entries(meta.response.headers)) detail(`${name}: ${value}`)
  },

  async toolnone() {
    const r = await send("tool-choice-none", base({ tools: [weatherTool()], tool_choice: "none", input: [user(WEATHER_PROMPT)] }))
    verdict("toolnone", `tool_choice none with tools: ${outcome(r)}; calls ${calls(r).length}; text ${JSON.stringify(text(r).slice(0, 100))}`)
  },

  async parallel() {
    const prompt = "Get the weather for Paris and for Tokyo. Call get_weather once per city, both calls in this one response."
    let r = await send("parallel-two-calls", base({ tools: [weatherTool()], parallel_tool_calls: true, input: [user(prompt)] }))
    if (calls(r).length < 2)
      r = await send(
        "parallel-two-calls-retry",
        base({ tools: [weatherTool()], parallel_tool_calls: true, input: [user(`${prompt} Issue both tool calls in parallel now.`)] }),
      )
    verdict("parallel", `parallel_tool_calls true: ${outcome(r)}; ${calls(r).length} calls: ${calls(r).map((c) => c.arguments).join(" ")}`)
    detail(`order: ${order(r)}`)
    detail(
      `output_index per call: ${r.events
        .filter((e) => e.type === "response.output_item.done" && (e.item as Item).type === "function_call")
        .map((e) => e.output_index)
        .join(", ")}`,
    )
    const serial = await send("parallel-false", base({ tools: [weatherTool()], parallel_tool_calls: false, input: [user(prompt)] }))
    verdict("parallel", `parallel_tool_calls false: ${outcome(serial)}; ${calls(serial).length} calls`)
  },

  async abort() {
    const aborted = await send(
      "abort-midstream",
      base({ input: [user("Write the numbers from 1 to 80, separated by spaces.")] }),
      { abortAfter: (event) => event.type === "response.output_text.delta" },
    )
    verdict("abort", `aborted after ${aborted.events.length} events (aborted=${aborted.aborted ?? false}, last ${aborted.events.at(-1)?.type})`)
    const next = await send("abort-next", base({ input: [user("Say OK.")] }))
    verdict("abort", `next request: ${outcome(next)}; text ${JSON.stringify(text(next))}`)
  },

  async extras() {
    const say = () => [user("Say OK.")]
    const options = await send("extra-prompt-cache-options", base({ prompt_cache_options: { ttl: "12h" }, input: say() }))
    verdict("extras", `prompt_cache_options {ttl:"12h"}: ${outcome(options)}; usage details ${JSON.stringify(usage(options)?.input_tokens_details)}`)
    const obfuscation = await send("extra-no-obfuscation", base({ stream_options: { include_obfuscation: false }, input: say() }))
    const deltas = obfuscation.events.filter((e) => e.type.endsWith(".delta"))
    verdict("extras", `stream_options.include_obfuscation false: ${outcome(obfuscation)}; deltas with obfuscation ${deltas.filter((e) => "obfuscation" in e).length}/${deltas.length}`)
    const namespace = await send(
      "extra-namespace-tool",
      base({
        tools: [{ type: "namespace", name: "wx", description: "Weather tools.", tools: [weatherTool()] }],
        input: [user(WEATHER_PROMPT)],
      }),
    )
    verdict("extras", `namespace tool: ${outcome(namespace)}; call ${JSON.stringify(calls(namespace)[0] ?? null)}`)
    const update = await send(
      "extra-configuration-update",
      base({ input: [{ type: "configuration_update", reasoning: { effort: "medium" } }, user("Say OK.")] }),
    )
    verdict("extras", `configuration_update item: ${outcome(update)}`)
    const allowed = await send(
      "extra-allowed-tools-none",
      base({
        tools: [weatherTool()],
        tool_choice: { type: "allowed_tools", mode: "none", tools: [{ type: "function", name: "get_weather" }] },
        input: [user(WEATHER_PROMPT)],
      }),
    )
    verdict("extras", `allowed_tools mode none: ${outcome(allowed)}`)
    const zstd = await send("extra-zstd-body", base({ input: say() }), { zstd: true })
    verdict("extras", `zstd-compressed request body: ${outcome(zstd)}`)
  },
}

const plainText = memo(() => send("text-plain", base({ input: [user("Say exactly: Hello, world!")] })))

async function captureFiles() {
  const names = await readdir(CAPTURES).catch(() => [] as string[])
  return names.filter((name) => name.endsWith(".json")).sort()
}

async function firstEventOfType(type: string) {
  for (const file of await captureFiles()) {
    const raw = await Bun.file(join(CAPTURES, file.replace(/\.json$/, ".sse"))).text()
    const line = raw.split("\n").find((l) => l.startsWith("data:") && l.includes(`"type":"${type}"`))
    if (line) return parseJson(line.slice(5).trim()) as Json
  }
  return undefined
}

// About 2,500 tokens of deterministic text. The nonce leads so earlier runs cannot pre-warm it.
function fillerPrefix(nonce: string) {
  const words = ["amber", "basalt", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "iris", "juniper", "kelp", "lichen"]
  const lines = Array.from(
    { length: 160 },
    (_, i) =>
      `Guideline ${i + 1}: when handling record ${i * 7 + 3}, prefer ${words[i % 12]} over ${words[(i * 5 + 1) % 12]} and log it.`,
  )
  return [`Probe run ${nonce}. These guidelines are filler for a cache test; ignore them.`, ...lines].join("\n")
}

// ---------------------------------------------------------------- main

const ORDER = ["text", "tools", "replay", "reasoning", "instructions", "rejected", "toolnone", "parallel", "abort", "cache", "cache2", "extras", "usage", "headers", "framing"]

const names = process.argv.slice(2)
if (!names.length || names[0] === "list") {
  console.log(`probes: ${ORDER.join(", ")}, all`)
  process.exit(names.length ? 0 : 2)
}
for (const name of names[0] === "all" ? ORDER : names) {
  const probe = probes[name]
  if (!probe) {
    console.error(`unknown probe ${name}`)
    process.exit(2)
  }
  try {
    await probe()
  } catch (error) {
    verdict(name, `probe error: ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`requests made: ${requests}`)
