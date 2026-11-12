/** The wake-up tools: fixed specs, effect classes, validation, what a model-created check records, list and cancel. */
import { afterEach, describe, expect, test } from "bun:test"
import type { ToolContext, ToolResult } from "../../src/tool/tool.ts"
import { WAKE_LIMITS } from "../../src/wake/record.ts"
import { type CreateInput, type WakeToolOptions, wakeCancelTool, wakeCreateTool, wakeListTool, wakeTools } from "../../src/wake/tools.ts"
import { HOUR, T0, cleanup, manualClock, store, toolContext } from "./helpers.ts"

afterEach(cleanup)

function setup(overrides: Partial<WakeToolOptions> = {}) {
  const clock = manualClock()
  const wakes = store(clock)
  let changed = 0
  const options: WakeToolOptions = {
    store: () => wakes,
    sessionTainted: () => false,
    seqOf: () => 42,
    webhookUrl: (id) => `http://127.0.0.1:47863/w/${id}`,
    changed: () => (changed += 1),
    timeZone: "Europe/Berlin",
    now: clock.now,
    ...overrides,
  }
  return { clock, wakes, options, changed: () => changed }
}

async function create(options: WakeToolOptions, input: CreateInput, context: ToolContext = toolContext({ sandbox: { network: false, writableRoots: [] } })): Promise<ToolResult> {
  return wakeCreateTool(options).execute(input, context)
}

describe("specs", () => {
  test("the specs do not depend on the options or on what is stored", () => {
    const a = wakeTools(setup().options).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, effect: tool.effect }))
    const b = wakeTools(setup({ timeZone: "UTC", webhookUrl: () => "elsewhere" }).options).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, effect: tool.effect }))
    expect(a).toEqual(b)
  })

  test("effect classes: create is exec (decided like a shell command), list reads, cancel writes", () => {
    expect(wakeTools(setup().options).map((tool) => [tool.name, tool.effect])).toEqual([
      ["wake_create", "exec"],
      ["wake_list", "read"],
      ["wake_cancel", "write"],
    ])
  })

  test("create has the shell's command and sandbox arguments at the top level, for the approval layer", () => {
    const schema = wakeCreateTool(setup().options).inputSchema as { properties: Record<string, { type?: string }>; additionalProperties: boolean }
    expect(schema.properties.command!.type).toBe("string")
    expect(schema.properties.sandbox).toBeDefined()
    expect(schema.additionalProperties).toBe(false)
  })

  test("the description says when a wake-up is right and when waiting inside the turn is", () => {
    const description = wakeCreateTool(setup().options).description
    expect(description).toContain("instead of sleeping, polling in a loop")
    expect(description).toContain("For something that finishes within a couple of minutes, run the command")
  })
})

