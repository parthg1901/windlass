/** Helpers for the hooks tests: hooks from a configuration, a scripted runner, temporary directories. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookProcessResult } from "../../src/hooks/answer.ts"
import { type HookEntry, type HookOrigin, type HookPoint, type HooksConfig, parseHooksSection, resolveHooksConfig } from "../../src/hooks/config.ts"
import type { HookPointContext } from "../../src/hooks/points.ts"
import type { HookRunRequest, HookRunner } from "../../src/hooks/run.ts"
import type { HookTrustContext } from "../../src/hooks/trust.ts"

const dirs: string[] = []

/** A fresh temporary directory with symlinks resolved, removed by `cleanup`. */
export function tempDir(prefix = "wl-hooks-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return realpathSync(dir)
}

export function cleanup() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Resolved hooks from one file's worth of entries per point. */
export function hooks(sections: { user?: Partial<Record<HookPoint, HookEntry[]>> & { maxStopRounds?: number }; project?: Partial<Record<HookPoint, HookEntry[]>> & { maxStopRounds?: number } }): HooksConfig {
  const parse = (value: unknown, origin: HookOrigin) => (value === undefined ? undefined : parseHooksSection(value, `${origin}.json`, origin))
  return resolveHooksConfig(parse(sections.user, "user"), parse(sections.project, "project"))
}

export const exited = (exitCode: number, stdout = "", stderr = ""): HookProcessResult => ({ kind: "exited", exitCode, stdout, stdoutBytes: new TextEncoder().encode(stdout).length, stderr, durationMs: 5 })

/** A runner that answers from a script per hook name and remembers every request. */
export function scriptedRunner(answers: Record<string, HookProcessResult | ((request: HookRunRequest) => HookProcessResult)>) {
  const requests: HookRunRequest[] = []
  const runner: HookRunner = async (request) => {
    requests.push(request)
    const answer = answers[request.hook.name]
    if (answer === undefined) throw new Error(`no scripted answer for ${request.hook.name}`)
    return typeof answer === "function" ? answer(request) : answer
  }
  return { runner, requests }
}

export const trust = (overrides: Partial<HookTrustContext> = {}): HookTrustContext => ({ mode: "auto", tainted: false, sandboxAvailable: true, isApproved: () => false, ...overrides })

export function pointContext(runner: HookRunner, overrides: Partial<HookPointContext> = {}): HookPointContext {
  return { runner, trust: trust(), cwd: "/work", sessionId: "ses_test", signal: new AbortController().signal, untrustedRepository: false, ...overrides }
}
