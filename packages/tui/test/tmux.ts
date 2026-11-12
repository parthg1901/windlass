/**
 * Drives a real pseudo-terminal through tmux, for end-to-end tests of the
 * TUI (and anything else full-screen).
 *
 * Every pane lives on a private tmux server (`-L <socket>`), so tests never
 * touch the user's own sessions and one `killServer()` removes everything.
 * The program runs under a shell that records its exit status and keeps the pane, so a test can
 * read the exit status and the last frame. Waiting is always a bounded poll
 * of the captured pane, never a bare sleep.
 *
 *   const term = await Tmux.start({ width: 100, height: 30, command: ["bun", MAIN, "tui", "--demo", "1"] })
 *   await term.waitFor("● ready")
 *   term.keys("Enter")
 *   const frame = await term.waitFor(/done/)
 *   term.kill()
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface StartOptions {
  readonly width: number
  readonly height: number
  readonly command: readonly string[]
  readonly env?: Record<string, string>
  readonly cwd?: string
  /** The tmux server; one per test file keeps files apart. */
  readonly socket?: string
}

export interface WaitOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
}

let counter = 0
let configDir: string | null = null

/** The private directory for the tmux config and the exit-status files, made on first use. */
function workDir(): string {
  if (configDir !== null) return configDir
  configDir = mkdtempSync(join(tmpdir(), "lh-tmux-"))
  // A large history allows reading back what a program printed after it left the alternate screen.
  writeFileSync(join(configDir, "tmux.conf"), ["set -g history-limit 5000", 'set -g default-terminal "tmux-256color"', "set -g escape-time 10", "set -g status off"].join("\n"))
  return configDir
}

export const DEFAULT_SOCKET = `lh-tui-test-${process.pid}`

export class Tmux {
  private constructor(
    readonly socket: string,
    readonly name: string,
    private readonly statusFile: string,
  ) {}

