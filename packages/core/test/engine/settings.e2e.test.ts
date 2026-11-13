/**
 * Settings the provider does not offer are refused before anything is
 * created or sent, and a session says how its calls are decided before its
 * first turn has read the configuration files.
 */
import { afterAll, afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarness } from "../../src/assembly.ts"
import { brand } from "../../src/brand.ts"
import { EngineError } from "../../src/engine/engine.ts"
import { SUBAGENT_NOTE, taskMessage } from "../../src/engine/spawn.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const MODELS = [{ id: "gpt-test", efforts: ["low", "medium", "high"] }, { id: "gpt-plain" }, "gpt-bare"]
const errorOf = async (work: () => unknown): Promise<EngineError> => {
  try {
    await work()
  } catch (error) {
    if (error instanceof EngineError) return error
    throw error
  }
  throw new Error("expected an EngineError")
}

describe("an effort the model does not offer", () => {
  test("validateSettings refuses it and names the efforts the model accepts", async () => {
    const h = new Harness({ models: MODELS })
    try {
      const refused = await errorOf(() => h.engine.validateSettings({ model: "gpt-test", reasoningEffort: "ultra" }))
      expect(refused.code).toBe("unknown_effort")
      expect(refused.message).toBe('model gpt-test does not offer the reasoning effort "ultra"; it accepts: low, medium, high')
      // A model the listing lacks is refused as before; what the listing does not say about efforts is not checked.
      expect((await errorOf(() => h.engine.validateSettings({ model: "gpt-none", reasoningEffort: null }))).code).toBe("unknown_model")
      await h.engine.validateSettings({ model: "gpt-test", reasoningEffort: "high" })
      await h.engine.validateSettings({ model: "gpt-test", reasoningEffort: null })
      await h.engine.validateSettings({ model: "gpt-plain", reasoningEffort: "ultra" })
      await h.engine.validateSettings({ model: "gpt-bare", reasoningEffort: "ultra" })
    } finally {
      await h.dispose()
    }
  })

  test("once the listing is known, a session is not created with it and a session is not switched to it: nothing is written", async () => {
    const h = new Harness({ models: MODELS })
    try {
      await h.engine.validateSettings({ model: "gpt-test", reasoningEffort: "low" })
      const before = h.engine.listSessions().length
      expect((await errorOf(() => h.create({ model: "gpt-test", reasoningEffort: "ultra" }))).code).toBe("unknown_effort")
      expect(h.engine.listSessions()).toHaveLength(before)
      h.create({ model: "gpt-test", reasoningEffort: "low" })
      const log = h.log().length
      expect((await errorOf(() => h.session.setSettings({ model: "gpt-test", reasoningEffort: "ultra" }))).message).toContain("it accepts: low, medium, high")
      expect((await errorOf(() => h.session.setSettings({ model: "gpt-none", reasoningEffort: null }))).code).toBe("unknown_model")
      expect(h.log()).toHaveLength(log)
      h.session.setSettings({ model: "gpt-test", reasoningEffort: "high" })
      expect(h.session.projection().session.settings.reasoningEffort).toBe("high")
    } finally {
      await h.dispose()
    }
  })

  test("a session created before anyone listed the models sends nothing: the execution fails with the sentence, before a request", async () => {
    const h = new Harness({ models: MODELS })
    try {
      h.create({ model: "gpt-test", reasoningEffort: "ultra" }).send("Hi.")
      await h.settled()
      expect(h.provider.calls).toHaveLength(0)
      expect(h.log().at(-1)).toMatchObject({
        type: "execution.failed",
        data: { message: 'Nothing was sent: model gpt-test does not offer the reasoning effort "ultra"; it accepts: low, medium, high. Change the settings and send the message again.' },
      })
      // The session is usable: with settings the model offers, the same prompt goes out.
      h.provider.enqueue([script.text("Hello.")])
      h.session.setSettings({ model: "gpt-test", reasoningEffort: "low" })
      h.session.send("Hi again.")
      await h.settled()
      expect(h.provider.calls).toHaveLength(1)
      expect(h.provider.requests[0]!.params.reasoningEffort).toBe("low")
    } finally {
      await h.dispose()
    }
  })
})

describe("how calls are decided, before the first turn", () => {
  const saved = process.env.XDG_CONFIG_HOME
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved
  })

  /** A real project and a real user configuration directory, with nothing of this machine's. */
  function machine(user: unknown, project: unknown) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-settings-")))
    made.push(root)
    const cwd = join(root, "repo")
    mkdirSync(join(cwd, ".git"), { recursive: true })
    const write = (path: string, content: unknown) => {
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, JSON.stringify(content))
    }
    if (user !== null) write(join(root, "config", brand.directory, "config.json"), user)
    if (project !== null) write(join(cwd, `.${brand.directory}`, "config.json"), project)
    process.env.XDG_CONFIG_HOME = join(root, "config")
    return { root, cwd, edit: (content: unknown) => write(join(root, "config", brand.directory, "config.json"), content) }
  }

  test("a new session and a session opened again report the mode of the configuration files, as they are now", async () => {
    const files = machine({ approval: { mode: "ask" } }, null)
    const harness = createHarness({ dataDir: join(files.root, "data"), provider: new FakeProvider([]), log: () => {} })
    try {
      const session = harness.engine.createSession({ cwd: files.cwd, settings: { model: "m", reasoningEffort: null } })
      // No turn has run: nothing has read the files but this.
      expect(session.projection().session.execution).toBeNull()
      expect(session.approval()!.policy.mode).toBe("ask")
      await session.close()
      // The file is edited by hand while nothing has the session open; opening it again reads the file as it is now.
      files.edit({ approval: { mode: "full" } })
      const again = harness.engine.openSession(session.id)
      expect(again.approval()!.policy.mode).toBe("full")
      // The client's own choice still goes on top.
      again.setApproval({ mode: "auto" })
      expect(again.approval()!.policy.mode).toBe("auto")
    } finally {
      await harness.close()
    }
  })

  test("the project's file tightens it there too, and a file that cannot be read leaves the default until the turn says so", async () => {
    const files = machine({ approval: { mode: "full" } }, { approval: { mode: "ask" } })
    const harness = createHarness({ dataDir: join(files.root, "data"), provider: new FakeProvider([]), log: () => {} })
    try {
      const session = harness.engine.createSession({ cwd: files.cwd, settings: { model: "m", reasoningEffort: null } })
      expect(session.approval()!.policy.mode).toBe("ask")
      writeFileSync(join(files.root, "config", brand.directory, "config.json"), "{ not json")
      const broken = harness.engine.createSession({ cwd: files.cwd, settings: { model: "m", reasoningEffort: null } })
      expect(broken.approval()!.policy.mode).toBe("auto")
      broken.send("Hi.")
      await broken.settled()
      expect(broken.readEvents().at(-1)).toMatchObject({ type: "execution.failed", data: { message: expect.stringContaining("The configuration could not be loaded") } })
    } finally {
      await harness.close()
    }
  })
})

describe("what a subagent is told about questions", () => {
  test("is true whether or not a client answers its approval questions", () => {
    expect(SUBAGENT_NOTE).not.toContain("Nobody can answer questions")
    expect(SUBAGENT_NOTE).toContain("You cannot ask it or the user a question while you work")
    expect(SUBAGENT_NOTE).toContain("A call that needs the user's approval may be put to the user, or refused when nobody is there to ask")
    expect(taskMessage("  Fix a  ")).toBe(`Fix a\n\n${SUBAGENT_NOTE}`)
  })
})
