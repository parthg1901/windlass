/**
 * Component tests mount the real `App` on OpenTUI's test renderer at a fixed
 * size, against the CLI's scripted demo engine played instantly (speed 0,
 * a fixed virtual clock), so a frame is the same on every run and can be
 * compared as text.
 */
import type { HooksStateResult, LspStateResult, McpStateResult } from "@windlass/acp/extensions"
import { createTestRenderer } from "@opentui/core/testing"
import type { NewEvent, SessionId, StoredEvent } from "@windlass/core"
import type { Scenario } from "@windlass/core/testing/scenarios"
import { App } from "../src/app.ts"
import type { ApprovalHandler, TurnNotification, Backend, BackendSession, Delivery, OpenSettings, OpenTarget, Question, StreamItem } from "../src/backend.ts"
import { EventQueue } from "../src/acp-client.ts"
import { type EngineEvent, findScenario } from "../src/cli.ts"
import { DemoBackend } from "../src/demo-backend.ts"
import { Theme } from "../src/theme.ts"

export const CLOCK_START = Date.UTC(2026, 10, 12, 9, 0, 0)

export interface Mounted {
  readonly app: App
  readonly backend: Backend
  readonly setup: Awaited<ReturnType<typeof createTestRenderer>>
  readonly exits: number[]
  /** The test's clock, which the app reads for live durations. */
  readonly clock: { now: number }
  /** Renders and returns the frame as text, trailing spaces trimmed. */
  frame(): Promise<string>
  /** Lets queued events and promises run, then renders. */
  settle(rounds?: number): Promise<void>
  dispose(): Promise<void>
}

export interface MountOptions {
  readonly width: number
  readonly height: number
  /** A demo scenario by name or number, or a backend to use. */
  readonly scenario?: string
  readonly backend?: Backend
  readonly color?: boolean
}

export async function mount(options: MountOptions): Promise<Mounted> {
  const setup = await createTestRenderer({ width: options.width, height: options.height, exitOnCtrlC: false })
  const clock = { now: CLOCK_START + 60_000 }
  const backend = options.backend ?? demoBackend(options.scenario ?? "find-and-fix-a-failing-test")
  const exits: number[] = []
  const demo = backend instanceof DemoBackend ? backend : null
  const app = new App(setup.renderer, {
    backend,
    theme: new Theme(options.color ?? false),
    cwd: "/work",
    target: { kind: "new" },
    settings: { model: null, effort: null, maxSteps: null },
    debug: false,
    home: null,
    now: () => clock.now,
    ticking: false,
    exitNow: (code) => void exits.push(code),
    ...(demo === null ? {} : { suggest: () => (demo.current !== null && demo.current.remaining > 0 ? demo.current.nextPrompt : null) }),
  })
  await app.start()
  const settle = async (rounds = 20) => {
    for (let index = 0; index < rounds; index += 1) await Bun.sleep(0)
    await setup.renderOnce()
  }
  await settle()
  return {
    app,
    backend,
    setup,
    exits,
    clock,
    settle,
    frame: async () => {
      await setup.renderOnce()
      return setup
        .captureCharFrame()
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
    },
    dispose: async () => {
      app.dispose()
      await setup.dispose()
    },
  }
}

export function demoBackend(name: string, speed = 0): DemoBackend {
  const found = findScenario(name)
  if (found === null) throw new Error(`no demo scenario ${name}`)
  return new DemoBackend(found.scenario, found.name, { speed, clockStart: CLOCK_START })
}

/** Plays every scripted turn of a demo to its end, sending each scripted prompt as the user would. */
export async function playAll(mounted: Mounted): Promise<void> {
  const backend = mounted.backend as DemoBackend
  for (let guard = 0; guard < 20; guard += 1) {
    const session = backend.current
    if (session === null || session.remaining === 0) break
    mounted.setup.mockInput.pressEnter()
    await mounted.settle()
    await session.idle()
    await mounted.settle()
  }
}

/** Gives every event of a scenario its position, as a store would. */
export function stamp(scenario: Scenario, sessionId = "ses_test"): StoredEvent[] {
  let seq = 0
  return scenario.phases.flatMap((phase) => phase.events).map((event: NewEvent) => ({ ...event, sessionId: sessionId as SessionId, seq: ++seq, time: CLOCK_START + seq * 100 }) as StoredEvent)
}

/**
 * A backend whose sessions play exactly the events a test hands them, and
 * record what the app asked for: the most direct way to test one behaviour.
 */
