/**
 * Review finding: the hook of the documentation's own first example stops refusing a command once the command
 * is longer than 16 KiB.
 *
 * What is promised.
 * - docs/hooks.md, opening: "Hooks are for rules the agent must follow whether or not it was told: never push,
 *   never read `.env`, do not finish while a scratch file is still there."
 * - docs/hooks.md, "The smallest working example": a before hook on `shell` whose command is
 *   `case "$<PREFIX>HOOK_COMMAND" in *'git push'*) echo '...'; exit 2;; esac`, followed by "When the model runs
 *   `git push origin main` you see the call refused".
 * - docs/hooks.md, "What a hook is given": "`<PREFIX>HOOK_COMMAND` (a shell call's command)", with no limit named.
 *
 * What happens. `hookEvent` sets an environment variable only when its value is at most
 * `EVENT_LIMITS.envValue` (16 KiB) and otherwise leaves it unset, without telling the hook or the user. The shell
 * tool's `command` has no length limit. So `git push origin main # <16 KiB of anything>` reaches the example
 * hook with the variable empty, the `case` matches nothing, the hook exits 0 and the push runs. (The same holds
 * for a hook that reads standard input: over `EVENT_LIMITS.arguments`, 24 KiB, `tool.arguments` is `null`.)
 * The check is made on a value the hook was not given; the call runs with the value it was.
 *
 * Code path. packages/core/src/hooks/event.ts, `hookEvent`, the `set` helper; reached from `runBeforeHooks`
 * (packages/core/src/hooks/points.ts) through `LiveSession.decideCall` (packages/core/src/engine/engine.ts).
 *
 * Smallest fix. A before hook that cannot be shown the whole call should not be asked as if it had been: when
 * a value the hook's point defines (`COMMAND`, `PATHS`, the arguments on standard input) does not fit, answer
 * for the hook as `failed` (so the call is refused unless the hook says `onError: "allow"`), with a detail that
 * names the limit. Alternatively pass the command through a file and say so on the page.
 *
 * What that fix could affect. Legitimate calls with very long commands or arguments (a heredoc that writes a
 * file) would be refused under any before hook that applies to them; after hooks and stop hooks are not
 * affected if the change is limited to the before point.
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

test.failing(
  "the documented no-push hook should also refuse a push whose command line is longer than the environment limit",
  async () => {
    const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), "review-hooks-long-"))), "repo")
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
    } finally {
      await h.dispose()
    }
  },
  60_000,
)
