# Wake-ups

A wake-up is a message the agent leaves for its own session, to be delivered later when something happens: a time
comes, a command starts to succeed or its output changes, or a signed HTTP request arrives. It is how the agent waits
for CI, a deploy or a reminder without keeping a turn open or polling. `lh` checks the condition itself, with no
model call, and the wake-up survives restarts. `test/release/feature-docs.test.ts` checks the keys, limits, headers
and messages on this page against the code.

## Where wake-ups fire today

<!-- WAKE-UPS-FIRE: update this section when an entry point starts the scheduler -->
**At this commit no part of the program fires a wake-up.** The agent can create, list and cancel wake-ups in every
session (`lh`, `lh tui`, an editor through `lh acp`), and they are kept, but the scheduler that fires them and the
webhook listener that receives requests run only in a process whose engine is told to run them, and none of `lh`,
`lh tui` or `lh acp` does yet. A wake-up created now fires in the first process that runs the scheduler, late, as
described under "Missed while nothing ran". What the rest of this page says about firing was seen by running the
program's engine with the scheduler switched on, outside these entry points.

## Creating one

You ask the agent; it calls `wake_create`. For example "check every minute whether CI on this branch is green, and
tell me": the agent creates a check wake-up and ends its turn. In a one-shot run:

```sh
lh "in a minute, remind me to look at the canary"
```

```text
▸ wake_create after
  ✓ Created wake-up wk_7a3c12139dd8: after 1m (at 2026-11-12T08:39:20Z). ⊡
```

`wake_create` is decided like the shell command it may run: a check's command runs in the sandbox, without network
unless the model asked for it and it was approved, and what was approved when it was created is the most it ever
runs with. A timer or a webhook runs no command. `wake_list` shows the session's wake-ups and their limits;
`wake_cancel` stops one.

## The triggers

| Trigger | Fires |
|---|---|
| `at` a time | once |
| `after` a number of seconds | once |
| `every` an interval | each interval (60 seconds to 30 days) |
| `cron` a five-field expression (`0 9 * * mon-fri`), in your time zone unless `timeZone` names one | each match |
| `check` a command, `fire: "until"` | once, the first time the command exits 0 |
| `check` a command, `fire: "on_change"` | each time its output or exit code changes |
| `webhook` | each signed request |

A check runs in the session's working directory, every 15 seconds to once a day; its first run is at once. A run
that cannot complete (timed out, could not start, no sandbox) waits twice as long before the next, up to an hour,
and the fifth in a row stops the wake-up.

## What happens when one fires

The session gets a message, which starts a turn if it is idle (or waits for the turn in progress to end):

```text
[Wake-up wk_7a3c12139dd8 · after 1m (at 2026-11-12T08:39:20Z)]
This message was not typed by the user just now. It was delivered by a wake-up that you (the model), in this session, set up on 2026-11-12T08:38:20Z. No one may be watching: work as in an unattended run.

The message set up with the wake-up:
Look at the canary.
```

**Unattended.** Unless a client has the session open and answers its questions, the turn a wake-up starts has
nobody to ask: a call that would ask is refused, as in a one-shot run (`--unattended deny`), and the model is told.
Nothing is ever approved because nobody answered. The message itself tells the model that no one may be watching.

A webhook's body, and the output of a check that ran with the network or without the sandbox, are content `lh` does
not control: they are delivered fenced as data, and the session is tainted before the turn starts (see
[safety.md](safety.md)).

## Webhooks

Creating a webhook wake-up gives a URL, `http://127.0.0.1:47863/w/<id>`, and a secret (`whsec_...`) that the model
never sees. The listener is on loopback only. A request must be signed with the secret, one of two ways.

The program's own scheme: a timestamp, and an HMAC-SHA256 of `<timestamp>.<body>`, valid for five minutes and once:

```sh
URL=http://127.0.0.1:47863/w/wk_3f9a2c1b4d5e
SECRET=whsec_0123456789abcdef
BODY='{"service":"api","status":"deployed"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -sS -X POST "$URL" -H 'Content-Type: application/json' -H "X-Wake-Timestamp: $TS" -H "X-Wake-Signature: v1=$SIG" --data-binary "$BODY"
```

The answer is `202` with `{"accepted":true}`. GitHub's scheme also works: `X-Hub-Signature-256: sha256=<hex>`, an
HMAC-SHA256 of the body alone, as GitHub sends it when the hook's secret is the wake-up's secret (GitHub must reach
the listener through a tunnel or proxy of your own; it stays on loopback). Every request that is not correctly
signed, is stale, was already used, or names an unknown wake-up gets the same answer, so the listener says nothing
about which wake-ups exist:

```text
{"error":"The signature is missing, invalid, stale or was already used."}
```

(status `401`). A body over the limit gets `413`, too many requests `429` with `Retry-After`.

### Not yet

- **No client shows you the secret.** The model is told `The secret that signs requests is shown to the user, not to you.`,
  but neither `lh`, `lh tui` nor `lh acp` shows it. It is kept only in the wake-up store, `~/.local/share/light-harness/wake/wake.db`.
- **Nothing listens.** See "Where wake-ups fire today": no entry point starts the listener, so a request to the URL
  is refused by the operating system.

## Limits

| Limit | Wake-ups the model creates |
|---|---|
| Pending wake-ups per session | 10 (`wake.maxActive` can lower it) |
| Firings of one wake-up | 10 by default, at most 100; 1 for `at`, `after` and a check `until` |
| Expiry | 1 day by default, at most 7 days |
| Time between two firings | at least 60 seconds by default, never under 10 seconds |
| Firings per session in any hour, all its wake-ups together | 12 (`wake.hourlyCeiling`, at most 60) |
| The message | 4,000 characters |
| A webhook's body | 64 KiB accepted, the first 8 KiB shown |
| Webhook requests | 30 a minute |

Over the hourly ceiling a firing is held, not dropped, until the hour has room.

**Missed while nothing ran.** A wake-up that came due while no process ran the scheduler fires once on the next
start, says it is late, and continues from then; missed times are not made up. A one-shot (`at`, `after`) is still
delivered up to a day after its time, then expires.

## Configuration

In the `wake` section of your own file. A project's file can only tighten: turn the tools off and lower
`maxActive`; it cannot move the listener.

```json
{ "wake": { "enabled": true, "hourlyCeiling": 6, "maxActive": 5, "webhook": { "port": 47863 } } }
```

| Key in `wake` | Value |
|---|---|
| `enabled` | default `true`; `false`: new sessions are not given the wake-up tools |
| `hourlyCeiling` | firings per session in any hour, 1 to 60; default 12 |
| `maxActive` | pending wake-ups the model may have per session, 1 to 10; default 10 |
| `webhook` | the listener (below) |

| Key in `wake.webhook` | Value |
|---|---|
| `host` | default `127.0.0.1` |
| `port` | default `47863` |
| `allowExternal` | `true` is required for a host that is not loopback |
| `maxBodyBytes` | the largest body accepted, 1024 to 65536; default 65536 |
| `requestsPerMinute` | 1 to 30; default 30 |

Whether a session has the tools is decided when it starts: changing `enabled` later does not add them to, or take
them from, a session that exists.

The wake-ups of every session are kept in one store, `~/.local/share/light-harness/wake/`, shared by every `lh`
process of the data directory.
