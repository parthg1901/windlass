/**
 * Language server diagnostics after an edit, against the scripted test server.
 * Prints what the model would see for an edit that adds an error to a file
 * that already had a warning and an error; then what happens with a server
 * that never answers, and with one that crashes; then that nothing is left running.
 *
 *   bun scripts/lsp-demo.ts
 *   bun scripts/lsp-demo.ts --python -- <command> [args...]    the same edit, in Python, against a real server
 *
 * e.g. `--python -- node /path/to/pyright/dist/langserver.index.js --stdio`. Nothing is installed by this script.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type LspConfigSection, planLspServers } from "../packages/core/src/lsp/config.ts"
import { type DiagnoseResult, type LspNotice, createLspRegistry } from "../packages/core/src/lsp/registry.ts"

const fixture = join(import.meta.dir, "../packages/core/test/lsp/fixtures/server.ts")
const scripted = (...flags: string[]) => ({ command: process.execPath, args: [fixture, ...flags], languages: { plaintext: ["**/*.txt"] } })
const rule = (title: string) => console.log(`\n${"=".repeat(8)} ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "lh-lsp-demo-")))

const TEXT_BEFORE = ["let unused = WARN(unused)", "call(ERROR(old))", "end"].join("\n")
const TEXT_AFTER = ["// a line added above", "let unused = WARN(unused)", "call(ERROR(old))", "fresh(ERROR(fetchUser))", "end"].join("\n")

const PY_BEFORE = ['import os', "", "", "def greet(name: str) -> str:", '    name + "!"', '    return "hello " + name + undefined_suffix', ""].join("\n")
const PY_AFTER = ["# greeting helpers", ...PY_BEFORE.split("\n").slice(0, -1), "", "", "print(greet(42))", 'print(gret("x"))', ""].join("\n")

async function run(title: string, section: LspConfigSection, file: string, before: string, after: string, options: { readyMs?: number; pauseMs?: number; then?: string } = {}) {
  rule(title)
  const notices: LspNotice[] = []
  const workspace = join(scratch, title.replace(/\W+/g, "-"))
  await Bun.write(join(workspace, file), before)
  const registry = createLspRegistry({ plan: planLspServers(section, undefined, () => false), cwd: workspace, onNotice: (n) => notices.push(n) })
  // The agent reads the file first: the server starts and gets the text as it is.
  registry.observe(join(workspace, file), before)
  if (options.readyMs !== undefined) {
    const until = performance.now() + options.readyMs
    while (performance.now() < until && registry.status()[0]?.state !== "ready" && registry.status()[0]?.state !== "retrying") await Bun.sleep(20)
    const started = performance.now() - (until - options.readyMs)
    console.log(`server state after the read: ${registry.status()[0]?.state} (${Math.round(started)} ms)`)
    if (registry.status()[0]?.state === "ready") {
      // Give it the moment a real agent's turn gives it between the read and the edit.
      await Bun.sleep(options.pauseMs ?? 100)
    }
  }
  const seen = registry.status().map((s) => s.pid)
  await Bun.write(join(workspace, file), after)
  const result = await registry.diagnose({ path: file, before, after })
  show(result)
  if (options.then !== undefined) {
    console.log("\nA second edit of the same file, with the server warm:")
    await Bun.write(join(workspace, file), options.then)
    show(await registry.diagnose({ path: file, before: after, after: options.then }))
  }
  for (const notice of notices) console.log(`for the user (not the model): [${notice.kind}] ${notice.message}`)
  const pids = [...new Set([...seen, ...registry.status().map((s) => s.pid)])].filter((pid): pid is number => pid !== null)
  await registry.stop()
  console.log(`stopped; server processes still running: ${pids.filter(isRunning).length} of ${pids.length}`)
}

function show(result: DiagnoseResult) {
  console.log(`diagnose returned after ${result.waitedMs} ms`)
  for (const server of result.servers)
    console.log(
      `  ${server.server}: ${server.outcome}${server.detail === null ? "" : ` (${server.detail})`}${server.comparison === null ? "" : `, ${server.comparison.added.length} new, ${server.comparison.preExisting} pre-existing, ${server.comparison.fixed} fixed`}`,
    )
  console.log(`recorded: ${JSON.stringify({ noteAdded: result.note !== null, listed: result.listed, omitted: result.omitted, servers: result.servers.map((s) => ({ name: s.server, outcome: s.outcome })) })}`)
  console.log(result.note === null ? "the model sees: (nothing added to the tool result)" : `the model sees, after the tool's output:\n\n${result.note}\n`)
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const argv = process.argv.slice(2)
try {
  if (argv[0] === "--python") {
    const command = argv.slice(argv.indexOf("--") + 1)
    if (command.length === 0) throw new Error("usage: --python -- <command> [args...]")
    await run(
      "a real Python language server",
      { waitMs: 5000, servers: { python: { command: command[0]!, args: command.slice(1), languages: { python: ["**/*.py"] }, rootMarkers: ["pyproject.toml"] } } },
      "greet.py",
      PY_BEFORE,
      PY_AFTER,
      { readyMs: 15_000, pauseMs: 3000, then: `${PY_AFTER}print(os.sep + 1)\n` },
    )
  } else {
    await run("an edit that adds an error", { servers: { fixture: scripted() } }, "src/app.txt", TEXT_BEFORE, TEXT_AFTER, { readyMs: 5000 })
    await run("a server that never answers", { servers: { mute: scripted("--silent") } }, "src/app.txt", TEXT_BEFORE, TEXT_AFTER)
    await run("a server that crashes on the edit", { servers: { flaky: scripted("--crash-on-change", "1") } }, "src/app.txt", TEXT_BEFORE, TEXT_AFTER, { readyMs: 5000 })
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