  static async start(options: StartOptions): Promise<Tmux> {
    const socket = options.socket ?? DEFAULT_SOCKET
    const name = `t${process.pid}-${++counter}`
    const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`])
    // The program runs under a shell that writes its exit status to a file, then stays: tmux's own
    // `pane_dead_status` is empty when tmux sees the pty close before it reaps the process (lost about one run in
    // five), and a dead pane reports its cursor as hidden whatever the program left, so modes are read while the
    // shell still holds the pane.
    const dir = workDir()
    const statusFile = join(dir, `${name}.status`)
    const script = `${shellJoin(options.command)}; echo $? > ${statusFile}; exec sleep 600`
    const result = tmux(socket, ["-f", join(dir, "tmux.conf"), "new-session", "-d", "-s", name, "-x", String(options.width), "-y", String(options.height), ...(options.cwd === undefined ? [] : ["-c", options.cwd]), ...env, script])
    if (result.exitCode !== 0) throw new Error(`tmux new-session failed: ${result.stderr}`)
    // The window follows the size given here, not the size of an attached client (there is none).
    tmux(socket, ["set-option", "-t", name, "window-size", "manual"])
    return new Tmux(socket, name, statusFile)
  }

  /** Keys by tmux name: `Enter`, `Escape`, `C-c`, `M-Up`, `PageUp`, `BSpace`, `Tab`, or plain characters. */
  keys(...keys: string[]): void {
    this.run(["send-keys", "-t", this.name, ...keys])
  }

  /** Text exactly as typed, one key per character (no key-name lookup). */
  type(text: string): void {
    this.run(["send-keys", "-t", this.name, "-l", text])
  }

  /** A bracketed paste, as a terminal sends one: newlines inside it must not submit. */
  paste(text: string): void {
    const buffer = `${this.name}-paste`
    const loaded = Bun.spawnSync(["tmux", "-L", this.socket, "load-buffer", "-b", buffer, "-"], { stdin: new TextEncoder().encode(text) })
    if (loaded.exitCode !== 0) throw new Error(`tmux load-buffer failed: ${loaded.stderr.toString()}`)
    this.run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", this.name])
  }

  /** Bytes as they are, for sequences tmux has no key name for (an SGR mouse report). */
  raw(sequence: string): void {
    this.run(["send-keys", "-t", this.name, "-l", sequence])
  }

  /** The mouse wheel at a cell (1-based column and row), as an SGR report. */
  wheel(direction: "up" | "down", column = 10, row = 5): void {
    this.raw(`\x1b[<${direction === "up" ? 64 : 65};${column};${row}M`)
  }

  /**
   * The visible pane as text. `colors` keeps the escape sequences (SGR) so colour and attributes can be checked;
   * `history` adds the lines scrolled off the top (what a program printed after it left the alternate screen).
   */
  capture(options: { colors?: boolean; history?: boolean } = {}): string {
    const result = this.run(["capture-pane", "-p", ...(options.colors === true ? ["-e"] : []), ...(options.history === true ? ["-S", "-"] : []), "-t", this.name])
    // One line per row: the newline after the last row is not a row.
    return result.stdout.replace(/\n$/, "")
  }

  /** Polls the pane until `expected` is on it; returns that frame. Fails with the last frame after `timeoutMs`. */
  async waitFor(expected: string | RegExp | ((frame: string) => boolean), options: WaitOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 10_000
    const intervalMs = options.intervalMs ?? 50
    const matches = typeof expected === "function" ? expected : (frame: string) => (typeof expected === "string" ? frame.includes(expected) : expected.test(frame))
    const deadline = Date.now() + timeoutMs
    let frame = ""
    for (;;) {
      frame = this.capture()
      if (matches(frame)) return frame
      if (Date.now() > deadline) throw new Error(`waited ${timeoutMs} ms for ${String(expected)}; the pane shows:\n${frame}`)
      await Bun.sleep(intervalMs)
    }
  }

  /** Waits for the program to exit; returns its exit status (128 + n when a signal ended it). */
  async exited(options: WaitOptions = {}): Promise<number> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000)
    for (;;) {
      const file = Bun.file(this.statusFile)
      if (await file.exists()) {
        const text = (await file.text()).trim()
        if (text !== "") return Number(text)
      }
      if (Date.now() > deadline) throw new Error(`the program did not exit; the pane shows:\n${this.capture()}`)
      await Bun.sleep(options.intervalMs ?? 50)
    }
  }

  /** The terminal modes the program left set: a TUI that exits cleanly leaves none of the first two on. */
  modes(): { alternateScreen: boolean; mouse: boolean; cursorVisible: boolean } {
    const [alternate, mouse, cursor] = this.format("#{alternate_on}|#{mouse_any_flag}|#{cursor_flag}").split("|")
    return { alternateScreen: alternate === "1", mouse: mouse === "1", cursorVisible: cursor === "1" }
  }

  /** Whether the program has exited (its status is known). */
  async ended(): Promise<boolean> {
    return Bun.file(this.statusFile).exists()
  }

  resize(width: number, height: number): void {
    this.run(["resize-window", "-t", this.name, "-x", String(width), "-y", String(height)])
  }

  /** The program's process (a child of the shell the pane runs). */
  get pid(): number {
    const shell = this.format("#{pane_pid}")
    const listed = Bun.spawnSync(["pgrep", "-P", shell]).stdout.toString().trim().split("\n")[0]
    return Number(listed)
  }

  /** Child processes of the program whose command line contains `pattern`. Kill these by PID, never by pattern. */
  children(pattern: string): number[] {
    const listed = Bun.spawnSync(["pgrep", "-P", String(this.pid), "-f", pattern])
    return listed.stdout
      .toString()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(Number)
  }

  kill(): void {
    tmux(this.socket, ["kill-session", "-t", this.name])
  }

  private format(format: string): string {
    return this.run(["display-message", "-p", "-t", this.name, format]).stdout.trim()
  }

  private run(args: readonly string[]): { stdout: string; stderr: string } {
    const result = tmux(this.socket, args)
    if (result.exitCode !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr}`)
    return result
  }
}

/**
 * Ends the private tmux server and everything on it, and removes what it left: its socket file (`kill-server`
 * leaves it behind) and the helper's directory. Call it from `afterAll`.
 */
export function killServer(socket = DEFAULT_SOCKET): void {
  tmux(socket, ["kill-server"])
  // Where tmux puts `-L` sockets; the server may be gone already (it exits with its last session).
  rmSync(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
  if (configDir !== null) rmSync(configDir, { recursive: true, force: true })
  configDir = null
}

function tmux(socket: string, args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["tmux", "-L", socket, ...args])
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

/** One shell word per argument, so tmux's `sh -c` runs exactly this command. */
function shellJoin(command: readonly string[]): string {
  return `${command.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)).join(" ")}`
}
