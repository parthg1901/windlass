/**
 * In the real `App`: `/wakeups add` sets a wake-up of the user's own. Each
 * kind is asked of the engine as typed; a check's command is put in a
 * dialog first, and the answer is the access it runs with; a webhook's
 * address and secret are shown once; what the engine refuses is its sentence.
 */
import { afterEach, expect, test } from "bun:test"
import type { WakeCreateParams, WakeCreateResult } from "@windlass/acp/extensions"
import { flat } from "./builders.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

async function open() {
  const backend = new ScriptBackend()
  mounted = await mount({ width: 170, height: 46, backend })
  const session = backend.session!
  const asked: Omit<WakeCreateParams, "sessionId">[] = []
  session.wakeups = async () => ({ sessionId: "ses_script", available: true, running: true, wakeups: [] })
  session.createWake = async (params): Promise<WakeCreateResult> => {
    asked.push(params)
    if (params.trigger.kind === "every" && params.trigger.intervalMs < 60_000) return { created: false, message: "The interval must be from 60 seconds to 30 days.", wake: null, url: null, secret: null, running: true }
    const id = `wk_${asked.length}`
    const webhook = params.trigger.kind === "webhook"
    return {
      created: true,
      message: `Created wake-up ${id}.`,
      wake: { id, trigger: params.trigger.kind === "after" ? "at" : params.trigger.kind, description: `${params.trigger.kind} as asked`, state: "pending", nextAt: null, fired: 0, maxFirings: 1, author: "user", message: params.message, url: webhook ? `http://127.0.0.1:8787/w/${id}` : null, lines: [`Message: ${params.message}`] },
      url: webhook ? `http://127.0.0.1:8787/w/${id}` : null,
      secret: webhook ? "whsec_example_only" : null,
      running: true,
    }
  }
  return { session, asked }
}

async function run(entry: string): Promise<string> {
  await mounted!.setup.mockInput.typeText(entry)
  mounted!.setup.mockInput.pressEnter()
  await mounted!.settle()
  return flat(await mounted!.frame())
}

test("a delay, an interval and a webhook are asked of the engine as typed; the secret is shown once; a refusal is the engine's sentence", async () => {
  const { asked } = await open()
  expect(await run("/wakeups add")).toContain("Set a wake-up of your own: the agent is told the message when it fires, as a new turn.")
  const set = await run("/wakeups add in 20m look at the deploy again")
  expect(asked).toEqual([{ message: "look at the deploy again", trigger: { kind: "after", delayMs: 20 * 60_000 } }])
  expect(set).toContain("Wake-up wk_1 set: after as asked")
  expect(set).toContain("/wakeups lists it; /wakeups cancel wk_1 stops it.")
  expect(await run("/wakeups add every 5s too often")).toContain("The interval must be from 60 seconds to 30 days.")
  const hook = await run("/wakeups add webhook the deploy finished")
  expect(hook).toContain("Webhook wake-up created wk_3")
  expect(hook).toContain("secret whsec_example_only")
  expect(hook.match(/whsec_example_only/g)).toHaveLength(1)
  expect(await run("/wakeups add at 25:00 x")).toContain('/wakeups add at needs a time first: 17:30, or a date and time such as 2026-11-13T09:00 ("25:00" is neither).')
  expect(asked).toHaveLength(3)
})

test("a check's command is asked about before anything is set up: the answer is the access it runs with, and declining sets nothing up", async () => {
  const { asked } = await open()
  const question = await run('/wakeups add check 5m "gh run view 123 --exit-status" CI is green')
  expect(question).toContain("Run this command every 5m until it exits 0?")
  expect(question).toContain("gh run view 123 --exit-status")
  expect(question).toContain("Run it in the sandbox, with network")
  expect(asked).toEqual([])
  mounted!.setup.mockInput.pressKey("w")
  await mounted!.settle()
  expect(asked).toEqual([{ message: "CI is green", trigger: { kind: "check", command: "gh run view 123 --exit-status", intervalMs: 300_000, fire: "until" }, run: { kind: "sandboxed", network: true, writableRoots: [] } }])
  expect(flat(await mounted!.frame())).toContain("Wake-up wk_1 set: check as asked")
  await run('/wakeups add check 5m "rm -rf build" never')
  mounted!.setup.mockInput.pressKey("n")
  await mounted!.settle()
  expect(flat(await mounted!.frame())).toContain("not set up: the command is not run")
  expect(asked).toHaveLength(1)
})
