/**
 * The CLI's scripted demo engine as a TUI backend: any of the scripted
 * sessions (`lh tui --demo <name>`) replayed with realistic timing, no model
 * and no tools. It is how the TUI is developed and tested without spending
 * model requests. It has no undo, no session list and no model list; the TUI
 * says so when they are asked for.
 */
import type { Backend, BackendSession, Delivery, OpenSettings, OpenTarget, QuestionHandler, StreamItem } from "./backend.ts"
import { FakeEngine, type FakeOptions, type FakeSession } from "./cli.ts"
import type { Scenario } from "@light-harness/core/testing/scenarios"

export class DemoBackend implements Backend {
  readonly label: string
  readonly restartable = false
  onQuestion: QuestionHandler = async () => null
  onLog: (line: string, level: "warn" | "error" | "info") => void = () => {}
  private readonly engine: FakeEngine
  /** The session that was opened last, for the prompt the scripted turn starts with. */
  current: FakeSession | null = null

  constructor(scenario: Scenario, name: string, options: FakeOptions = {}) {
    this.engine = new FakeEngine(scenario, options)
    this.label = `demo: ${name}`
  }

  async open(target: OpenTarget, cwd: string, settings: OpenSettings): Promise<BackendSession> {
    const session = await this.engine.open({ session: target.kind === "resume" ? { kind: "resume", id: target.id } : { kind: "new" }, cwd, model: settings.model, effort: settings.effort, maxSteps: settings.maxSteps })
    this.current = session
    return new DemoSession(session, cwd)
  }

  async stop(): Promise<void> {}
}

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
