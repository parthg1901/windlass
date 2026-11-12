/**
 * The TUI in a real pseudo-terminal (tmux), as a user drives it: against the
 * scripted demo engine, and against the real `lh acp` server with a scripted
 * model (`LH_ACP_SCRIPT`) in a temporary git workspace and data directory.
 * No model requests are made.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tmux, killServer } from "./tmux.ts"

const MAIN = new URL("../../cli/src/main.ts", import.meta.url).pathname
const READY = "● ready"
const open: Tmux[] = []
const dirs: string[] = []

afterEach(() => {
  for (const term of open.splice(0)) term.kill()
})
afterAll(() => {
  killServer()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function start(args: readonly string[], options: { width?: number; height?: number; env?: Record<string, string>; preload?: string } = {}): Promise<Tmux> {
  const bun = options.preload === undefined ? [process.execPath] : [process.execPath, "--preload", options.preload]
  const term = await Tmux.start({ width: options.width ?? 100, height: options.height ?? 30, command: [...bun, MAIN, "tui", ...args], env: { NO_COLOR: "", ...options.env } })
  open.push(term)
  return term
}

/** A git workspace, a private data directory and a scripted model, for `lh acp`. */
function workspace(responses: readonly unknown[]): { cwd: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "lh-tui-e2e-"))
  dirs.push(root)
  const cwd = join(root, "work")
  Bun.spawnSync(["mkdir", "-p", cwd, join(root, "xdg")])
  writeFileSync(join(cwd, "README.md"), "# demo\n")
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]]) Bun.spawnSync(["git", ...args], { cwd })
  writeFileSync(join(root, "script.json"), JSON.stringify({ responses }))
  return { cwd, env: { XDG_DATA_HOME: join(root, "xdg"), LH_ACP_SCRIPT: join(root, "script.json") } }
}

/** The conversation column of a frame as one line of words: the panel on the right is left out. */
function conversation(frame: string): string {
  return frame
    .split("\n")
    .map((line) => line.split("│")[0]!)
    .join(" ")
    .replace(/\s+/g, " ")
}

const WRITE_TURN = [
  [
    { type: "text", text: "Creating `notes.md`." },
    { type: "tool_call", callId: "c1", name: "write", input: { path: "notes.md", content: "first\nsecond\n" } },
    { type: "usage", inputTokens: 1200, cachedInputTokens: 0, outputTokens: 30 },
  ],
  [
    { type: "text", text: "Created notes.md." },
    { type: "usage", inputTokens: 1300, cachedInputTokens: 1152, outputTokens: 10 },
  ],
]

describe("against the scripted demo engine", () => {
  test("a full turn with tool calls, then quit with Ctrl-D", async () => {
    const term = await start(["--demo", "find-and-fix-a-failing-test", "--demo-speed", "4"])
    await term.waitFor((frame) => frame.includes(READY) && frame.includes("› The add test is failing"))
    term.keys("Enter")
    await term.waitFor("running")
    const frame = await term.waitFor("○ done · no checks configured", { timeoutMs: 20_000 })
    expect(frame).toContain("✓ grep add\\( in src · 4 matches in 3 files")
    expect(frame).toContain("✓ edit src/add.ts · +1 -1")
    expect(frame).toContain("Cache per call")
    term.keys("C-d")
    expect(await term.exited()).toBe(0)
    // tmux may not have processed the program's last bytes when its exit is known: the screen and the modes are polled.
    await term.waitFor((frame) => !frame.includes(READY))
    await term.until(() => !term.modes().alternateScreen)
    expect(term.modes()).toEqual({ alternateScreen: false, mouse: false, cursorVisible: true })
  }, 40_000)

  test("a crash of the TUI itself puts the terminal back and says how to reopen the session", async () => {
    const root = mkdtempSync(join(tmpdir(), "lh-tui-crash-"))
    dirs.push(root)
    const preload = join(root, "crash.ts")
    // Thrown from a timer once the TUI is up: an uncaught error, as a bug in a handler would be.
    writeFileSync(preload, 'setTimeout(() => { throw new Error("boom from a test") }, 2500)\n')
    const term = await start(["--demo", "a-plain-answer"], { preload })
    await term.waitFor(READY)
    expect(term.modes().alternateScreen).toBe(true)
    expect(await term.exited({ timeoutMs: 8000 })).toBe(1)
    await term.until(() => term.capture({ history: true }).includes("open it again with"))
    const frame = term.capture({ history: true })
    expect(frame).toContain("the TUI crashed: Error: boom from a test")
    expect(frame).toContain("open it again with: lh tui --session ses_demo")
    // tmux may not have processed the program's last bytes when its exit is known: the screen and the modes are polled.
    await term.waitFor((frame) => !frame.includes(READY))
    await term.until(() => !term.modes().alternateScreen)
    expect(term.modes()).toEqual({ alternateScreen: false, mouse: false, cursorVisible: true })
  }, 40_000)

  test("steering mid-turn: the message waits, then is delivered into the turn", async () => {
    const term = await start(["--demo", "a-long-build-command"])
    await term.waitFor(READY)
    term.keys("Enter")
    await term.waitFor("running shell bun run build")
    expect(term.capture()).toContain("steer ›")
    term.type("also tell me the test count")
    term.keys("Enter")
    // The pending line shortens the message to fit; its start is enough.
    await term.waitFor('↳ steering: "also tell me')
    const frame = await term.waitFor("↳ steered into the turn", { timeoutMs: 20_000 })
    expect(frame).toContain("› also tell me the test count")
  }, 40_000)

  test("Ctrl-C once stops the turn and says so", async () => {
    const term = await start(["--demo", "a-long-build-command"])
    await term.waitFor(READY)
    term.keys("Enter")
    await term.waitFor("running shell bun run build")
    term.keys("C-c")
    await term.waitFor("■ stopping… · press Ctrl-C again to exit now")
    const frame = await term.waitFor("■ interrupted", { timeoutMs: 15_000 })
    expect(frame).toContain(READY)
    expect(await term.ended()).toBe(false)
  }, 40_000)

  test("Ctrl-C twice within two seconds exits at once, with the terminal put back", async () => {
    const term = await start(["--demo", "a-long-build-command", "--demo-grace", "5000"])
    await term.waitFor(READY)
    term.keys("Enter")
    await term.waitFor("running shell bun run build")
    term.keys("C-c")
    await term.waitFor("stopping")
    term.keys("C-c")
    expect(await term.exited({ timeoutMs: 3000 })).toBe(130)
    // tmux may not have processed the program's last bytes when its exit is known: the screen and the modes are polled.
    await term.waitFor((frame) => !frame.includes(READY))
    await term.until(() => !term.modes().alternateScreen)
    expect(term.modes()).toEqual({ alternateScreen: false, mouse: false, cursorVisible: true })
  }, 40_000)

  test("resize while streaming keeps every line within the width", async () => {
    const term = await start(["--demo", "find-and-fix-a-failing-test"], { width: 120, height: 34 })
    await term.waitFor(READY)
    term.keys("Enter")
    await term.waitFor("running")
    for (const [width, height] of [[60, 20], [200, 50], [80, 24]] as const) {
      term.resize(width, height)
      const frame = await term.waitFor((text) => text.split("\n").filter((line) => line !== "").length > 3 && text.split("\n").length >= height)
      for (const line of frame.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width)
    }
    const frame = await term.waitFor("○ done", { timeoutMs: 30_000 })
    expect(frame.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true)
  }, 60_000)
})

