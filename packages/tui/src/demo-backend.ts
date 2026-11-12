/**
 * The CLI's scripted demo engine as a TUI backend: any of the scripted
 * sessions (`windlass tui --demo <name>`) replayed with realistic timing, no model
 * and no tools. It is how the TUI is developed and tested without spending
 * model requests. It has no undo, no session list and no model list; the TUI
 * says so when they are asked for.
 */
import type { ApprovalHandler, Backend, BackendSession, Delivery, ModelChoice, OpenSettings, OpenTarget, QuestionHandler, StreamItem } from "./backend.ts"
import { FakeEngine, type FakeOptions, type FakeSession } from "./cli.ts"
import type { Scenario } from "@windlass/core/testing/scenarios"

export class DemoBackend implements Backend {
  readonly label: string
  readonly restartable = false
  onQuestion: QuestionHandler = async () => null
  onApproval: ApprovalHandler = async () => null
  onLog: (line: string, level: "warn" | "error" | "info") => void = () => {}
  private readonly engine: FakeEngine
  /** The session that was opened last, for the prompt the scripted turn starts with. */
  current: FakeSession | null = null

  constructor(
    private readonly scenario: Scenario,
    name: string,
    options: FakeOptions = {},
  ) {
    this.engine = new FakeEngine(scenario, options)
    this.label = `demo: ${name}`
  }

  async open(target: OpenTarget, cwd: string, settings: OpenSettings): Promise<BackendSession> {
    const session = await this.engine.open({ session: target.kind === "resume" ? { kind: "resume", id: target.id } : { kind: "new" }, cwd, model: settings.model, effort: settings.effort, maxSteps: settings.maxSteps })
    this.current = session
    return new DemoSession(session, cwd)
  }

  /** The scenario's model, with the context window it is played with, so the panel can say how full the window is. */
  async listModels(): Promise<{ defaultModel: string; models: ModelChoice[] }> {
    const created = this.scenario.phases.flatMap((phase) => phase.events).find((event) => event.type === "session.created")
    const model = created?.type === "session.created" ? created.data.settings.model : "demo"
    return { defaultModel: model, models: [{ id: model, name: `${model} (demo)`, efforts: [], defaultEffort: null, contextWindow: this.scenario.contextWindow ?? DEMO_CONTEXT_WINDOW, isDefault: true }] }
  }

  async stop(): Promise<void> {}
}

/** The window a demo is played with when its scenario names none: a typical one for the models the account offers. */
export const DEMO_CONTEXT_WINDOW = 272_000

class DemoSession implements BackendSession {
  readonly id: string
  readonly events: AsyncIterable<StreamItem>

  constructor(
    private readonly session: FakeSession,
    readonly cwd: string,
  ) {
    this.id = session.id
    const source = session.events
    this.events = {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) yield { event, replay: false }
      },
    }
  }

  send(text: string, delivery: Delivery): Promise<string | null> {
    return this.session.send(text, { delivery })
  }

  interrupt(): void {
    this.session.interrupt()
  }

  close(): Promise<void> {
    return this.session.close()
  }

  lost(): string | null {
    return null
  }
}
