/** Helpers for the LSP tests: the scripted server as configuration, temporary workspaces, registries that are always stopped. */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type LspConfigSection, planLspServers } from "../../src/lsp/config.ts"
import { type LspNotice, type LspRegistry, type LspRegistryOptions, createLspRegistry } from "../../src/lsp/registry.ts"
import { waitFor as waitForCondition } from "../../src/testing/wait.ts"

export const SERVER = join(import.meta.dir, "fixtures", "server.ts")

type ServerFields = NonNullable<LspConfigSection["servers"]>[string]

/** The scripted server with these flags, serving `*.txt` as language `plaintext`. */
export function fixture(flags: readonly string[] = [], fields: Partial<ServerFields> = {}): ServerFields {
  return { command: process.execPath, args: [SERVER, ...flags], languages: { plaintext: ["**/*.txt"] }, ...fields }
}

const dirs: string[] = []
const registries: LspRegistry[] = []

export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wl-lsp-")))
  dirs.push(dir)
  return dir
}

export interface Made {
  readonly registry: LspRegistry
  readonly notices: LspNotice[]
  readonly cwd: string
}

/** A registry over the user's section (and optionally a project's), stopped by `cleanup`. */
export function make(
  user: LspConfigSection | undefined,
  options: { project?: LspConfigSection; approved?: (key: string) => boolean; cwd?: string } & Partial<Omit<LspRegistryOptions, "plan" | "cwd">> = {},
): Made {
  const notices: LspNotice[] = []
  const cwd = options.cwd ?? tempDir()
  const registry = createLspRegistry({
    plan: planLspServers(user, options.project, options.approved ?? (() => false)),
    cwd,
    graceMs: 300,
    backoff: { initialMs: 100, maxMs: 400, stableMs: 60_000 },
    onNotice: (notice) => notices.push(notice),
    ...options,
  })
  registries.push(registry)
  return { registry, notices, cwd }
}

export async function cleanup() {
  await Promise.all(registries.splice(0).map((registry) => registry.stop()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  await waitForCondition(predicate, { timeoutMs, intervalMs: 20, what })
}

export function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line !== "")
  } catch {
    return []
  }
}

export function readPid(path: string): number {
  return Number(readFileSync(path, "utf8"))
}
