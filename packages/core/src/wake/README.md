# wake

A wake-up is a durable record that says: **deliver this message to this session when this condition is met.** It is
checked by the harness with no model call, survives restarts, and reaches the session through its inbox like any
other message. It replaces the two bad ways an agent waits: blocking a turn on a long sleep, or polling in a loop and
paying for every look. The engine uses it through `engine/wake.ts`, which carries out "For the engine integrator"
below (the admission path is `EngineSession.admit`); `docs/architecture.md` describes the result, including which
processes run the scheduler and the listener.

| File | What |
| --- | --- |
| `record.ts` | the record, its triggers, every limit (`WAKE_LIMITS`), validation, the next-time arithmetic (pure) |
| `cron.ts` | the five-field cron parser and the next time in a time zone (pure) |
| `store.ts` | the shared SQLite file, leases, firings and their idempotency keys, webhook replay records |
| `scheduler.ts` | sleeps until something is due, fires it, calls the caller's `deliver` |
| `check.ts` | runs a check command (through `../verify/run.ts`, i.e. the shell tool), capped and redacted |
| `webhook.ts` | the loopback listener, the two signature schemes, `signWebhook` |
| `message.ts` | the frozen text a firing delivers |
| `tools.ts` | `wake_create`, `wake_list`, `wake_cancel`, and `describeLines` for listings |
| `config.ts` | the `wake` configuration section |

`bun scripts/wake-demo.ts` shows a timer, a check that passes on its third run and a signed webhook, each delivering
by printing what the session would receive.

## For users

### What happens when one fires

The session gets a message that begins `[Wake-up wk_… · <trigger>]` (or `[Webhook …]`) and says plainly that it was
not typed by the user just now, who set the wake-up up and when, and then the message that was set up with it. A
check's output or a webhook's body follows; content from outside the harness is fenced and labelled as data, not
instructions. With `delivery: "wake"` (the default) it starts a turn if the session is idle, otherwise it waits until
the turn in progress ends; with `"queue"` it waits in the inbox for the next turn and starts nothing. That turn is
unattended unless someone is attached: anything that would ask is refused, never auto-approved.

### Triggers

