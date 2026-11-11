/**
 * The real binary: `lh acp` started as a subprocess with a scripted model,
 * spoken to over its real stdin and stdout by the SDK's client.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type SessionNotification, client, methods, ndJsonStream } from "@agentclientprotocol/sdk"
import { brand } from "@light-harness/core"
import { SCRIPT_ENV } from "../src/scripted.ts"

const MAIN = join(import.meta.dir, "..", "..", "cli", "src", "main.ts")

test(`${brand.binary} acp speaks ACP over real stdio and exits when the client closes stdin`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-acp-proc-")))
  const workspace = join(root, "work")
  await Bun.write(join(workspace, "README.md"), "# demo\n")
  const scriptFile = join(root, "script.json")
  await Bun.write(
    scriptFile,
    JSON.stringify({
      responses: [
        [{ type: "tool_call", callId: "c1", name: "read", input: { path: "README.md" } }],
        [{ type: "text", text: "It is a demo." }, { type: "usage", inputTokens: 30, cachedInputTokens: 20, outputTokens: 5 }],
      ],
    }),
  )
  const child = Bun.spawn([process.execPath, MAIN, "acp"], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_DATA_HOME: join(root, "xdg"), [SCRIPT_ENV]: scriptFile },
  })
  try {
    const input = new WritableStream<Uint8Array>({
      write: (chunk) => {
        child.stdin.write(chunk)
        child.stdin.flush()
      },
      close: () => {
        child.stdin.end()
      },
    })
    const updates: SessionNotification[] = []
    const connection = client({ name: "subprocess-test" })
      .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
      .onNotification("*", () => {})
      .connect(ndJsonStream(input, child.stdout))
    const init = await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    expect(init.protocolVersion).toBe(1)
    expect(init.agentCapabilities?.loadSession).toBe(true)
    const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd: workspace, mcpServers: [] })
    const response = await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "what is this?" }] })
    expect(response.stopReason).toBe("end_turn")
    const text = updates.flatMap((note) => (note.update.sessionUpdate === "agent_message_chunk" && note.update.content.type === "text" ? [note.update.content.text] : [])).join("")
    expect(text).toBe("It is a demo.")
    expect(updates.some((note) => note.update.sessionUpdate === "tool_call_update" && note.update.status === "completed")).toBe(true)
    child.stdin.end()
    expect(await child.exited).toBe(0)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain("shutting down")
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
