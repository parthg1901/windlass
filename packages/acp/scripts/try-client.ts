#!/usr/bin/env bun
/**
 * A small ACP client for trying the harness the way an editor drives it. It
 * spawns `<binary> acp`, opens a session, sends one prompt, and prints every
 * update as it arrives.
 *
 *   bun packages/acp/scripts/try-client.ts [options] [prompt]
 *
 * Options:
 *   --setup failing-test     create a temporary workspace with one failing test
 *   --workspace <dir>        work in this directory (default: a new temporary one)
 *   --load <session id>      load a stored session (its history is replayed) instead of creating one
 *   --model <id>             set the model (config option `model`)
 *   --effort <level>         set the reasoning effort (config option `effort`)
 *   --cancel-on-command <ms> send session/cancel this long after a shell command starts
 *   --max-requests <n>       cancel once this many model calls have reported usage (default 12)
 *   --raw                    also print every update as JSON
 *
 * Ctrl-C sends session/cancel; a second Ctrl-C exits. The script never sees
 * a token: the agent keeps the sign-in to itself.
 */
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type SessionNotification, client, methods, ndJsonStream } from "@agentclientprotocol/sdk"
import { EXT } from "../src/extensions.ts"

const MAIN = join(import.meta.dir, "..", "..", "cli", "src", "main.ts")
const args = parseArgs(process.argv.slice(2))
const dim = (text: string) => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text)
const bold = (text: string) => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text)

const workspace = args.workspace ?? realpathSync(mkdtempSync(join(tmpdir(), "lh-try-")))
if (args.setup === "failing-test") await setupFailingTest(workspace)
say(`workspace: ${workspace}`)

const child = Bun.spawn([process.execPath, MAIN, "acp"], { cwd: workspace, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env })
void (async () => {
  // The agent's log, shown dimmed and apart from the protocol traffic.
  for await (const chunk of child.stderr) for (const line of new TextDecoder().decode(chunk).split("\n")) if (line.trim() !== "") console.log(dim(`  [agent log] ${line}`))
})()
const input = new WritableStream<Uint8Array>({
  write: (chunk) => {
    child.stdin.write(chunk)
    child.stdin.flush()
  },
})

let requests = 0
let sessionId = ""
let cancelled = false
let streaming: string | null = null
const toolTitles = new Map<string, string>()
/** Shell calls, for `--cancel-on-command`. Declared before the connection so the update handler can use it at once. */
const commandCalls = new Set<string>()
const connection = client({ name: "try-client" })
  .onNotification(methods.client.session.update, ({ params }) => show(params))
  .onNotification("*", ({ method, params }) => showExt(method, params as Record<string, unknown>))
  .connect(ndJsonStream(input, child.stdout))

const init = await connection.agent.request(methods.agent.initialize, {
  protocolVersion: 1,
  clientCapabilities: { session: { notices: {} } },
  clientInfo: { name: "try-client", version: "0.0.0" },
})
say(`agent: ${init.agentInfo?.title ?? init.agentInfo?.name} ${init.agentInfo?.version ?? ""}, protocol ${init.protocolVersion}`)
say(`auth methods: ${(init.authMethods ?? []).map((method) => method.name).join(", ")}`)

const opened = await (async () => {
  try {
    if (args.load !== null) {
      say(`loading ${args.load}; replayed history follows`)
      sessionId = args.load
      const response = await connection.agent.request(methods.agent.session.load, { sessionId: args.load, cwd: workspace, mcpServers: [] })
      endStream()
      say("load answered: replay complete")
      return response.configOptions ?? []
    }
    const response = await connection.agent.request(methods.agent.session.new, { cwd: workspace, mcpServers: [] })
    sessionId = response.sessionId
    say(`session ${sessionId}`)
    return response.configOptions ?? []
  } catch (error) {
    say(`could not open a session: ${describe(error)}`)
    await finish(1)
    return []
  }
})()
say(`config: ${opened.map((option) => `${option.id}=${option.currentValue}`).join(", ")}`)
for (const [configId, value] of [["model", args.model], ["effort", args.effort]] as const) {
  if (value === null) continue
  const response = await connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value })
  say(`set ${configId}: ${response.configOptions.map((option) => `${option.id}=${option.currentValue}`).join(", ")}`)
}

