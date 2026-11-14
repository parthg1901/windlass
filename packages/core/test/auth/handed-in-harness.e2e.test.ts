/**
 * The real assembly (`createHarness`, the real Responses provider) on a sign-in handed in from outside. The
 * provider's address is answered here, in the process: nothing reaches the network, and a request to anywhere else
 * (the token endpoint a refresh would call) fails the test.
 *
 * - A rejected token (401) is looked up once more, which reads the file again: replaced in the meantime, the turn
 *   goes on with the new one. Still rejected, the turn fails saying that the handed-in token was rejected, and
 *   names the variable, instead of telling the user to sign in again on this machine.
 * - The saved sign-in beside it is never read, refreshed or written.
 * - Every token read joins the values removed from tool output, a replaced one included.
 * - The file is a credential store to the tools: a read of it asks, and a sandboxed command cannot open it.
 */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Harness, createHarness } from "../../src/assembly.ts"
import { ACCESS_TOKEN_FILE_ENV, type Credentials, HAND_IN_ADVICE } from "../../src/auth/chatgpt.ts"
import { brand } from "../../src/brand.ts"
import { FAILURE_TEXT } from "../../src/engine/constants.ts"
import type { EngineSession } from "../../src/engine/engine.ts"
import { ModelListError, RESPONSES_BASE_URL } from "../../src/provider/openai-responses.ts"
import { removeTempDirs, skipReason, tempDir } from "../sandbox/helpers.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"

// End-to-end: the real harness starts processes (git for its snapshots, the sandbox's probe), so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const MODEL = "gpt-test"
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  removeTempDirs()
})