describe("create", () => {
  test("each trigger", async () => {
    const { options, wakes, changed } = setup()
    const inputs: CreateInput[] = [
      { message: "m", trigger: "at", at: "2026-11-12T12:00:00+01:00" },
      { message: "m", trigger: "after", seconds: 600 },
      { message: "m", trigger: "every", seconds: 600, maxFirings: 6 },
      { message: "m", trigger: "cron", cron: "0 9 * * mon-fri" },
      { message: "m", trigger: "check", command: "gh run view 1 --exit-status", seconds: 60, fire: "until" },
      { message: "m", trigger: "check", command: "cat VERSION", seconds: 300, fire: "on_change", includeOutput: false },
      { message: "m", trigger: "webhook" },
    ]
    for (const input of inputs) {
      const result = await create(options, input)
      expect(result.status).toBe("success")
    }
    expect(changed()).toBe(inputs.length)
    const listed = wakes.list({ sessionId: "ses_test" })
    expect(listed.map((wake) => wake.trigger.kind).sort()).toEqual(["at", "at", "check", "check", "cron", "every", "webhook"])
    const cron = listed.find((wake) => wake.trigger.kind === "cron")!
    expect(cron.trigger).toEqual({ kind: "cron", expression: "0 9 * * mon-fri", timeZone: "Europe/Berlin" })
    expect(listed.find((wake) => wake.trigger.kind === "at" && wake.trigger.delayMs === null)!.nextAt).toBe(Date.parse("2026-11-12T11:00:00Z"))
  })

  test("refusals the model can act on", async () => {
    const { options } = setup()
    const cases: [CreateInput, RegExp][] = [
      [{ message: "m", trigger: "at", at: "2026-11-12T12:00:00" }, /has no offset/],
      [{ message: "m", trigger: "at", at: "tomorrow+01:00" }, /is not an ISO 8601 time/],
      [{ message: "m", trigger: "at", at: "2026-11-12T08:00:00Z" }, /already passed/],
      [{ message: "m", trigger: "at", at: "2026-12-30T08:00:00Z" }, /at most 7 days ahead/],
      [{ message: "m", trigger: "after" }, /needs `seconds`/],
      [{ message: "m", trigger: "every", seconds: 30 }, /interval must be from 60 seconds/],
      [{ message: "m", trigger: "cron", cron: "0 25 * * *" }, /hour 25 is out of range/],
      [{ message: "m", trigger: "cron", cron: "0 9 * * *", timeZone: "Mars/Olympus" }, /Unknown time zone/],
      [{ message: "m", trigger: "check", command: "true", seconds: 60 }, /needs `fire`/],
      [{ message: "m", trigger: "check", command: "true", seconds: 5, fire: "until" }, /check interval must be from 15 seconds/],
      [{ message: "m", trigger: "after", seconds: 60, command: "true" }, /`command` does not apply to a "after" wake-up/],
      [{ message: "m", trigger: "webhook", seconds: 60 }, /`seconds` does not apply/],
      [{ message: " ", trigger: "after", seconds: 60 }, /message is empty/],
      [{ message: "m", trigger: "every", seconds: 600, maxFirings: 101 }, /maxFirings must be a whole number from 1 to 100/],
      [{ message: "m", trigger: "every", seconds: 600, expiresInSeconds: 8 * 24 * 3600 }, /at most 7 days/],
      [{ message: "m", trigger: "every", seconds: 600, minIntervalSeconds: 1 }, /at least 10 seconds/],
      [{ message: "x".repeat(WAKE_LIMITS.messageChars + 1), trigger: "after", seconds: 60 }, /characters long; the limit is 4000/],
    ]
    for (const [input, message] of cases) {
      const result = await create(options, input)
      expect({ input, status: result.status }).toEqual({ input, status: "error" })
      expect(result.output).toMatch(message)
    }
  })

  test("a model-created check records the decision the call ran under, and its working directory", async () => {
    const { options, wakes } = setup()
    const networked = toolContext({ cwd: "/repo", sandbox: { network: true, writableRoots: ["/repo/.cache"] } })
    await create(options, { message: "m", trigger: "check", command: "curl -sf https://ci/status", seconds: 60, fire: "until", sandbox: { network: true } }, networked)
    await create(options, { message: "m", trigger: "check", command: "make check", seconds: 60, fire: "until" }, toolContext({ sandbox: null }))
    const byCommand = (command: string) => wakes.list({ sessionId: "ses_test" }).find((wake) => wake.trigger.kind === "check" && wake.trigger.command === command)
    const sandboxed = byCommand("curl -sf https://ci/status")
    const unsandboxed = byCommand("make check")
    expect(sandboxed!.run).toEqual({ kind: "sandboxed", network: true, writableRoots: ["/repo/.cache"] })
    expect(sandboxed!.cwd).toBe("/repo")
    // Only where the approval layer let it run as it is (full mode): no sandbox, like the shell.
    expect(unsandboxed!.run).toEqual({ kind: "unsandboxed" })
  })

  test("provenance: the model, this call, the position in the log, and whether the session was tainted", async () => {
    const { options, wakes } = setup({ sessionTainted: () => true })
    await create(options, { message: "m", trigger: "after", seconds: 60 })
    expect(wakes.list()[0]!.provenance).toEqual({ author: "model", sessionId: "ses_test", messageId: "msg_a1", callId: "call_1", seq: 42, tainted: true, createdAt: T0 })
  })

  test("a webhook's result names its URL and keeps the secret from the model", async () => {
    const { options, wakes } = setup()
    const result = await create(options, { message: "m", trigger: "webhook" })
    const wake = wakes.list()[0]!
    expect(result.output).toContain(`URL: POST http://127.0.0.1:47863/w/${wake.id}`)
    expect(result.output).toContain("The secret that signs requests is shown to the user, not to you.")
    expect(result.output).not.toContain(wakes.secret(wake.id)!)
    expect(wakes.secret(wake.id)).toMatch(/^whsec_[0-9a-f]{64}$/)
  })

  test("at most ten pending wake-ups of the model's per session; the user's do not count", async () => {
    const { options, wakes } = setup()
    for (let index = 0; index < 3; index += 1) wakes.create({ sessionId: "ses_test", message: "u", author: "user", trigger: { kind: "after", delayMs: HOUR } })
    for (let index = 0; index < WAKE_LIMITS.model.maxActive; index += 1) expect((await create(options, { message: "m", trigger: "after", seconds: 60 })).status).toBe("success")
    const refused = await create(options, { message: "m", trigger: "after", seconds: 60 })
    expect(refused.output).toBe("This session already has 10 pending wake-ups created by the model, the most allowed. Cancel one that is no longer needed first.")
    // Another session has its own allowance.
    expect((await create(options, { message: "m", trigger: "after", seconds: 60 }, toolContext({ sessionId: "ses_other" }))).status).toBe("success")
  })
})

