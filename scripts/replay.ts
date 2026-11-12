/**
 * Replays a recorded session against a changed prompt and prints where the
 * model's behaviour changes. The real model is called; every tool call that
 * is on the recording is answered from the recording, so nothing runs while
 * the model does what it did. See docs/replay.md.
 *
 *   bun scripts/replay.ts <session-id> [--system-prompt <file>] [--tool-description <tool>=<file>]...
 *                         [--model <m>] [--effort <e>] [--policy stop|execute-read-only|execute]
 *                         [--strict] [--json] [--through <seq>] [--workspace <dir>] [--data-dir <dir>]
 *
 * With nothing changed it shows how the model itself varies: run it a few
 * times to learn the noise floor before reading anything into a change
 * (`bun evals/replay-suite.ts` measures it over a set of recordings).
 *
 * Exit code: 0 when the replay ran (identical or diverged), 1 when it could
 * not be compared (unsupported, incomplete), 2 for a usage error.
 */
import { join } from "node:path"
import { parseArgs } from "node:util"
import { createHarness } from "../packages/core/src/assembly.ts"
import { brand } from "../packages/core/src/brand.ts"
import { EngineError } from "../packages/core/src/engine/engine.ts"
import type { ReplayRequest } from "../packages/core/src/engine/replay.ts"
import { DEFAULT_NORMALISERS } from "../packages/core/src/engine/replay.ts"
import { compareReplay, renderComparison } from "../packages/core/src/replay/effects.ts"
import { renderReport } from "../packages/core/src/replay/report.ts"
import { openSnapshots } from "../packages/core/src/snapshot/index.ts"

const USAGE = `usage: bun scripts/replay.ts <session-id> [--system-prompt <file>] [--tool-description <tool>=<file>]... [--model <m>] [--effort <e>] [--policy stop|execute-read-only|execute] [--strict] [--json] [--through <seq>] [--workspace <dir>] [--data-dir <dir>]`
const POLICIES = ["stop", "execute-read-only", "execute"] as const

/** The replay request a command line asks for, or a usage problem. Shared with the suite runner. */
export async function replayRequest(values: {
  readonly "system-prompt"?: string
  readonly "tool-description"?: readonly string[]
  readonly model?: string
  readonly effort?: string
  readonly policy?: string
  readonly strict?: boolean
  readonly through?: string
  readonly workspace?: string
}): Promise<ReplayRequest | string> {
  const policy = values.policy ?? "stop"
  if (!POLICIES.includes(policy as (typeof POLICIES)[number])) return `--policy is one of ${POLICIES.join(", ")}`
  const descriptions: Record<string, string> = {}
  for (const entry of values["tool-description"] ?? []) {
    const at = entry.indexOf("=")
    if (at <= 0 || at === entry.length - 1) return `--tool-description takes <tool>=<file>, not ${entry}`
    const file = Bun.file(entry.slice(at + 1))
    if (!(await file.exists())) return `${entry.slice(at + 1)} does not exist`
    descriptions[entry.slice(0, at)] = (await file.text()).trim()
  }
  let systemPrompt: string | undefined
  if (values["system-prompt"] !== undefined) {
    const file = Bun.file(values["system-prompt"])
    if (!(await file.exists())) return `${values["system-prompt"]} does not exist`
    systemPrompt = await file.text()
  }
  if (values.through !== undefined && !/^[1-9]\d*$/.test(values.through)) return "--through takes an event number"
  return {
    policy: policy as (typeof POLICIES)[number],
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(Object.keys(descriptions).length === 0 ? {} : { toolDescriptions: descriptions }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.effort === undefined ? {} : { effort: values.effort === "default" ? null : values.effort }),
    ...(values.strict === true ? { strict: true } : {}),
    ...(values.through === undefined ? {} : { throughSeq: Number(values.through) }),
    ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
  }
}

/**
 * A snapshot of the copy a replay ended in, taken now. The replay's own log
 * can miss what the step in which it left its recording changed (that step
 * started on the tape, so it was not bracketed by snapshots), so the files
 * it ended with are read from the copy itself. `null` without snapshots.
 */
export async function snapshotOfCopy(copy: string, dataDir: string, session: string): Promise<string | null> {
  const snapshots = await openSnapshots(copy, { dataDir: join(dataDir, "snapshots") })
  if (snapshots.kind !== "ready") return null
  return (await snapshots.take({ session }).catch(() => null))?.id ?? null
}

export const REPLAY_FLAGS = {
  "system-prompt": { type: "string" },
  "tool-description": { type: "string", multiple: true },
  model: { type: "string" },
  effort: { type: "string" },
  policy: { type: "string" },
  strict: { type: "boolean" },
  through: { type: "string" },
  workspace: { type: "string" },
} as const

async function main(argv: readonly string[]): Promise<number> {
  const parsed = (() => {
    try {
      return parseArgs({ args: [...argv], allowPositionals: true, options: { ...REPLAY_FLAGS, json: { type: "boolean" }, "data-dir": { type: "string" }, help: { type: "boolean" } } })
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()
  if (typeof parsed === "string" || parsed.values.help === true || parsed.positionals.length !== 1) {
    console.error(typeof parsed === "string" ? `${parsed}\n${USAGE}` : USAGE)
    return 2
  }
  const request = await replayRequest(parsed.values)
  if (typeof request === "string") {
    console.error(`${request}\n${USAGE}`)
    return 2
  }
  const harness = createHarness(parsed.values["data-dir"] === undefined ? {} : { dataDir: parsed.values["data-dir"] })
  try {
    const signedIn = await harness.signIn()
    if (!signedIn.signedIn) {
      console.error(`${brand.binary}: ${signedIn.message}`)
      return 1
    }
    const sourceId = harness.engine.resolveSession(parsed.positionals[0]!)
    const run = await harness.engine.replaySession(sourceId, request)
    // A second Ctrl-C is the shell's; the first ends the replay cleanly, as incomplete.
    process.once("SIGINT", () => run.session.interrupt())
    const outcome = await run.done
    await run.session.settled()
    // Reads ignored: the side effects and the files it ended with, which is what the noise floor leaves readable.
    const replayFinal = outcome.workspace === null ? undefined : await snapshotOfCopy(outcome.workspace, harness.dataDir, outcome.sessionId)
    const compared = compareReplay(harness.engine.readEvents(sourceId), harness.engine.readEvents(outcome.sessionId), outcome.report, { normalisers: DEFAULT_NORMALISERS, ...(replayFinal === undefined ? {} : { replayFinal }) })
    if (parsed.values.json === true)
      console.log(JSON.stringify({ sourceSessionId: sourceId, replaySessionId: outcome.sessionId, policy: request.policy, workspace: outcome.workspace, requests: outcome.requests, usage: outcome.usage, report: outcome.report, compared }, null, 2))
    else {
      console.log(renderReport(outcome.report))
      console.log("")
      console.log(renderComparison(compared))
      console.log("")
      console.log(`  replay session  ${outcome.sessionId}  (${outcome.requests} model call${outcome.requests === 1 ? "" : "s"}${outcome.usage === null ? "" : `, ${outcome.usage.inputTokens} tokens in of which ${outcome.usage.cachedInputTokens} cached, ${outcome.usage.outputTokens} out`})`)
      if (outcome.workspace !== null) console.log(`  workspace       ${outcome.workspace}  (the copy the replay carried on in; delete it when you are done)`)
    }
    return outcome.report.status === "identical" || outcome.report.status === "diverged" ? 0 : 1
  } catch (error) {
    console.error(`${brand.binary}: ${error instanceof EngineError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return 1
  } finally {
    await harness.close()
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
