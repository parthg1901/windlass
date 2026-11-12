/**
 * `windlass tui`: the full-screen terminal interface. The CLI parses the arguments
 * and calls `runTui`; everything after that is here.
 *
 * The terminal is put back on every way out: a normal quit, the second
 * Ctrl-C, SIGTERM, SIGHUP, and a crash of the TUI itself (an uncaught error
 * restores the terminal first, then prints the error).
 */
import { homedir } from "node:os"
import { createCliRenderer } from "@opentui/core"
import { brand } from "@windlass/core"
import type { Scenario } from "@windlass/core/testing/scenarios"
import { AcpBackend } from "./acp-client.ts"
import { App } from "./app.ts"
import type { Backend, OpenSettings, OpenTarget } from "./backend.ts"
import { DemoBackend } from "./demo-backend.ts"
import { Theme, colorEnabled } from "./theme.ts"

export { App } from "./app.ts"
export { AcpBackend } from "./acp-client.ts"
export { DemoBackend } from "./demo-backend.ts"
export { Transcript } from "./transcript.ts"
export { Theme } from "./theme.ts"

/** Turns the TUI on for `windlass` run interactively with no prompt (until it is the default). */
export const TUI_ENV = `${brand.envPrefix}TUI`
/** Shows events this client does not know as dim rows. */
export const DEBUG_ENV = `${brand.envPrefix}TUI_DEBUG`

export interface TuiOptions {
  readonly cwd: string
  readonly target: OpenTarget
  readonly settings: OpenSettings
  readonly env: Record<string, string | undefined>
  readonly version: string
  /** The command that serves ACP on stdio. */
  readonly serverCommand: readonly string[]
  /** A scripted session to play instead of the real engine. */
  readonly demo: { readonly scenario: Scenario; readonly name: string; readonly speed: number; readonly graceMs: number | null } | null
}

export async function runTui(options: TuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${brand.binary}: the TUI needs a terminal on stdin and stdout\n`)
    return 2
  }
  const backend: Backend =
    options.demo === null
      ? new AcpBackend({ command: options.serverCommand, env: options.env, version: options.version })
      : new DemoBackend(options.demo.scenario, options.demo.name, { speed: options.demo.speed, ...(options.demo.graceMs === null ? {} : { graceMs: options.demo.graceMs }) })
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: true,
    screenMode: "alternate-screen",
    targetFps: 30,
    autoFocus: false,
    consoleMode: "disabled",
    openConsoleOnError: false,
  })
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    try {
      renderer.destroy()
    } catch {}
  }
  process.once("exit", restore)
  // OpenTUI asks for `closed` to be awaited after `destroy()` before the process exits: a `process.exit` straight after
  // `destroy()` hangs (seen under tmux: the terminal was put back and the process never ended).
  const exitAfterRestore = async (code: number) => {
    restore()
    await Promise.race([renderer.closed.catch(() => {}), Bun.sleep(500)])
    process.exit(code)
  }
  const demo = backend instanceof DemoBackend ? backend : null
  const app = new App(renderer, {
    backend,
    theme: new Theme(colorEnabled(options.env)),
    cwd: options.cwd,
    target: options.target,
    settings: options.settings,
    debug: options.env[DEBUG_ENV] === "1",
    home: homedir(),
    exitNow: (code) => {
      void backend.stop()
      void exitAfterRestore(code)
    },
    ...(demo === null ? {} : { suggest: () => (demo.current !== null && demo.current.remaining > 0 ? demo.current.nextPrompt : null) }),
  })
  let crashed = false
  const crash = (error: unknown) => {
    if (crashed) return
    crashed = true
    void (async () => {
      // The message is written once the terminal is back on the main screen; written before, it would vanish with the
      // alternate screen, which `destroy()` leaves asynchronously.
      restore()
      await Promise.race([renderer.closed.catch(() => {}), Bun.sleep(1000)])
      process.stderr.write(`${brand.binary}: the TUI crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      const id = app.sessionId
      if (id !== null) process.stderr.write(`${brand.binary}: the session is safe; open it again with: ${brand.binary} tui --session ${id}\n`)
      await Promise.race([backend.stop(), Bun.sleep(1000)])
      process.exit(1)
    })()
  }
  process.on("uncaughtException", crash)
  process.on("unhandledRejection", crash)
  const signals: [NodeJS.Signals, number][] = [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130],
  ]
  const handlers = signals.map(([signal, code]) => {
    const handler = () => void app.leave(code)
    process.on(signal, handler)
    return () => process.off(signal, handler)
  })
  void app.start()
  const code = await app.done
  for (const off of handlers) off()
  restore()
  await Promise.race([renderer.closed.catch(() => {}), Bun.sleep(500)])
  process.off("uncaughtException", crash)
  process.off("unhandledRejection", crash)
  const id = app.sessionId
  if (app.farewell !== null) process.stdout.write(`${brand.binary}: ${app.farewell}\n`)
  if (id !== null && demo === null) process.stdout.write(`${brand.binary}: session ${id} · resume with: ${brand.binary} tui --session ${id}\n`)
  // Why it ended without a session, where it is seen after the screen is back.
  if (app.problem !== null && demo === null) process.stderr.write(`${brand.binary}: ${app.problem}\n`)
  return code
}