let interrupts = 0
process.on("SIGINT", () => {
  interrupts += 1
  if (interrupts > 1) process.exit(130)
  say("Ctrl-C: sending session/cancel (again to exit)")
  void cancel()
})

if (args.prompt !== null) {
  say(`${bold("user")}: ${args.prompt}`)
  const started = Date.now()
  try {
    const response = await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: args.prompt }] })
    endStream()
    say(`${bold("stop reason")}: ${response.stopReason} after ${((Date.now() - started) / 1000).toFixed(1)} s, ${requests} model request(s)`)
  } catch (error) {
    endStream()
    say(`${bold("prompt failed")}: ${describe(error)}`)
  }
}
await finish(0)

function show(note: SessionNotification): void {
  const update = note.update
  const chunk = update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "user_message_chunk"
  if (!chunk) endStream()
  if (args.raw) console.log(dim(JSON.stringify(update)))
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const label = update.sessionUpdate === "agent_message_chunk" ? "agent" : update.sessionUpdate === "agent_thought_chunk" ? "thinking" : "user"
      const key = `${label}:${update.messageId ?? ""}`
      const text = update.content.type === "text" ? update.content.text : `[${update.content.type}]`
      if (streaming !== key) {
        endStream()
        process.stdout.write(`${bold(label)}: `)
        streaming = key
      }
      process.stdout.write(label === "thinking" ? dim(text) : text)
      return
    }
    case "tool_call": {
      endStream()
      toolTitles.set(update.toolCallId, update.title)
      say(`▶ ${update.title} [${update.kind ?? "other"}] ${update.status ?? "pending"}${update.rawInput === undefined ? "" : ` ${dim(JSON.stringify(update.rawInput).slice(0, 160))}`}`)
      if (args.cancelOnCommand !== null && update.kind === "execute") watchCommand(update.toolCallId)
      return
    }
    case "tool_call_update": {
      endStream()
      if (update.title) toolTitles.set(update.toolCallId, update.title)
      const title = toolTitles.get(update.toolCallId) ?? update.toolCallId
      const where = update.locations?.map((location) => `${location.path}${location.line ? `:${location.line}` : ""}`).join(", ")
      if (update.status) say(`  ${title}: ${update.status}${where ? ` (${where})` : ""}`)
      if (update.status === "in_progress" && args.cancelOnCommand !== null && commandCalls.has(update.toolCallId)) scheduleCancel()
      for (const item of update.content ?? []) {
        if (item.type === "diff") say(`    diff ${item.path}: ${item.oldText === null || item.oldText === undefined ? "new file" : `${lines(item.oldText)} → ${lines(item.newText)} lines`}\n${indent(diffText(item.oldText ?? "", item.newText))}`)
        else if (item.type === "content" && item.content.type === "text") say(indent(clip(item.content.text, 12)))
      }
      return
    }
    case "usage_update":
      say(dim(`  context: ${update.used.toLocaleString("en-US")} of ${update.size.toLocaleString("en-US")} tokens`))
      return
    case "notice":
      say(`  notice (${update.severity}): ${update.title}${update.description ? ` — ${update.description}` : ""}`)
      return
    case "config_option_update":
      say(dim(`  config: ${update.configOptions.map((option) => `${option.id}=${option.currentValue}`).join(", ")}`))
      return
    case "session_info_update":
      say(dim(`  session: title ${JSON.stringify(update.title ?? null)}, updated ${update.updatedAt ?? "?"}`))
      return
    default:
      say(dim(`  (${update.sessionUpdate})`))
  }
}

