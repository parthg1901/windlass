/**
 * Preloaded by the unit tests (`bun run test:unit`): a unit test starts no process. Not git, not a shell command,
 * not the sandbox's probe, not the program itself; those tests are end-to-end tests, named `*.e2e.test.ts`, and run
 * in their own CI job with time limits sized for slow runners (CONTRIBUTING.md, "Tests and fixtures").
 *
 * A process start is let through, so that the test runs as it would, and recorded with the test file that made it.
 * After the last file the run fails with the list, saying which files to rename.
 */
import { afterAll } from "bun:test"

const started = new Map<string, Set<string>>()

function record(command: unknown): void {
  const argv = Array.isArray(command) ? command : typeof command === "object" && command !== null && "cmd" in command ? (command as { cmd: unknown[] }).cmd : [command]
  const program = String(argv[0] ?? "?").split("/").pop()!
  const file = Bun.main
  const programs = started.get(file) ?? new Set<string>()
  programs.add(program)
  started.set(file, programs)
}

const writable = Bun as unknown as Record<"spawn" | "spawnSync", (...args: unknown[]) => unknown>
for (const name of ["spawn", "spawnSync"] as const) {
  const original = writable[name]
  writable[name] = (...args: unknown[]) => {
    record(args[0])
    return original(...args)
  }
}

afterAll(() => {
  if (started.size === 0) return
  const lines = [...started].map(([file, programs]) => `  ${file}: started ${[...programs].join(", ")}`)
  throw new Error(`These unit test files start processes, so they are end-to-end tests: rename each to *.e2e.test.ts.\n${lines.join("\n")}`)
})
