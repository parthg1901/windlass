/**
 * Scripted sessions for the trace tests, written into a real store the way
 * the step loop writes them: every event goes through `append`, and at each
 * event that starts a model call the request is built from the stored state,
 * its block hashes go into the ledger with `beginRequest`, and the call is
 * finished with usage from a stand-in for the provider's prompt cache.
 *
 * The stand-in caches like the Responses API on the ChatGPT flow: a request
 * reads the longest leading run of blocks it shares with the previous request
 * of the session, in 128-token steps, once that previous prompt was at least
 * 1024 tokens. So a session that never rewrites its prefix hits on every call
 * after the first, and a break shows up as a miss, as it would live.
 */
import { HARNESS_ORIGIN, type NewEvent, event } from "../../src/event/durable.ts"
import { renderWatchFired } from "../../src/engine/spawn.ts"
import type { CallId, MessageId, RequestId, SessionId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import type { Projection } from "../../src/message/message.ts"
import { blobRefs, encodeRequest } from "../../src/provider/openai-responses-encode.ts"
import { makeProviderError } from "../../src/provider/error.ts"
import { type BuildOptions, buildCompactionRequest, buildRequest } from "../../src/request/build.ts"
import { type BlockHash, hashRequest } from "../../src/request/prefix.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { type SqliteStore, openSqliteStore } from "../../src/store/sqlite.ts"
import type { RequestRecord } from "../../src/store/store.ts"
import {
  baselineSet,
  called,
  compactionEnded,
  compactionStarted,
  created,
  deliver,
  enqueue,
  executionFailed,
  executionInterrupted,
  executionStarted,
  executionSucceeded,
  instruction,
  interruptRequested,
  reasoningEnded,
  retryScheduled,
  reverted,
  settingsChanged,
  settled,
  started,
  stepEnded,
  stepFailed,
  stepStarted,
  synthetic,
  textEnded,
} from "../store/scripted.ts"

/** What callers used to tell the exporter. The log stores each compaction's prompt now, and this one is deliberately another. */
export const COMPACTION_PROMPT = "Summarise the conversation so far so that the work can continue from the summary alone."

/** Builds a step request from a projection. The real builder unless a test seeds a bug. */
export type StepBuilder = (projection: Projection, options: BuildOptions) => ModelRequest

export const realBuilder: StepBuilder = buildRequest

/** Starts at 2026-11-11T10:00:00Z and moves 1.5 s per reading, so calls are seconds apart, well inside the cache TTL. */
export function fixedClock() {
  let now = Date.UTC(2026, 10, 11, 10, 0, 0)
  return () => (now += 1500)
}

export function openTestStore(path = ":memory:"): SqliteStore {
  return openSqliteStore({ path, now: fixedClock() })
}

const m = (id: string) => id as MessageId

export class Loop {
  private calls = 0
  /** What went over the wire for each call, as the provider encoder wrote it: what a recording proxy would have seen. */
  readonly sent: { readonly row: RequestRecord; readonly body: Record<string, Json>; readonly headers: Readonly<Record<string, string>> }[] = []
  private previous: { blocks: readonly BlockHash[]; prompt: number } | null = null

  constructor(
    readonly store: SqliteStore,
    readonly id: SessionId,
    readonly builder: StepBuilder = realBuilder,
  ) {}

  add(...events: NewEvent[]) {
    for (const next of events) this.store.append(this.id, [next])
  }

  get projection(): Projection {
    const projection = this.store.getProjection(this.id)
    if (projection === null) throw new Error(`session ${this.id} does not exist`)
    return projection
  }

  seqOf(messageId: string): number {
    const found = this.projection.messages.findLast((message) => message.id === messageId)
    if (found === undefined) throw new Error(`no message ${messageId}`)
    return found.seq
  }

  /** One model call, built from the state now stored, recorded in the ledger as the loop records it. */
  call(messageId: string, attempt: number, outcome: "ok" | "error" | "aborted" = "ok", purpose: "step" | "compaction" = "step") {
    const request =
      purpose === "compaction" ? buildCompactionRequest(this.projection, {}, m(messageId)) : this.builder(this.projection, { toolChoice: "auto" })
    const blocks = hashRequest(request)
    const id = `${this.id}_r${++this.calls}` as RequestId
    this.store.beginRequest({ id, sessionId: this.id, messageId: m(messageId), attempt, purpose, model: request.params.model, provider: "fake", blocks })
    const blobs = new Map(blobRefs(request).map((ref) => [ref.hash, this.store.getBlob(ref.hash)!.bytes] as const))
    const encoded = encodeRequest(request, blobs)
    const usage = outcome === "ok" ? this.provider(blocks) : null
    const row = this.store.finishRequest(id, { outcome, usage, errorKind: outcome === "error" ? "transport" : null })
    this.sent.push({ row, body: JSON.parse(encoded.body), headers: encoded.headers })
  }

  /** `step.started`, then the call. */
  start(messageId: string, attempt = 1, model = "gpt-test") {
    this.add(stepStarted(messageId, attempt, model))
    this.call(messageId, attempt)
  }

  /** A prompt admitted, an execution started and the prompt delivered. */
  prompt(n: string, value: string) {
    this.add(enqueue(`u${n}`, value), executionStarted(`exe_${n}`), deliver(`u${n}`))
  }

  /** A one-step answer that ends the execution. */
  answer(n: string, id: string, value: string, model = "gpt-test") {
    this.start(id, 1, model)
    this.add(textEnded(id, value), stepEnded(id), executionSucceeded(`exe_${n}`))
  }

  /** One read call, settled. */
  read(id: string, callId: string, path: string, output: string) {
    this.add(called(id, callId, "read", JSON.stringify({ path })), started(id, callId), settled(id, callId, "success", output))
  }

  /** The stand-in for the provider's implicit prompt cache. */
  private provider(blocks: readonly BlockHash[]) {
    const tokens = blocks.map((block) => Math.ceil(block.bytes / 4) + (block.kind === "instructions" ? 1200 : 0))
    const prompt = tokens.reduce((sum, value) => sum + value, 0)
    const previous = this.previous
    this.previous = { blocks, prompt }
    if (previous === null || previous.prompt < 1024) return { inputTokens: prompt, cachedInputTokens: 0, outputTokens: 40, reasoningTokens: 8 }
    const shared = blocks.findIndex((block, index) => previous.blocks[index]?.hash !== block.hash)
    const common = tokens.slice(0, shared === -1 ? blocks.length : shared).reduce((sum, value) => sum + value, 0)
    const cached = Math.floor(Math.min(common, previous.prompt) / 128) * 128
    return { inputTokens: prompt, cachedInputTokens: cached, outputTokens: 40, reasoningTokens: 8 }
  }
}

/**
 * A scripted session: what it does, and which calls (0-based ledger order)
 * follow a legitimate prefix break, with the causes.
 */
export interface TraceScript {
  readonly name: string
  /** True when nothing in it may break the prefix: the report must name no harness-caused miss. */
  readonly clean: boolean
  readonly breaks: Readonly<Record<number, readonly string[]>>
  /** The reasons the records declare, by 0-based record. */
  readonly intentional: Readonly<Record<number, readonly string[]>>
  /**
   * The declared breaks `prefixlens report` must show as intentional, by
   * 0-based record, when that is not all of `intentional`: a report lists a
   * declared break only where a miss followed, and a summary request that
   * leaves a tail out reads everything it shares with the request before it.
   */
  readonly reported?: Readonly<Record<number, readonly string[]>>
  readonly run: (loop: Loop) => void
}

/**
 * A pasted source file of about 500 tokens. A revert or refusal that removes
 * only a few short messages loses no 128-token cache step, so prefixlens
 * would rightly see a hit and nothing to excuse; the removed part carries one
 * of these so the break costs cached tokens, as it would live.
 */
const pasted = (name: string) =>
  `${name}:\n${Array.from({ length: 40 }, (_, index) => `export const flag${index} = parseFlag("--flag-${index}")`).join("\n")}`

const opening = (loop: Loop) => loop.add(created("/work/demo", "Demo"), baselineSet())

export const SCRIPTS: readonly TraceScript[] = [
  {
    name: "multi-step turns",
    clean: true,
    breaks: {},
    intentional: {},
    run(loop) {
      opening(loop)
      loop.prompt("1", "Why does the build fail?")
      loop.start("a1")
      loop.add(reasoningEnded("a1", "Read the config first."), textEnded("a1", "Let me look at the config."))
      loop.read("a1", "call_1", "tsconfig.json", '{"strict": true}')
      loop.add(stepEnded("a1", "tool_calls"))
      loop.start("a2")
      loop.read("a2", "call_2", "src/main.ts", "export const x: number = 'a'")
      loop.add(stepEnded("a2", "tool_calls"))
      loop.start("a3")
      loop.add(textEnded("a3", "`x` is declared as a number but holds a string."), stepEnded("a3"), executionSucceeded("exe_1"))
      loop.prompt("2", "Fix it.")
      loop.answer("2", "a4", "Changed the value to 1.")
    },
  },
  {
    name: "parallel tool calls with media",
    clean: true,
    breaks: {},
    intentional: {},
    run(loop) {
      const image = loop.store.putBlob(new TextEncoder().encode("\x89PNG synthetic screenshot"), "image/png")
      opening(loop)
      loop.add(
        enqueue("u1", [
          { type: "text", text: "Why does this page look broken?" },
          { type: "media", blob: image },
        ]),
        executionStarted("exe_1"),
        deliver("u1"),
      )
      loop.start("a1")
      loop.add(
        called("a1", "call_1", "read", '{"path":"index.html"}'),
        called("a1", "call_2", "read", '{"path":"style.css"}'),
        started("a1", "call_1"),
        started("a1", "call_2"),
        settled("a1", "call_2", "success", "body { display: flex }"),
        settled("a1", "call_1", "success", "<html>...</html>", [image]),
        stepEnded("a1", "tool_calls"),
      )
      // The provider reuses call_1 in the next step; one call is refused before it starts.
      loop.start("a2")
      loop.add(
        called("a2", "call_1", "shell", '{"cmd":"npm test"}'),
        called("a2", "call_3", "shell", '{"cmd":"rm -rf /"}'),
        settled("a2", "call_3", "error", "Refused: this command is not allowed in this mode."),
        started("a2", "call_1", "exec"),
        settled("a2", "call_1", "error", "1 test failed"),
        stepEnded("a2", "tool_calls"),
      )
      loop.start("a3")
      loop.add(textEnded("a3", "The flex rule hides the header."), stepEnded("a3"), executionSucceeded("exe_1"))
    },
  },
  {
    name: "retries before and after output",
    clean: true,
    breaks: {},
    intentional: {},
    run(loop) {
      opening(loop)
      loop.prompt("1", "Summarise the README.")
      // Attempt 1 fails before any output; attempt 2 continues under the same message.
      loop.add(stepStarted("a1"))
      loop.call("a1", 1, "error")
      loop.add(retryScheduled("a1", 2))
      loop.call("a1", 2)
      loop.read("a1", "call_1", "README.md", "# Demo\nPrints the weather.")
      loop.add(stepEnded("a1", "tool_calls"))
      // The next step fails after partial text: it fails, a continuation note follows, attempt 2 runs under a new message.
      loop.start("a2")
      loop.add(
        textEnded("a2", "The README says the tool"),
        stepFailed("a2", { kind: "provider", error: makeProviderError("transport", "socket closed") }),
        retryScheduled("a2", 2),
        synthetic(
          "n1",
          HARNESS_ORIGIN.continuation,
          "Your previous response was cut off by a provider error. Continue exactly where it stopped; do not repeat what you already wrote.",
        ),
      )
      loop.start("a3", 2)
      loop.add(textEnded("a3", " prints the weather."), stepEnded("a3"), executionSucceeded("exe_1"))
    },
  },
  {
    name: "user interrupt",
    clean: true,
    breaks: {},
    intentional: {},
    run(loop) {
      opening(loop)
      loop.prompt("1", "Where is the parser?")
      loop.answer("1", "a1", "In src/parse.ts.")
      loop.prompt("2", "Refactor it.")
      // The cancel arrives mid-stream: the call ends aborted without usage, the partial text is kept.
      loop.add(stepStarted("a2"))
      loop.call("a2", 1, "aborted")
      loop.add(
        interruptRequested("exe_2", "user"),
        textEnded("a2", "I will start with the tokenizer and"),
        stepFailed("a2", { kind: "interrupted", reason: "user" }),
        synthetic("k1", HARNESS_ORIGIN.interrupt, "The user stopped the previous response before it finished."),
        executionInterrupted("exe_2", "user"),
      )
      loop.prompt("3", "Only the tokenizer, please.")
      loop.answer("3", "a3", "Done: the tokenizer is its own module now.")
    },
  },
  {
    name: "steer during a step",
    clean: true,
    breaks: {},
    intentional: {},
    run(loop) {
      opening(loop)
      loop.prompt("1", "Run the tests.")
      loop.start("a1")
      loop.add(called("a1", "call_1", "shell", '{"cmd":"bun test"}'), started("a1", "call_1", "exec"))
      loop.add(enqueue("u2", "Only the unit tests."))
      loop.add(settled("a1", "call_1", "success", "12 pass"), stepEnded("a1", "tool_calls"), deliver("u2"))
      loop.start("a2")
      loop.add(textEnded("a2", "The unit tests pass."), stepEnded("a2"), executionSucceeded("exe_1"))
    },
  },
  {
    name: "instruction change",
    clean: true,
    breaks: {},
    intentional: {},
    run(loop) {
      opening(loop)
      loop.prompt("1", "What day is it?")
      loop.answer("1", "a1", "Tuesday.")
      loop.add(enqueue("u2", "And now?"), executionStarted("exe_2"), instruction("i1", "date", "Today is Wednesday."), deliver("u2"))
      loop.answer("2", "a2", "Wednesday.")
    },
  },
  {
    // What changes during a session without ever being in the baseline: the skill index (given, replaced,
    // withdrawn), the MCP catalogue of a server that connected late, and a wake-up's firing admitted under its own
    // ID. Each is an appended message, so every request extends the one before.
    name: "skills, an MCP catalogue and a wake-up appended",
    clean: true,
    breaks: {},
    intentional: {},
    run(loop) {
      opening(loop)
      loop.add(enqueue("u1", "Which skills do you have?"), executionStarted("exe_1"), instruction("i1", "skills", "Skills you can load:\n- release: How to cut a release."), deliver("u1"))
      loop.start("a1")
      loop.read("a1", "call_1", "RELEASING.md", "Tag, then push the tag.")
      loop.add(stepEnded("a1", "tool_calls"))
      // The server connected while the tool ran; a skill was edited.
      loop.add(
        instruction("i2", "skills", "The skills have changed. This list replaces the one you were given before:\n- release: How to cut a release, step by step."),
        instruction("i3", "mcp", "MCP tools are available:\nfx (1 tool):\n- echo: Echo the text back."),
      )
      loop.start("a2")
      loop.add(textEnded("a2", "One skill, release, and one MCP tool."), stepEnded("a2"), executionSucceeded("exe_1"))
      // Idle. A wake-up fires: admitted under its own ID, it starts a turn; the skill is gone by then.
      loop.add(
        enqueue("msg_wk_5c3a9e21b7d4_1", "[Wake-up wk_5c3a9e21b7d4 · after 5m]\nLook at the build.", "queue", "wake"),
        executionStarted("exe_2"),
        event("instruction.appended", { messageId: "i4" as MessageId, source: "skills", text: "There are no skills any more. Disregard the list of skills you were given before.", fingerprint: null }),
        deliver("msg_wk_5c3a9e21b7d4_1"),
      )
      loop.answer("2", "a3", "The build is green.")
    },
  },
  {
    // One call stopped by itself, and a watch on a background command's output. The request to stop is a fact
    // about the call and never part of a request: the model reads the call's result. A watch tells the model
    // nothing until it fires, and a firing is an appended message. Every request extends the one before.
    name: "a call stopped by the user and a watch that fires",
    clean: true,
    breaks: {},
    intentional: {},
    run(loop) {
      const watch = { pattern: "listening on", regex: false, ignoreCase: false }
      const line = "Server listening on http://localhost:3000"
      opening(loop)
      loop.prompt("1", "Start the dev server and run the tests.")
      loop.start("a1")
      loop.add(
        called("a1", "call_1", "shell", '{"command":"bun run dev","background":true}'),
        called("a1", "call_2", "shell", '{"command":"bun test"}'),
        started("a1", "call_1", "exec"),
        event("spawn.started", { spawnId: "bg_1", messageId: m("a1"), callId: "call_1" as CallId, background: true, work: { kind: "command", command: "bun run dev", logPath: null } }),
        settled("a1", "call_1", "success", "Started in the background as bg_1."),
        started("a1", "call_2", "exec"),
        // The user sets a watch while the turn runs, and stops the test run that hangs.
        event("watch.started", { watchId: "bg_1.w1", spawnId: "bg_1", ...watch, limit: 1 }),
        event("tool.cancel_requested", { messageId: m("a1"), callId: "call_2" as CallId }),
        settled("a1", "call_2", "error", "12 pass\n[Stopped by the user. The command and its child processes were stopped; the output above is everything it printed before that.]"),
        stepEnded("a1", "tool_calls"),
      )
      loop.start("a2")
      loop.add(textEnded("a2", "The server is starting. You stopped the test run after 12 tests."), stepEnded("a2"), executionSucceeded("exe_1"))
      // Idle. The server prints the line: the message and the record of the firing are one append, and it starts a turn.
      loop.store.append(loop.id, [
        enqueue("s1", renderWatchFired("bg_1", { command: "bun run dev", watch, firing: 1, limit: 1, line }), "steer", HARNESS_ORIGIN.backgroundWatch),
        event("watch.fired", { watchId: "bg_1.w1", spawnId: "bg_1", firing: 1, line, messageId: m("s1") }),
      ])
      loop.add(executionStarted("exe_2"), deliver("s1"))
      loop.answer("2", "a3", "The server is up on port 3000.")
    },
  },
  {
    name: "compaction",
    clean: false,
    // Call 0 and 1 are the two turns, 2 is the compaction call (nothing is kept, so it extends call 1), 3 follows the compaction.
    breaks: { 3: ["compaction"] },
    intentional: { 3: ["compaction"] },
    run(loop) {
      opening(loop)
      loop.prompt("1", "Fix the README.")
      loop.answer("1", "a1", "Fixed the typo in the README.")
      loop.prompt("2", "Run the tests.")
      loop.answer("2", "a2", "The tests pass.")
      loop.add(enqueue("u3", "Now update the changelog."), executionStarted("exe_3"))
      loop.add(compactionStarted("c1", loop.projection.lastSeq + 1))
      loop.call("c1", 1, "ok", "compaction")
      loop.add(compactionEnded("c1"))
      // A new baseline after the compaction, with the instructions re-read.
      loop.add(baselineSet("You are a coding agent working in /work/demo. The changelog is CHANGES.md."))
      loop.add(deliver("u3"))
      loop.answer("3", "a3", "Added an entry to CHANGES.md.")
    },
  },
  {
    // A compaction in the middle of a turn that keeps the turn's last two steps, whose first summary is rejected
    // and repaired. Calls 0 to 2 are the steps; 3 is the summary request, which fails in transport and has no
    // record; 4 is the same request again, which leaves the kept steps out and says so; 5 is the repair, which
    // extends it; 6 follows the compaction. (Keeping only the last step would need no declaration: the summary
    // request is then the last step's own request plus the prompt.)
    name: "compaction with a kept tail and a repair",
    clean: false,
    breaks: { 6: ["compaction"] },
    intentional: { 3: ["compaction"], 5: ["compaction"] },
    reported: { 5: ["compaction"] },
    run(loop) {
      opening(loop)
      loop.add(enqueue("u1", `Find where the port is set. ${pasted("server.ts")}`), executionStarted("exe_1"), deliver("u1"))
      loop.start("a1")
      loop.read("a1", "call_1", "server.ts", pasted("server.ts"))
      loop.add(stepEnded("a1", "tool_calls"))
      loop.start("a2")
      loop.read("a2", "call_1", "config.ts", pasted("config.ts"))
      loop.add(stepEnded("a2", "tool_calls"))
      loop.start("a3")
      loop.read("a3", "call_1", "env.ts", pasted("env.ts"))
      loop.add(stepEnded("a3", "tool_calls"))
      // The cut is before the second step: the last two steps stay word for word.
      loop.add(compactionStarted("c1", loop.seqOf("a2")))
      loop.call("c1", 1, "error", "compaction")
      loop.call("c1", 2, "ok", "compaction")
      loop.add(event("compaction.repair_requested", { messageId: "c1" as MessageId, attempt: 3, answer: "The port is set in config.ts.", prompt: "That summary does not have the required form." }))
      loop.call("c1", 3, "ok", "compaction")
      loop.add(event("compaction.ended", { messageId: "c1" as MessageId, summary: "Checkpoint: the port is set in config.ts.", source: "repaired", detail: null, tokensAfter: 0, usage: null }))
      loop.add(baselineSet())
      loop.start("a4")
      loop.add(textEnded("a4", "The port comes from env.ts."), stepEnded("a4"), executionSucceeded("exe_1"))
    },
  },
  {
    // A compaction in the middle of a turn that read four screenshots. It keeps the last three steps: the first
    // step's image is gone with the step (the checkpoint names it), the oldest kept result keeps its text and loses
    // its image, and the two most recent keep theirs. Calls 0 to 3 are the steps; 4 is the summary request, which
    // leaves the kept steps out and says so; 5 follows the compaction; 6 and 7 extend it: nothing about the images
    // changes after the compaction, so the turn's answer and the next turn read the whole prefix from the cache.
    name: "compaction that retires an old image",
    clean: false,
    breaks: { 5: ["compaction"] },
    intentional: { 4: ["compaction"], 5: ["compaction"] },
    reported: { 5: ["compaction"] },
    run(loop) {
      const shot = (name: string) => loop.store.putBlob(new TextEncoder().encode(`\x89PNG synthetic screenshot ${name}`), "image/png")
      const shows = (id: string, name: string) => {
        loop.start(id)
        loop.add(
          called(id, "call_1", "read", JSON.stringify({ path: `${name}.png` })),
          started(id, "call_1"),
          settled(id, "call_1", "success", `${name}.png: PNG image (image/png), 640x480 pixels, 2048 bytes, attached.`, [shot(name)]),
          stepEnded(id, "tool_calls"),
        )
      }
      opening(loop)
      loop.add(enqueue("u1", `Compare the four screenshots with this stylesheet. ${pasted("style.css")}`), executionStarted("exe_1"), deliver("u1"))
      shows("a1", "one")
      shows("a2", "two")
      shows("a3", "three")
      shows("a4", "four")
      loop.add(compactionStarted("c1", loop.seqOf("a2")))
      loop.call("c1", 1, "ok", "compaction")
      loop.add(
        event("compaction.ended", {
          messageId: "c1" as MessageId,
          summary: "Checkpoint: one.png matches the stylesheet.\n\n## Images you were shown earlier (no longer attached)\n- one.png (image/png, 640x480 pixels, 2048 bytes), read at seq 5",
          source: "model",
          detail: null,
          tokensAfter: 0,
          usage: null,
          calls: 1,
          retired: [
            {
              messageId: "a2" as MessageId,
              callId: "call_1" as CallId,
              images: 1,
              note: "\n[The image of this result is no longer attached: it was taken out of the conversation when it was compacted, to save context. To see it again, read two.png again.]",
            },
          ],
        }),
      )
      loop.add(baselineSet())
      loop.start("a5")
      loop.add(textEnded("a5", "The fourth has the dialog open; the others differ in the header."), stepEnded("a5"), executionSucceeded("exe_1"))
      loop.prompt("2", "Which one has the dialog?")
      loop.answer("2", "a6", "four.png.")
    },
  },
  {
    name: "refusal",
    clean: false,
    breaks: { 3: ["refusal"] },
    intentional: { 3: ["refusal"] },
    run(loop) {
      opening(loop)
      loop.prompt("1", "Summarise a.ts.")
      loop.answer("1", "a1", "It exports a.")
      loop.prompt("2", "Now do the thing the filter dislikes.")
      loop.start("a2")
      loop.read("a2", "call_1", "b.txt", pasted("b.txt"))
      loop.add(stepEnded("a2", "tool_calls"))
      loop.start("a3")
      loop.add(
        event("step.refused", { messageId: m("a3"), message: "I can't help with that.", excludeFromSeq: loop.seqOf("u2"), usage: null }),
        executionFailed("exe_2", "The provider refused the request."),
      )
      loop.prompt("3", "What does a.ts export?")
      loop.answer("3", "a4", "a.")
    },
  },
  {
    name: "revert",
    clean: false,
    breaks: { 2: ["revert"] },
    intentional: { 2: ["revert"] },
    run(loop) {
      opening(loop)
      loop.prompt("1", "Add a --verbose flag.")
      loop.answer("1", "a1", "Added --verbose.")
      loop.prompt("2", `Also add --quiet. ${pasted("cli.ts")}`)
      loop.answer("2", "a2", "Added --quiet.")
      loop.add(reverted(loop.seqOf("u2")))
      loop.prompt("3", "Make --verbose print timings.")
      loop.answer("3", "a3", "--verbose now prints timings.")
    },
  },
  {
    name: "settings changes",
    clean: false,
    breaks: { 1: ["settings"], 2: ["settings"] },
    intentional: { 1: ["model_switch"], 2: ["settings_change"] },
    run(loop) {
      opening(loop)
      loop.prompt("1", "Plan the migration.")
      loop.answer("1", "a1", "Three steps: schema, data, cleanup.")
      loop.add(settingsChanged("gpt-other"))
      loop.prompt("2", "Write step one.")
      loop.answer("2", "a2", "Here is the schema change.", "gpt-other")
      loop.add(settingsChanged("gpt-other", "high"))
      loop.prompt("3", "Check it.")
      loop.answer("3", "a3", "It is correct.", "gpt-other")
    },
  },
  {
    // A revert past every user message, then an instruction change: the next input starts with a developer
    // message, which the trace counts as a system block. The second revert removes it.
    name: "revert to the start",
    clean: false,
    breaks: { 1: ["revert"], 2: ["revert"] },
    intentional: { 1: ["revert"], 2: ["revert"] },
    run(loop) {
      opening(loop)
      loop.prompt("1", `Rename the package. ${pasted("package.ts")}`)
      loop.answer("1", "a1", "Renamed it to demo-cli.")
      loop.add(reverted(loop.seqOf("u1")))
      loop.add(enqueue("u2", `Rename it to demo-tool. ${pasted("package.ts")}`), executionStarted("exe_2"), instruction("i1", "date", "Today is Wednesday."), deliver("u2"))
      loop.answer("2", "a2", "Renamed it to demo-tool.")
      loop.add(reverted(loop.seqOf("i1")))
      loop.prompt("3", `Leave the name as it is, and check this file instead. ${pasted("cli.ts")}`)
      loop.answer("3", "a3", "Left it unchanged.")
    },
  },
]

/** Runs a script on a store under its own session ID. */
export function record(store: SqliteStore, script: TraceScript, builder?: StepBuilder) {
  const loop = new Loop(store, `ses_${script.name.replace(/[^a-z]+/g, "_")}` as SessionId, builder)
  script.run(loop)
  return loop
}
