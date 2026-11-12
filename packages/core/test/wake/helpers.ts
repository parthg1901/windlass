/** Helpers for the wake tests: a clock the test moves, real temporary stores, an inbox that admits each key once. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import type { SandboxRun, ToolContext } from "../../src/tool/tool.ts"
import type { CheckOutcome, CheckRequest, CheckRunner } from "../../src/wake/check.ts"
import type { WakeClock } from "../../src/wake/clock.ts"
import type { Firing } from "../../src/wake/record.ts"
import type { Deliver, DeliverResult, Scheduler, SchedulerEvent } from "../../src/wake/scheduler.ts"
import { type WakeStore, type WakeStoreOptions, openWakeStore } from "../../src/wake/store.ts"

export const T0 = Date.parse("2026-11-12T09:00:00Z")
export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE

const dirs: string[] = []
const cleanups: (() => Promise<void> | void)[] = []

export function tempDir(prefix = "wl-wake-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export function onCleanup(fn: () => Promise<void> | void) {
  cleanups.push(fn)
}

export async function cleanup() {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A clock that moves only when the test says so. Sleepers wake when time reaches their deadline or their signal aborts. */
export interface ManualClock extends WakeClock {
  readonly advance: (ms: number) => void
  readonly set: (at: number) => void
  /** Every sleep that was asked for, in ms. */
  readonly sleeps: number[]
  readonly sleeping: () => number
}

export function manualClock(start = T0): ManualClock {
  let now = start
  const sleepers = new Set<{ until: number; resolve: () => void }>()
  const sleeps: number[] = []
  const wake = () => {
    for (const sleeper of [...sleepers]) if (sleeper.until <= now) {
      sleepers.delete(sleeper)
      sleeper.resolve()
    }
  }
  return {
    now: () => now,
    sleeps,
    sleeping: () => sleepers.size,
    advance: (ms) => {
      now += ms
      wake()
    },
    set: (at) => {
      now = at
      wake()
    },
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms)
        if (signal?.aborted) return resolve()
        const sleeper = {
          until: now + ms,
          resolve: () => {
            signal?.removeEventListener("abort", abort)
            resolve()
          },
        }
        const abort = () => {
          sleepers.delete(sleeper)
          sleeper.resolve()
        }
        signal?.addEventListener("abort", abort, { once: true })
        sleepers.add(sleeper)
      }),
  }
}

export function store(clock: WakeClock, options: Partial<WakeStoreOptions> = {}): WakeStore {
  const opened = openWakeStore({ dir: join(tempDir(), "wake"), clock, ...options })
  onCleanup(() => opened.close())
  return opened
}

/** Admits each key once, as the engine's inbox does (a reused message ID is refused); a script can answer otherwise. */
export function inbox(script: (firing: Firing, attempt: number) => DeliverResult | null = () => null) {
  const admitted: Firing[] = []
  const attempts: Firing[] = []
  const deliver: Deliver = async (firing) => {
    attempts.push(firing)
    const scripted = script(firing, attempts.filter((item) => item.key === firing.key).length)
    if (scripted !== null) return scripted
    if (admitted.some((item) => item.key === firing.key)) return { kind: "duplicate" }
    admitted.push(firing)
    return { kind: "admitted" }
  }
  return { deliver, admitted, attempts }
}

/** A check runner that answers from a script, recording each request. */
export function scriptedRunner(answer: (request: CheckRequest, run: number) => CheckOutcome | Promise<CheckOutcome>) {
  const requests: CheckRequest[] = []
  const runner: CheckRunner = async (request) => {
    requests.push(request)
    return answer(request, requests.length)
  }
  return { runner, requests }
}

export function exited(exitCode: number, output = "", fingerprint = `${exitCode}:${output}`): CheckOutcome {
  return { kind: "exited", exitCode, output, totalBytes: output.length, fingerprint }
}

export function events() {
  const seen: SchedulerEvent[] = []
  return { seen, onEvent: (event: SchedulerEvent) => seen.push(event), of: (type: SchedulerEvent["type"]) => seen.filter((event) => event.type === type) }
}

export function stopLater(scheduler: Scheduler) {
  onCleanup(() => scheduler.stop())
}

export function toolContext(overrides: { sessionId?: string; cwd?: string; sandbox?: SandboxRun | null } = {}): ToolContext {
  return {
    sessionId: (overrides.sessionId ?? "ses_test") as SessionId,
    messageId: "msg_a1" as MessageId,
    callId: "call_1" as CallId,
    cwd: overrides.cwd ?? process.cwd(),
    signal: createInterrupt().signal,
    progress: () => {},
    putBlob: () => {
      throw new Error("no blobs")
    },
    ...(overrides.sandbox === undefined ? {} : { sandbox: overrides.sandbox }),
  }
}

/** Waits until `condition` holds, polling on the real clock; fails after `ms`. */
export async function until(condition: () => boolean, ms = 20_000, what = "condition") {
  const deadline = performance.now() + ms
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}