describe("against lh acp with a scripted model", () => {
  test("undo asks before it overwrites a file edited by hand", async () => {
    const space = workspace(WRITE_TURN)
    const term = await start(["--cwd", space.cwd], { env: space.env })
    await term.waitFor(READY, { timeoutMs: 20_000 })
    term.type("write the notes")
    term.keys("Enter")
    await term.waitFor("○ done", { timeoutMs: 20_000 })
    expect(existsSync(join(space.cwd, "notes.md"))).toBe(true)
    writeFileSync(join(space.cwd, "notes.md"), "first\nsecond\nmine\n")
    term.type("/undo")
    term.keys("Enter")
    const question = await term.waitFor("Undo: overwrite 1 file edited by hand since then?")
    expect(question).toContain("[y] Overwrite them")
    expect(question).toContain("[n] Change nothing")
    term.keys("y")
    await term.waitFor("↶ went back · 1 file restored")
    expect(existsSync(join(space.cwd, "notes.md"))).toBe(false)
  }, 60_000)

  test("the session picker switches to an earlier session and shows its history", async () => {
    const space = workspace(WRITE_TURN)
    const term = await start(["--cwd", space.cwd], { env: space.env })
    await term.waitFor(READY, { timeoutMs: 20_000 })
    term.type("write the notes")
    term.keys("Enter")
    await term.waitFor("○ done", { timeoutMs: 20_000 })
    term.type("/new")
    term.keys("Enter")
    await term.waitFor((frame) => frame.includes(READY) && !frame.includes("write the notes"))
    term.type("/sessions")
    term.keys("Enter")
    const picker = await term.waitFor("+ new session")
    expect(picker.match(/ses_/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // The newest (the current, empty) session is first; the earlier one is below it.
    term.keys("Down", "Down", "Enter")
    const frame = await term.waitFor("› write the notes")
    expect(frame).toContain("✓ write notes.md · created")
  }, 60_000)

  test("a killed server: the TUI says so and how to resume, and /reconnect resumes", async () => {
    const space = workspace(WRITE_TURN)
    const term = await start(["--cwd", space.cwd], { env: space.env })
    await term.waitFor(READY, { timeoutMs: 20_000 })
    const [server] = term.children("main.ts acp")
    expect(server).toBeGreaterThan(0)
    process.kill(server!, "SIGKILL")
    const frame = await term.waitFor("the engine is gone")
    // The sentence wraps at this width: compare it as one line.
    expect(conversation(frame)).toContain("the engine process was killed (SIGKILL)")
    expect(frame).toContain("/reconnect")
    expect(frame).toContain("✗ disconnected")
    term.type("/reconnect")
    term.keys("Enter")
    await term.waitFor(READY, { timeoutMs: 20_000 })
  }, 60_000)

  test("a server that writes to stderr does not corrupt the screen", async () => {
    const space = workspace(WRITE_TURN)
    const term = await start(["--cwd", space.cwd], { env: { ...space.env, LH_ACP_LOG: "debug" } })
    await term.waitFor(READY, { timeoutMs: 20_000 })
    term.type("write the notes")
    term.keys("Enter")
    const frame = await term.waitFor("○ done", { timeoutMs: 20_000 })
    // Debug lines go to the TUI's own rows (info is dropped), never raw onto the terminal.
    expect(frame).not.toMatch(/acp debug:/)
    expect(frame.split("\n").at(-3)).toContain(READY)
  }, 60_000)
})