export class ScriptBackend implements Backend {
  readonly label = "script"
  readonly restartable = false
  onQuestion: (question: Question) => Promise<string | null> = async () => null
  onApproval: ApprovalHandler = async () => null
  onLog: (line: string, level: "warn" | "error" | "info") => void = () => {}
  readonly sent: { text: string; delivery: Delivery }[] = []
  interrupts = 0
  session: ScriptSession | null = null
  failOpen: Error | null = null

  async open(_target: OpenTarget, cwd: string, _settings: OpenSettings): Promise<BackendSession> {
    if (this.failOpen !== null) throw this.failOpen
    this.session = new ScriptSession(this, cwd)
    return this.session
  }

  async stop(): Promise<void> {}
}

export class ScriptSession implements BackendSession {
  readonly id = "ses_script"
  readonly queue = new EventQueue<StreamItem>()
  private seq = 0
  gone: string | null = null
  // Features a test gives the session when it needs them.
  approval?: BackendSession["approval"]
  clearTaint?: BackendSession["clearTaint"]
  configChoices?: BackendSession["configChoices"]
  setConfig?: BackendSession["setConfig"]
  diff?: BackendSession["diff"]
  rename?: BackendSession["rename"]
  compact?: BackendSession["compact"]
  agents?: BackendSession["agents"]
  storedEvents?: BackendSession["storedEvents"]
  fork?: BackendSession["fork"]
  mcp?: BackendSession["mcp"]
  approveMcp?: BackendSession["approveMcp"]
  hooks?: BackendSession["hooks"]
  approveHook?: BackendSession["approveHook"]
  lsp?: BackendSession["lsp"]
  approveLsp?: BackendSession["approveLsp"]
  skills?: BackendSession["skills"]
  wakeups?: BackendSession["wakeups"]
  cancelWake?: BackendSession["cancelWake"]
  wakeSecret?: BackendSession["wakeSecret"]
  memory?: BackendSession["memory"]
  memoryChange?: BackendSession["memoryChange"]
  commands?: BackendSession["commands"]
  sendCommand?: BackendSession["sendCommand"]
  cancelCall?: BackendSession["cancelCall"]
  private readonly mcpListeners = new Set<(state: McpStateResult) => void>()

  onMcp(listener: (state: McpStateResult) => void): () => void {
    this.mcpListeners.add(listener)
    return () => void this.mcpListeners.delete(listener)
  }

  /** The server says the MCP servers changed. */
  pushMcp(state: McpStateResult): void {
    for (const listener of this.mcpListeners) listener(state)
  }

  private readonly hookListeners = new Set<(state: HooksStateResult) => void>()
  private readonly lspListeners = new Set<(state: LspStateResult) => void>()

  onHooks(listener: (state: HooksStateResult) => void): () => void {
    this.hookListeners.add(listener)
    return () => void this.hookListeners.delete(listener)
  }

  onLsp(listener: (state: LspStateResult) => void): () => void {
    this.lspListeners.add(listener)
    return () => void this.lspListeners.delete(listener)
  }

  /** The server says the hooks changed. */
  pushHooks(state: HooksStateResult): void {
    for (const listener of this.hookListeners) listener(state)
  }

  /** The server says the language servers changed. */
  pushLsp(state: LspStateResult): void {
    for (const listener of this.lspListeners) listener(state)
  }

  constructor(
    private readonly backend: ScriptBackend,
    readonly cwd: string,
  ) {}

  get events(): AsyncIterable<StreamItem> {
    return this.queue
  }

  /** Emits events as if the server sent them; durable ones get a position. */
  emit(...events: (NewEvent | EngineEvent)[]): void {
    for (const event of events) {
      const stored = "v" in event && !("seq" in event) ? ({ ...event, sessionId: this.id as SessionId, seq: ++this.seq, time: CLOCK_START + this.seq * 100 } as StoredEvent) : (event as EngineEvent)
      this.queue.push({ event: stored, replay: false })
    }
  }

  async send(text: string, delivery: Delivery): Promise<string | null> {
    this.backend.sent.push({ text, delivery })
    return `msg_${this.backend.sent.length}`
  }

  interrupt(): void {
    this.backend.interrupts += 1
  }

  async close(): Promise<void> {
    this.queue.end()
  }

  lost(): string | null {
    return this.gone
  }

  /** How a turn ended, as the server says after its events. */
  turn(turn: TurnNotification): void {
    this.queue.push({ turn, replay: turn.replay === true })
  }

  /** The server went away. */
  die(reason: string): void {
    this.gone = reason
    this.queue.end()
  }
}
