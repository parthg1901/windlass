/**
 * Wake-ups, end to end, with no model: a timer, a check command that passes on its third run, and a signed
 * webhook. Each "delivers" by printing the message the session would receive. Time is simulated (the scheduler
 * takes a clock), so the demo takes a few seconds; the check commands and the HTTP requests are real.
 *
 *   bun scripts/wake-demo.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import {
  type Firing,
  type WakeClock,
  createCheckRunner,
  createScheduler,
  createWebhookListener,
  describeLines,
  describeTrigger,
  openWakeStore,
  signWebhook,
  wakeDirectory,
} from "../packages/core/src/wake/index.ts"

const base = mkdtempSync(join(tmpdir(), `${brand.directory}-wake-demo-`))
const workspace = join(base, "workspace")
const clock = demoClock(Date.parse("2026-11-12T09:00:00Z"))
const store = openWakeStore({ dir: wakeDirectory(join(base, "data")), clock })
const delivered: Firing[] = []
const scheduler = createScheduler({
  store,
  clock,
  runCheck: createCheckRunner({ spillDir: join(base, "spill") }),
  deliver: async (firing) => {
    delivered.push(firing)
    console.log(`  ${time()}  delivered ${firing.key}${firing.untrusted ? " (untrusted content)" : ""}:`)
    for (const line of firing.text.split("\n")) console.log(`      │ ${line}`)
    return { kind: "admitted" }
  },
  onEvent: (event) => {
    if (event.type === "checked" && event.outcome.kind === "exited")
      console.log(`  ${time()}  check ran: exit ${event.outcome.exitCode}, printed ${JSON.stringify(event.outcome.output.trim())}`)
  },
})
const time = () => new Date(clock.now()).toISOString().slice(11, 19)
const step = async (ms: number) => {
  clock.advance(ms)
  await scheduler.runDue()
}

try {
  console.log(`Wake-up demo. Simulated time starts at ${new Date(clock.now()).toISOString()}; data in ${base}\n`)

  // ---- 1. a timer
  console.log("1. A timer")
  const timer = created(store.create({ sessionId: "ses_demo", message: "Remind the user to rotate the staging key.", author: "user", trigger: { kind: "after", delayMs: 90_000 } }))
  console.log(`  ${time()}  created ${timer.id}: ${describeTrigger(timer.trigger)}`)
  await step(60_000)
  console.log(`  ${time()}  nothing due yet (${delivered.length} delivered)`)
  await step(30_000)

  // ---- 2. a check that passes on its third run
  console.log("\n2. A check command that passes on its third run")
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, "runs"), "0")
  writeFileSync(
    join(workspace, "ci-status.sh"),
    'n=$(( $(cat runs) + 1 )); echo $n > runs\nif [ $n -ge 3 ]; then echo "pipeline green (run $n)"; else echo "pipeline running (run $n)"; exit 1; fi\n',
  )
  const command = "sh ci-status.sh"
  const check = created(
    store.create({
      sessionId: "ses_demo",
      message: "CI finished: read the result and tell the user.",
      author: "model",
      messageId: "msg_demo",
      callId: "call_1",
      trigger: { kind: "check", command, intervalMs: 15_000, fire: "until" },
      // As the approval layer decided when the model created it; `full` mode here so the demo runs anywhere.
      run: { kind: "unsandboxed" },
      cwd: workspace,
    }),
  )
  console.log(`  ${time()}  created ${check.id}: ${describeTrigger(check.trigger)}`)
  await step(0)
  await step(15_000)
  await step(15_000)
  await step(15_000)
  console.log(`  ${time()}  ${check.id} is now ${store.get(check.id)!.state.kind}; no model call was made for the two runs that failed`)

  // ---- 3. a signed webhook
  console.log("\n3. A signed webhook")
  const hook = store.create({ sessionId: "ses_demo", message: "A deploy reported in: check what it says.", author: "user", trigger: { kind: "webhook" } })
  if (!hook.ok) throw new Error(hook.error)
  const listener = createWebhookListener({ store, clock, port: 0, onFiring: () => scheduler.poke() })
  listener.refresh()
  const url = `${listener.url()}/w/${hook.wake.id}`
  console.log(`  ${time()}  created ${hook.wake.id}; the listener is up only now that a webhook exists: POST ${url}`)
  const body = JSON.stringify({ service: "api", status: "deployed", version: "1.4.2" })
  const now = Math.floor(clock.now() / 1000)
  const send = async (label: string, headers: Record<string, string>) => {
    const response = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } })
    console.log(`  ${time()}  ${label.padEnd(26)} → ${response.status} ${await response.text()}`)
  }
  await send("bad signature", signWebhook("not-the-secret-0000000000", body, now))
  await send("signed with the secret", signWebhook(hook.secret!, body, now))
  await send("the same request again", signWebhook(hook.secret!, body, now))
  console.log(`  The same request with curl, with BODY='${body}' and SECRET set to the secret the user was shown:`)
  console.log(`      sig=$(printf '%s' "${now}.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')`)
  console.log(`      curl -sS -X POST ${url} -H "X-Wake-Timestamp: ${now}" -H "X-Wake-Signature: v1=$sig" --data-binary "$BODY"`)
  await step(1000)
  await listener.stop()

  console.log("\nThe listing (what the user and the model see):")
  for (const wake of store.list({ includeEnded: true }).reverse()) {
    console.log(`  ${wake.id} · ${describeTrigger(wake.trigger)}`)
    for (const line of describeLines(wake, store.hourlyCeiling, () => url)) console.log(`      ${line}`)
  }
  console.log(`\n${delivered.length} messages delivered: ${delivered.map((firing) => firing.key).join(", ")}`)
} finally {
  await scheduler.stop()
  store.close()
  rmSync(base, { recursive: true, force: true })
}

function created(result: ReturnType<typeof store.create>) {
  if (!result.ok) throw new Error(result.error)
  return result.wake
}

/** Simulated time: `advance` moves it; nothing here sleeps on it except the scheduler, which the demo drives with `runDue`. */
function demoClock(start: number): WakeClock & { readonly advance: (ms: number) => void } {
  let now = start
  return { now: () => now, advance: (ms) => (now += ms), sleep: () => new Promise(() => {}) }
}
