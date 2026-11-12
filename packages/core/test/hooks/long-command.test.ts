/**
 * A before hook is asked only about a call it can be shown whole, through the engine and the module's own runner.
 *
 * The hook is the first example of docs/hooks.md, word for word: it reads the command from its environment
 * variable. A variable holds at most `EVENT_LIMITS.envValue`; a longer command used to reach the hook with the
 * variable unset, the `case` matched nothing, the hook exited 0 and `git push origin main # <padding>` ran.
 * Now such a call is not put to the hook: it is refused as a hook that failed refuses (`runBeforeHooks`,
 * `tooLargeDetail`), and the user and the model are told the call was too large for the hook.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StoredEvent } from "../../src/event/durable.ts"
import { EVENT_LIMITS, HOOK_ENV_PREFIX } from "../../src/hooks/event.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "../engine/harness.ts"
import { measured } from "../scenarios/script.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]

test(
  "the documented no-push hook also refuses a push whose command line is longer than the environment limit",
  async () => {
    const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), "hooks-long-"))), "repo")
    made.push(join(cwd, ".."))
    mkdirSync(join(cwd, ".git"), { recursive: true })
    // The hook of docs/hooks.md, word for word, run by the module's own runner.
    const command = `case "$${HOOK_ENV_PREFIX}COMMAND" in *'git push'*) echo 'Pushing is not allowed here. Commit locally and tell the user.'; exit 2;; esac`
    const h = new Harness({ cwd, userConfig: { verify: { mode: "off" }, hooks: { beforeTool: [{ name: "no-push", tools: ["shell"], command }] } }, hooks: {} })
    try {
      // The scripted shell tool runs nothing: what counts is whether the call is let through.
      const padded = `git push origin main # ${"x".repeat(EVENT_LIMITS.envValue)}`
      h.provider.enqueue([call("shell", { command: padded }), U], [script.text("Done."), U])
      h.tools.on("shell", "pushed")
      h.create().send("Push.")
      await h.settled()
      expect(of(h, "hook.ran").map((item) => item.data.name)).toEqual(["no-push"])
      // Either refusal is correct: the hook saw the push and said no, or it could not be shown the call and so could not allow it.
      expect(h.tools.ran).toEqual([])
      expect(of(h, "tool.settled")[0]!.data.outcome).toBe("error")
      // It is the second: the hook was not asked, and the record and the model's result say why.
      const record = of(h, "hook.ran")[0]!.data
      expect(record).toMatchObject({ answer: "failed", failure: "cannot_run", run: { kind: "cannot_run" } })
      expect(record.detail).toContain("the call is too large to show to the hook")
      expect(JSON.stringify(of(h, "tool.settled")[0]!.data)).toContain("the call is too large to show to the hook")
    } finally {
      await h.dispose()
    }
  },
  60_000,
)