const frame = (type: string, rest: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`
const response = (item: Record<string, unknown>) => frame("response.created", { response: {} }) + frame("response.output_item.done", { output_index: 0, item }) + frame("response.completed", { response: { output: [] } })
/** The model answers with text, or asks to read a file. */
const says = (text: string) => response({ type: "message", id: "msg_TEST1", role: "assistant", content: [{ type: "output_text", text }] })
const reads = (path: string) => response({ type: "function_call", id: "fc_TEST1", call_id: "call_TEST1", name: "read", arguments: JSON.stringify({ path }) })
const runs = (command: string) => response({ type: "function_call", id: "fc_TEST2", call_id: "call_TEST2", name: "shell", arguments: JSON.stringify({ command }) })

interface Place {
  readonly harness: Harness
  readonly workspace: string
  readonly file: string
  readonly data: string
  /** The token each request to the provider carried, in order, with the path asked for. */
  readonly sent: { readonly path: string; readonly token: string | null }[]
  /** Requests to anywhere but the provider: there must be none. */
  readonly elsewhere: string[]
  /** What the model answers next, in order. */
  readonly answers: string[]
}

/**
 * The real harness with its access token handed in through a file, a saved sign-in in its data directory that is due
 * for a refresh, and the provider answered in-process: 401 unless `accepts` the token, else the next of `answers`.
 */
function place(token: string, accepts: (token: string) => boolean, answers: readonly string[], onRejected: (at: Place, path: string) => void = () => {}): Place {
  // Not under /tmp where that can be helped: there a session's tools and commands see its own temp directory.
  const root = realpathSync(tempDir("handed-in"))
  const data = join(root, "data", brand.directory)
  const workspace = join(root, "workspace")
  const file = join(root, "handed-in", "token")
  for (const directory of [data, workspace, join(root, "handed-in"), join(root, "config")]) mkdirSync(directory, { recursive: true })
  writeFileSync(file, token)
  const saved: Credentials = { hostId: "host", clientId: "client", account: { sub: "user_test" }, accessToken: "saved_access_0", refreshToken: "refresh_0", idToken: "id", scopes: [], expiresAt: Date.now() + 60_000 }
  writeFileSync(join(data, "auth.json"), JSON.stringify(saved))

  const env = { [ACCESS_TOKEN_FILE_ENV]: file, XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") }
  const before = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]))
  const realFetch = globalThis.fetch
  cleanups.push(() => {
    globalThis.fetch = realFetch
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  Object.assign(process.env, env)
  const queue = [...answers]
  const sent: Place["sent"] = []
  const elsewhere: string[] = []
  const at: Place = { harness: createHarness({ log: () => {}, engine: { loadConfig: null, discover: () => [] } }), workspace, file, data, sent, elsewhere, answers: queue }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(`${RESPONSES_BASE_URL}/`)) {
      elsewhere.push(url)
      throw new Error(`a test reached ${url}`)
    }
    const path = url.slice(RESPONSES_BASE_URL.length)
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null
    sent.push({ path, token: bearer })
    if (bearer === null || !accepts(bearer)) {
      onRejected(at, path)
      return Response.json({ detail: "Unauthorized" }, { status: 401 })
    }
    if (path === "/models") return Response.json({ models: [{ slug: MODEL, display_name: "Test", visibility: "list", context_window: 200_000 }] })
    return new Response(queue.shift() ?? says("(nothing left to say)"), { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch
  cleanups.push(() => at.harness.close())
  return at
}

/** Sends one message and waits for the turn to end; the events of that turn. */
async function turn(session: EngineSession, text: string) {
  const from = session.readEvents().length
  session.send(text)
  await waitFor(() => ["execution.succeeded", "execution.failed"].includes(session.readEvents().at(-1)?.type ?? ""), { timeoutMs: 20_000, intervalMs: 5, what: "the turn to end", describe: () => session.readEvents().map((item) => item.type).join(", ") })
  return session.readEvents().slice(from)
}

const start = (at: Place) => at.harness.engine.createSession({ cwd: at.workspace, settings: { model: MODEL, reasoningEffort: null } })
const responses = (at: Place) => at.sent.filter((request) => request.path === "/responses").map((request) => request.token)

describe("a handed-in token the provider rejects", () => {
  test("is read from its file again before the turn fails: replaced in the meantime, the turn goes on with the new one", async () => {
    // Whoever handed the token in replaces it when a model call with the first one is turned down.
    const at = place("handed-token-old", (token) => token === "handed-token-new", [says("Hello.")], (here, path) => {
      if (path === "/responses") writeFileSync(here.file, JSON.stringify({ accessToken: "handed-token-new", expiresAt: Date.now() + 600_000 }))
    })
    expect(await at.harness.signIn()).toEqual({ signedIn: true })
    const events = await turn(start(at), "Hi.")
    expect(events.at(-1)?.type).toBe("execution.succeeded")
    expect(responses(at)).toEqual(["handed-token-old", "handed-token-new"])
    expect(events.filter((item) => item.type === "retry.scheduled")).toEqual([])
  })

  test("still rejected, the turn fails saying the handed-in token was rejected, with the variable, not to sign in again here", async () => {
    const at = place("handed-token-old", () => false, [])
    const events = await turn(start(at), "Hi.")
    // Once more after the first rejection, with the file read again, and no further.
    expect(responses(at)).toEqual(["handed-token-old", "handed-token-old"])
    const failed = events.at(-1)
    expect(failed).toMatchObject({ type: "execution.failed", data: { message: FAILURE_TEXT.handedInRejected } })
    expect(FAILURE_TEXT.handedInRejected).toContain(`handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected`)
    expect(FAILURE_TEXT.handedInRejected).not.toContain("sign in again")
    // The models cannot be listed either, and the listing says the same.
    const listing = await at.harness.listModels().then(
      () => null,
      (error: unknown) => error,
    )
    expect(listing).toBeInstanceOf(ModelListError)
    expect((listing as ModelListError).error).toMatchObject({ kind: "auth", status: 401, message: `The access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected (HTTP 401: Unauthorized). ${HAND_IN_ADVICE}` })
  })

  test("a file that cannot be used is not signed in, with the file's own message; put right, it is, without a restart", async () => {
    const at = place("", () => true, [says("Hello.")])
    const state = await at.harness.signIn()
    expect(state).toEqual({ signedIn: false, message: `The file ${ACCESS_TOKEN_FILE_ENV} names is empty (${at.file}). ${HAND_IN_ADVICE}` })
    // A turn started anyway fails the same way, and sends nothing.
    const session = start(at)
    expect((await turn(session, "Hi.")).at(-1)).toMatchObject({ type: "execution.failed", data: { message: FAILURE_TEXT.handedInRejected } })
    expect(responses(at)).toEqual([])
    writeFileSync(at.file, "handed-token-new\n")
    expect(await at.harness.signIn()).toEqual({ signedIn: true })
    expect((await turn(session, "Hi again.")).at(-1)?.type).toBe("execution.succeeded")
    expect(responses(at)).toEqual(["handed-token-new"])
  })
})

describe("the saved sign-in beside a handed-in token", () => {
  test("is never read, refreshed or written, through sign-in checks, model listings and turns", async () => {
    const at = place("handed-token-0001", (token) => token === "handed-token-0001", [says("Hello.")])
    const before = readFileSync(join(at.data, "auth.json"), "utf8")
    expect(await at.harness.signIn()).toEqual({ signedIn: true })
    expect((await at.harness.listModels()).map((model) => model.id)).toEqual([MODEL])
    expect((await turn(start(at), "Hi.")).at(-1)?.type).toBe("execution.succeeded")
    // No token request was made (the saved sign-in is due for a refresh), and no lock or rewritten file is there.
    expect(at.elsewhere).toEqual([])
    expect(new Set(at.sent.map((request) => request.token))).toEqual(new Set(["handed-token-0001"]))
    expect(readFileSync(join(at.data, "auth.json"), "utf8")).toBe(before)
    expect(readdirSync(at.data).filter((name) => name.startsWith("auth"))).toEqual(["auth.json"])
  })
})

describe("the token file and the tools", () => {
  test("a read of it needs an approval, as a credential store does, and a sandboxed command cannot open it", async () => {
    const at = place("handed-token-0001", () => true, [])
    const session = start(at)
    const outputs = (events: readonly { type: string; data: unknown }[]) => events.filter((item) => item.type === "tool.settled").map((item) => JSON.stringify(item.data))
    // Nobody is there to answer, so the read is refused; what it was refused for is the question a user would get.
    at.answers.push(reads(at.file), says("Refused."))
    const read = await turn(session, "Read the token file.")
    expect(read.at(-1)?.type).toBe("execution.succeeded")
    expect(outputs(read)).toHaveLength(1)
    expect(read.find((item) => item.type === "tool.started")).toBeUndefined()
    // The model is not told where the file is either: its path is the value of a variable named like a credential's.
    expect(outputs(read)[0]).toContain("Not run: this call needs the user's approval for reading [REDACTED:env], and this run has no one to approve it.")
    // A command runs in the sandbox without asking (where this machine has one), and there the file cannot be opened.
    if (skipReason === null) {
      at.answers.push(runs(`cat ${at.file}; echo exit-ok`), says("Ran."))
      const ran = await turn(session, "Print the token file.")
      expect(outputs(ran)).toHaveLength(1)
      expect(outputs(ran)[0]).toContain("Permission denied")
      expect(outputs(ran)[0]).toContain("exit-ok")
    }
    expect(JSON.stringify(session.readEvents())).not.toContain("handed-token-0001")
  })
})

describe("a handed-in token in tool output", () => {
  test("is removed like any secret, and so is the token that replaced it", async () => {
    const at = place("handed-token-0001", () => true, [reads("copy.txt"), says("Read."), reads("copy.txt"), says("Read again.")])
    const outputs = (events: readonly { type: string; data: unknown }[]) => events.filter((item) => item.type === "tool.settled").map((item) => JSON.stringify(item.data))
    // A copy of the token in the working directory, which a tool may read freely.
    writeFileSync(join(at.workspace, "copy.txt"), "token=handed-token-0001\n")
    const session = start(at)
    const first = await turn(session, "Read copy.txt.")
    expect(first.at(-1)?.type).toBe("execution.succeeded")
    expect(outputs(first).join("\n")).toContain("token=[REDACTED:env]")
    expect(JSON.stringify(first)).not.toContain("handed-token-0001")
    // The file is replaced; the next model call reads the new token, and from then on that one is removed too.
    writeFileSync(at.file, JSON.stringify({ accessToken: "handed-token-0002", expiresAt: Date.now() + 600_000 }))
    writeFileSync(join(at.workspace, "copy.txt"), "token=handed-token-0002\n")
    const second = await turn(session, "Read it again.")
    expect(outputs(second).join("\n")).toContain("token=[REDACTED:env]")
    expect(JSON.stringify(second)).not.toContain("handed-token-0002")
  })
})