As the model asks for them with `wake_create` (the user's client creates the same records through the store):

| Trigger | Example | Fires |
| --- | --- | --- |
| at a time | `{"trigger":"at","at":"2026-11-12T17:00:00+01:00","message":"Remind the user about the release."}` | once |
| after a delay | `{"trigger":"after","seconds":1800,"message":"Look at the canary metrics."}` | once |
| every interval | `{"trigger":"every","seconds":600,"maxFirings":6,"message":"Retry the flaky upload."}` | each interval |
| cron | `{"trigger":"cron","cron":"0 9 * * mon-fri","timeZone":"Europe/Berlin","message":"Summarise open PRs."}` | each match |
| check, until | `{"trigger":"check","command":"gh run view 123 --exit-status","seconds":60,"fire":"until","sandbox":{"network":true},"message":"CI finished: report the result."}` | once, the first time it exits 0 |
| check, on change | `{"trigger":"check","command":"cat deploy/VERSION","seconds":300,"fire":"on_change","message":"A new version was deployed."}` | each time output or exit code changes |
| webhook | `{"trigger":"webhook","message":"A deploy reported in."}` | each signed request |

A check runs in the session's working directory, as the model's shell commands do: in the sandbox, without network
unless that was asked for and approved when the wake-up was created. Its first run is at once (what is waited for
may already be true). For `on_change` the first run only records the starting point. A run that exits non-zero is
"not yet"; a run that cannot complete (timed out, killed, could not start, no sandbox) backs off, doubling the
interval up to an hour, and the fifth such run in a row stops the wake-up with a notice to the session.

**Cron.** `minute hour day-of-month month day-of-week`, with `*`, values, ranges `a-b`, lists `a,b`, steps `*/s`,
`a-b/s`, `a/s`, month and weekday names, `0` or `7` for Sunday, and `@hourly`, `@daily`, `@weekly`, `@monthly`,
`@yearly`. When both day fields are restricted a day matches if either does (Vixie cron's rule). An expression that
can never match (`0 0 30 2 *`) is refused. It runs in the user's time zone unless `timeZone` names another.
Daylight-saving changes, deliberately:

- an expression with a fixed hour (`30 2 * * *`) names wall-clock times. A time the clocks skip (02:30 when they go
  forward) fires **once at the first minute after the gap** (03:00); a time that happens twice (01:30 when they go back)
  fires **at its first occurrence only**;
- an expression whose hour field starts with `*` (`*/15 * * * *`, `0 */2 * * *`) follows real time: skipped minutes
  are skipped, and the repeated hour fires again on its second pass.

**Missed while nothing ran.** A wake-up that was due while no harness process ran fires **once** on the next start,
says it is late and that missed times are not made up for, and continues from now (an interval keeps its phase). A
one-shot is still delivered up to a day after its time, then expires.

### Sending a signed webhook

Creating a webhook wake-up gives the user its URL, `http://127.0.0.1:47863/w/<id>`, and its secret (`whsec_…`; the
model never sees it). The listener runs only while a webhook wake-up exists, on loopback only.

With curl (timestamp plus HMAC-SHA256 over `<timestamp>.<body>`; valid for five minutes, and once):

```sh
URL=http://127.0.0.1:47863/w/wk_3f9a2c1b4d5e
SECRET=whsec_...                       # as shown when the wake-up was created
BODY='{"service":"api","status":"deployed","version":"1.4.2"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -sS -X POST "$URL" -H 'Content-Type: application/json' \
  -H "X-Wake-Timestamp: $TS" -H "X-Wake-Signature: v1=$SIG" --data-binary "$BODY"
# {"accepted":true}   (202)
```

GitHub style: GitHub signs the body alone and sends `X-Hub-Signature-256: sha256=<hex>`. In the repository's
Settings → Webhooks, set the payload URL to a public address that forwards to the URL above (the listener stays on
loopback; use your own tunnel or reverse proxy), the content type to `application/json`, the secret to the wake-up's
secret, and pick the events (for example "Workflow runs"). The `ping` GitHub sends when the hook is created is
answered and fires nothing. Each signature is accepted once for the life of the wake-up, so a redelivery does not
fire it twice. To try it by hand:

```sh
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -sS -X POST "$URL" -H 'Content-Type: application/json' -H 'X-GitHub-Event: workflow_run' \
  -H "X-Hub-Signature-256: sha256=$SIG" --data-binary "$BODY"
```

Every refusal before the signature is proven valid (no signature, a bad or stale one, a replay, an unknown or ended
wake-up) is the same `401 {"error":"The signature is missing, invalid, stale or was already used."}`, so the
listener says nothing about which wake-ups exist. Other answers: `413` body over the limit, `429` with `Retry-After`
(rate, minimum interval or hourly ceiling), `404` for any other method or path.

### Limits

All of them are shown in the listing (`wake_list`, `describeLines`).

| Limit | Model-created | User-created |
| --- | --- | --- |
| Pending wake-ups per session | 10 (config `maxActive`, can only be lower) | 100 |
| Firings of one wake-up | default 10, at most 100 (1 for `at`, `after`, check `until`) | default 100, at most 10,000 |
| Expiry | default 1 day, at most 7 days (a one-shot: set up to 7 days ahead, delivered up to a day late) | default 30 days, at most 365 |
| Minimum time between firings | default 60 s, at least 10 s | same |
| Firings per session per rolling hour, all its wake-ups | 12 (config `hourlyCeiling`, at most 60) | same |
| Interval of `every` | 60 s to 30 days | same |
| Check interval / timeout | 15 s to 1 day / default 60 s, at most 10 min | same |
| Check output in the message | first and last 2 KiB of it, redacted | same |
| Webhook body | 64 KiB accepted, first 8 KiB shown, redacted | same |
| Webhook requests | 30 a minute (bursts of 10), 8 at once | same |
| Message | 4,000 characters | same |

Over the hourly ceiling a firing is held, not dropped, until the window has room ("held" in the listing); a check
does not even run meanwhile. Configuration (`"wake"` in the user's file; a project's file can only tighten, and
cannot move the listener): `enabled`, `hourlyCeiling`, `maxActive`, `webhook.host`, `webhook.port`,
`webhook.allowExternal` (required for a non-loopback host, which warns), `webhook.maxBodyBytes`,
`webhook.requestsPerMinute`.

## For the engine integrator

### Start-up and shutdown

```ts
const config = resolveWakeConfig(userFile.wake, projectFile.wake)        // show config.ignored once
const store = openWakeStore({ dir: wakeDirectory(dataDir), hourlyCeiling: config.hourlyCeiling, maxActive: { model: config.maxActive } })
const scheduler = createScheduler({
  store,
  runCheck: createCheckRunner({ spillDir: join(dataDir, "wake", "spill"), sandbox: approvals.sandbox(), secrets: credentialValues }),
  deliver,                                                                // below
  currentRun,                                                             // below
})
const listener = createWebhookListener({ store, ...config.webhook, onFiring: scheduler.poke, warn: notice, secrets: credentialValues })
scheduler.start()
listener.start()
// Engine.close(), before the stores close:
await listener.stop(); await scheduler.stop(); store.close()
```

Every process runs all three on the same store; leases make that safe. `stop` interrupts running checks (they run
again later), waits up to 5 s for a delivery in progress, and gives its leases back; a firing recorded but not
delivered stays open and is delivered by whoever takes the lease next. A process that dies holds nothing: its
owner lock goes with it, and the shell tool's guard kills a check it was running.

### Tools

Put `wakeTools({ store: () => store, sessionTainted, seqOf, webhookUrl: (id) => \`http://127.0.0.1:${config.webhook.port}/w/${id}\`,
changed: () => { scheduler.poke(); listener.refresh() } })` in the frozen tool list from the first baseline when
`config.enabled`. Their specs never change. Effects: `wake_create` `exec`, `wake_list` `read`, `wake_cancel` `write`.

### The deliver callback

`deliver(firing)` is called with a `Firing` whose `key` is its idempotency key (`msg_<wake id>_<n>`, or
`msg_<wake id>_notice`). The engine must:

1. Open the session for writing. Held by another process → return `{ kind: "retry" }` (its process delivers it, or
   this one retries from 5 s, doubling to 5 min). Unknown or archived → `{ kind: "rejected", reason }`: the wake-up
   fails.
2. If the session's log already has `firing.key` as a message ID (an inbox item, delivered or withdrawn) → return
   `{ kind: "duplicate" }`. This is a redelivery after a crash between admission and the store hearing of it; the
   reducer would refuse the reused ID anyway.
3. Append, in one transaction: `inbox.enqueued { messageId: firing.key, origin: "wake", delivery: "queue", content:
   text(firing.text) }`, and when `firing.untrusted`, the taint fact (below). Inbox delivery `queue`: a wake-up never
   steers a turn in progress.
4. If `firing.delivery === "wake"`, start work the way `send` does, unattended unless a client is attached and has
   said it attends. If `"queue"`, start nothing.
5. Return `{ kind: "admitted" }` without waiting for the turn. A throw counts as `retry`.

`EngineSession.send` mints its own message ID and always starts, so this needs an admission path with a given ID,
origin and start flag (a change to `engine.ts`, its owner's).

### What to record durably (in the session's log)

The record of schedules lives in the wake store; the session log records what reached the conversation:

- the admission above, with `origin` naming the source (`"wake"`; perhaps `"wake_webhook"` for webhook bodies, so
  a UI can show them apart) and the frozen text as stored content, never re-rendered;
- for an untrusted firing, a taint source of kind "wake-up" naming the wake-up and whether it was a webhook body or
  a networked or unsandboxed check's output, written before or with the admission, so the turn it starts is already
  tainted;
- for `wake_create`, nothing new: `tool.started` already records the approval decision it ran under, which is what
  the wake-up copied, and `tool.settled.display.wake` holds the action and the wake-up ID.

Cancellations, check runs, holds and expiries stay in the wake store; they are not facts about the conversation.

### Approvals and taint

- `wake_create` with a command (a check) is decided exactly like the shell: its input has the shell's `command` and
  `sandbox` at the top level, so `callFacts` and `decide` treat it as that command. Without one (a timer, a webhook)
  nothing is ever run: the tool says so for that call (`Tool.changes`), and it is decided as a change of the
  harness's own records, the same on a machine with a sandbox and on one without. The decision it ran under (`ToolContext.sandbox`) becomes the
  wake-up's `run`: sandboxed with that network and those writable roots, or unsandboxed where the call ran
  unsandboxed (`full`). In `ask` mode, the question should add that it will run later, unattended, up to
  `maxFirings` times (`describeTrigger` gives the words). With nobody present it is refused like any `exec` call.
- `currentRun(wake)` is called before every run: return what the approval layer would allow the session's commands now,
  for example sandboxed offline once the session is tainted (taint makes `full` sandbox commands, and stops earlier
  network grants applying), or `{ refused: reason }` when it would deny. The check runs under the narrower of that and
  its record (`narrowRun`); it never gets more than it was approved for at creation.
- A sandboxed run without a sandbox on the machine is an error, never an unsandboxed run.
- Firings are `untrusted` for webhook bodies and for the output of checks that had the network or no sandbox;
  record the taint as above. Check output and bodies are redacted (`redact`, with `secrets`) before they are frozen.

### Clients

Show the webhook secret to the user once on creation (`CreateResult.secret`, later `store.secret(id)`), never to the
model. List with `describeLines`; let the user cancel (`store.cancel(id, { by: "user" })`) and create their own
(`author: "user"`, with `run` chosen by the user for a check). Show failed wake-ups to the user. Through the engine
a client creates one with `Engine.wake().create(request)` (`engine/wake.ts`), which calls `store.create` with what
only the engine knows of the session (it exists and is a person's, its working directory, whether wake-ups are
turned off for it, whether it holds untrusted content) and tells the scheduler.

### Not decided here

- Whether the model may cancel a user's wake-up: it can, in its own session (cancelling only removes work).
- A timer whose firing cannot be delivered does not fire again until it is; then it catches up once.
- macOS: the store, scheduler and listener are platform-neutral; checks inherit the sandbox's macOS status (untested).