describe("list and cancel", () => {
  test("list shows this session's wake-ups with every limit", async () => {
    const { options } = setup()
    await create(options, { message: "Retry the flaky deploy.", trigger: "check", command: "./deploy --dry-run", seconds: 600, fire: "until" })
    await create(options, { message: "Elsewhere.", trigger: "after", seconds: 60 }, toolContext({ sessionId: "ses_other" }))
    const listed = await wakeListTool(options).execute({}, toolContext())
    expect(listed.output).toContain("The session's ceiling: 12 firings per hour (0 in the last hour). At most 10 pending wake-ups created by you.")
    expect(listed.output).toContain("run `./deploy --dry-run` every 10m until it exits 0 (timeout 1m)")
    expect(listed.output).toContain("State: next 2026-11-12T09:00:00Z. Fired 0 of at most 1.")
    expect(listed.output).toContain("Limits: expires 2026-11-13T09:00:00Z; at least 1m between firings; at most 12 firings per hour for the session. Delivery: starts a turn.")
    expect(listed.output).toContain("The check runs in the sandbox, no network, as approved when it was created. It has not run yet.")
    expect(listed.output).toContain("Message: Retry the flaky deploy.")
    expect(listed.output).not.toContain("Elsewhere.")
  })

  test("cancel stops one of this session's wake-ups, and only this session's", async () => {
    const { options, wakes } = setup()
    await create(options, { message: "mine", trigger: "after", seconds: 60 })
    await create(options, { message: "theirs", trigger: "after", seconds: 60 }, toolContext({ sessionId: "ses_other" }))
    const mine = wakes.list({ sessionId: "ses_test" })[0]!
    const theirs = wakes.list({ sessionId: "ses_other" })[0]!
    const cancel = wakeCancelTool(options)
    expect((await cancel.execute({ id: theirs.id }, toolContext())).output).toBe(`There is no wake-up ${theirs.id} in this session.`)
    expect((await cancel.execute({ id: mine.id, reason: "done already" }, toolContext())).status).toBe("success")
    expect(wakes.get(mine.id)!.state).toMatchObject({ kind: "cancelled", by: "model", reason: "done already" })
    expect((await cancel.execute({ id: mine.id }, toolContext())).output).toBe(`Wake-up ${mine.id} has already ended (cancelled).`)
    expect(wakes.get(theirs.id)!.state.kind).toBe("pending")
  })

  test("ended wake-ups are listed only when asked", async () => {
    const { options, wakes } = setup()
    await create(options, { message: "m", trigger: "after", seconds: 60 })
    wakes.cancel(wakes.list()[0]!.id, { by: "user" })
    expect((await wakeListTool(options).execute({}, toolContext())).output).toContain("No pending wake-ups in this session.")
    expect((await wakeListTool(options).execute({ includeEnded: true }, toolContext())).output).toContain("State: cancelled 2026-11-12T09:00:00Z.")
  })
})

describe("the user's wake-ups through the store", () => {
  test("a user's webhook may bring its own secret, which must be long enough", () => {
    const { wakes } = setup()
    expect(wakes.create({ sessionId: "s", message: "m", author: "user", trigger: { kind: "webhook" }, secret: "short" })).toMatchObject({ ok: false, error: "A webhook secret must be at least 16 characters long." })
    const created = wakes.create({ sessionId: "s", message: "m", author: "user", trigger: { kind: "webhook" }, secret: "a-long-enough-secret" }) as { ok: true; secret: string }
    expect(created.secret).toBe("a-long-enough-secret")
  })

  test("a user's wake-up may run longer and fire more often than the model's", () => {
    const { wakes } = setup()
    expect(wakes.create({ sessionId: "s", message: "m", author: "user", trigger: { kind: "every", intervalMs: HOUR }, maxFirings: 1000, expiresAt: T0 + 90 * 24 * HOUR }).ok).toBe(true)
    expect(wakes.create({ sessionId: "s", message: "m", author: "model", trigger: { kind: "every", intervalMs: HOUR }, maxFirings: 1000 }).ok).toBe(false)
  })

  test("a check needs the decision it runs under", () => {
    const { wakes } = setup()
    expect(wakes.create({ sessionId: "s", message: "m", author: "user", trigger: { kind: "check", command: "true", intervalMs: 60_000, fire: "until" } })).toMatchObject({
      ok: false,
      error: "A check needs the decision it runs under and a working directory.",
    })
  })
})