function showExt(method: string, params: Record<string, unknown>): void {
  if (method === EXT.usage) {
    requests += 1
    const usage = params.usage as { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }
    endStream()
    say(dim(`  model call ${requests}: in ${usage.inputTokens} (cached ${usage.cachedInputTokens}), out ${usage.outputTokens} (reasoning ${usage.reasoningTokens})`))
    if (requests >= args.maxRequests && !cancelled) {
      say(`reached --max-requests ${args.maxRequests}; cancelling`)
      void cancel()
    }
    return
  }
  if (method === EXT.state) {
    endStream()
    say(dim(`  state: ${String(params.state)}${params.stopReason ? ` (${String(params.stopReason)})` : ""}${params.message ? `: ${String(params.message)}` : ""}`))
    return
  }
  say(dim(`  ${method} ${JSON.stringify(params)}`))
}

function watchCommand(toolCallId: string): void {
  commandCalls.add(toolCallId)
}
function scheduleCancel(): void {
  if (cancelled) return
  setTimeout(() => {
    say(`the command has run for ${args.cancelOnCommand} ms; sending session/cancel`)
    void cancel()
  }, args.cancelOnCommand ?? 0)
}

async function cancel(): Promise<void> {
  if (cancelled || sessionId === "") return
  cancelled = true
  await connection.agent.notify(methods.agent.session.cancel, { sessionId })
}

async function finish(code: number): Promise<never> {
  endStream()
  child.stdin.end()
  const exit = await Promise.race([child.exited, Bun.sleep(8000).then(() => null)])
  say(dim(`agent exited with ${exit === null ? "nothing yet (killed)" : String(exit)}`))
  if (exit === null) child.kill()
  process.exit(code)
}

function endStream(): void {
  if (streaming !== null) process.stdout.write("\n")
  streaming = null
}

function say(line: string): void {
  console.log(line)
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n")
}

function clip(text: string, max: number): string {
  const all = text.split("\n")
  return all.length <= max ? text : [...all.slice(0, max), `… ${all.length - max} more lines`].join("\n")
}

function lines(text: string): number {
  return text === "" ? 0 : text.split("\n").length
}

/** A crude line diff for display: lines only in the old text with -, only in the new with +. */
function diffText(oldText: string, newText: string): string {
  const before = new Set(oldText.split("\n"))
  const after = new Set(newText.split("\n"))
  return [...oldText.split("\n").filter((line) => !after.has(line)).map((line) => `- ${line}`), ...newText.split("\n").filter((line) => !before.has(line)).map((line) => `+ ${line}`)].join("\n")
}

function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const code = "code" in error ? ` (${String(error.code)})` : ""
    return `${String(error.message)}${code}`
  }
  return String(error)
}

async function setupFailingTest(dir: string): Promise<void> {
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "try-workspace", private: true, type: "module" }, null, 2) + "\n")
  await Bun.write(join(dir, "price.ts"), "/** The price after a percentage discount, rounded to cents. */\nexport function discounted(price: number, percent: number): number {\n  return Math.round(price * (1 + percent / 100) * 100) / 100\n}\n")
  await Bun.write(
    join(dir, "price.test.ts"),
    'import { expect, test } from "bun:test"\nimport { discounted } from "./price.ts"\n\ntest("a 20% discount on 50 is 40", () => {\n  expect(discounted(50, 20)).toBe(40)\n})\n',
  )
}

function parseArgs(argv: string[]) {
  const options = {
    setup: null as string | null,
    workspace: null as string | null,
    load: null as string | null,
    model: null as string | null,
    effort: null as string | null,
    cancelOnCommand: null as number | null,
    maxRequests: 12,
    raw: false,
    prompt: null as string | null,
  }
  const words: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    if (arg === "--setup") options.setup = value()
    else if (arg === "--workspace") options.workspace = realpathSync(value())
    else if (arg === "--load") options.load = value()
    else if (arg === "--model") options.model = value()
    else if (arg === "--effort") options.effort = value()
    else if (arg === "--cancel-on-command") options.cancelOnCommand = Number(value())
    else if (arg === "--max-requests") options.maxRequests = Number(value())
    else if (arg === "--raw") options.raw = true
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}; see the comment at the top of ${import.meta.file}`)
    else words.push(arg)
  }
  options.prompt = words.length === 0 ? null : words.join(" ")
  return options
}

