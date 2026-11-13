/**
 * Reading a file with a secret in it and then changing the file: the model
 * is shown a placeholder, copies it into its edit, and the edit must change
 * the real file without ever writing the placeholder over the secret.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { redact, redactPieces } from "../../src/approval/redact.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { type ToolContext, noBlobStore } from "../../src/tool/tool.ts"
import { editTool } from "../../src/tools/edit.ts"
import { readTool } from "../../src/tools/read.ts"
import { locate, redactedView, restore } from "../../src/tools/redacted.ts"
import { writeTool } from "../../src/tools/write.ts"

const dir = mkdtempSync(join(tmpdir(), "wl-redacted-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN = "tok_live_9f8e7d6c5b4a3210"
const KEY = "sk-ant-api03-synthetic-test-key-0123456789"
const secrets = [TOKEN]
const context: ToolContext = {
  sessionId: "ses_1" as SessionId,
  messageId: "msg_1" as MessageId,
  callId: "call_1" as CallId,
  cwd: dir,
  signal: new AbortController().signal,
  progress: () => {},
  putBlob: noBlobStore,
  redact: (text) => redactPieces(text, secrets),
}
const ENV = `# service settings\nAPI_URL=https://api.example.com\nAPI_TOKEN=${TOKEN}\nANTHROPIC_API_KEY=${KEY}\nTIMEOUT=30\n`
const file = (name: string, content = ENV) => {
  writeFileSync(join(dir, name), content)
  return name
}
const content = (name: string) => readFileSync(join(dir, name), "utf8")
/** What the model is shown of a file: the read tool's output, redacted as the step loop redacts every tool output. */
const shownTo = async (name: string) => redact((await readTool().execute({ path: name }, context)).output, secrets).text
const edit = (input: { path: string; old_string: string; new_string: string; replace_all?: boolean }) => editTool().execute(input, context)

describe("an edit after a redacted read", () => {
  test("the model sees placeholders, and an edit that copies one changes the real line and keeps the secret", async () => {
    const name = file("a.env")
    const shown = await shownTo(name)
    expect(shown).toContain("API_TOKEN=[REDACTED:env]")
    expect(shown).toContain("ANTHROPIC_API_KEY=[REDACTED:anthropic-key]")
    expect(shown).not.toContain(TOKEN)
    const result = await edit({ path: name, old_string: "API_TOKEN=[REDACTED:env]\nANTHROPIC_API_KEY=[REDACTED:anthropic-key]", new_string: "SERVICE_TOKEN=[REDACTED:env]\nANTHROPIC_API_KEY=[REDACTED:anthropic-key]" })
    expect(result.status).toBe("success")
    expect(result.output).toBe(`Edited ${name}: replaced 1 occurrence (line 3), matching the file as you were shown it. The 2 redacted secrets in it were kept as they are in the file.`)
    expect(content(name)).toBe(ENV.replace("API_TOKEN=", "SERVICE_TOKEN="))
  })

  test("an edit near a secret that leaves the placeholder out of old_string is the ordinary exact edit", async () => {
    const name = file("b.env")
    const result = await edit({ path: name, old_string: "TIMEOUT=30", new_string: "TIMEOUT=60" })
    expect(result.output).toBe(`Edited ${name}: replaced 1 occurrence (line 5).`)
    expect(content(name)).toBe(ENV.replace("TIMEOUT=30", "TIMEOUT=60"))
  })

  test("a replacement that drops the placeholder removes the secret, and says so", async () => {
    const name = file("c.env")
    const result = await edit({ path: name, old_string: "API_TOKEN=[REDACTED:env]\n", new_string: "" })
    expect(result.output).toBe(`Edited ${name}: replaced 1 occurrence (line 3), matching the file as you were shown it. One redacted secret was removed with the text it was in.`)
    expect(content(name)).toBe(ENV.replace(`API_TOKEN=${TOKEN}\n`, ""))
  })

  test("a placeholder in new_string that old_string does not have is refused: nobody can write a secret they were not shown", async () => {
    const name = file("d.env")
    const result = await edit({ path: name, old_string: "API_TOKEN=[REDACTED:env]", new_string: "API_TOKEN=[REDACTED:env]\nBACKUP_TOKEN=[REDACTED:env]" })
    expect(result.status).toBe("error")
    expect(result.output).toContain("new_string contains [REDACTED:env], which stands for nothing")
    expect(content(name)).toBe(ENV)
  })

  test("an old_string that would cut a secret in two is refused", async () => {
    const other = "tok_live_0000111122223333"
    const line = `A=${TOKEN} B=${other}\n`
    const name = file("e.env", line)
    const local: ToolContext = { ...context, redact: (text) => redactPieces(text, [TOKEN, other]) }
    // As shown: A=[REDACTED:env] B=[REDACTED:env]. A match that starts inside the first placeholder stands for half a secret.
    const result = await editTool().execute({ path: name, old_string: "ACTED:env] B=[REDACTED:env]", new_string: " B=[REDACTED:env]" }, local)
    expect(result.status).toBe("error")
    expect(result.output).toContain("begins or ends inside a redacted secret")
    expect(content(name)).toBe(line)
  })

  test("two secrets of one kind keep their order, and replace_all handles each occurrence with its own secret", async () => {
    const other = "tok_live_0000111122223333"
    const twice = `A=${TOKEN}\nB=${other}\n`
    const name = file("f.env", twice)
    const local: ToolContext = { ...context, redact: (text) => redactPieces(text, [TOKEN, other]) }
    const swapped = await editTool().execute({ path: name, old_string: "A=[REDACTED:env]\nB=[REDACTED:env]", new_string: "FIRST=[REDACTED:env]\nSECOND=[REDACTED:env]" }, local)
    expect(swapped.status).toBe("success")
    expect(content(name)).toBe(`FIRST=${TOKEN}\nSECOND=${other}\n`)
    const all = await editTool().execute({ path: name, old_string: "=[REDACTED:env]", new_string: ": [REDACTED:env]", replace_all: true }, local)
    expect(all.output).toContain("replaced 2 occurrences (lines 1, 2)")
    expect(content(name)).toBe(`FIRST: ${TOKEN}\nSECOND: ${other}\n`)
  })

  test("text that is literally a placeholder in the file (documentation about redaction) is edited as the text it is", async () => {
    const name = file("doc.md", "Secrets appear as [REDACTED:env] in tool output.\n")
    const result = await edit({ path: name, old_string: "appear as [REDACTED:env] in", new_string: "are shown as [REDACTED:env] in" })
    expect(result.output).toBe(`Edited ${name}: replaced 1 occurrence (line 1).`)
    expect(content(name)).toBe("Secrets are shown as [REDACTED:env] in tool output.\n")
  })

  test("without the harness's redaction (a tool used on its own) a placeholder is just text that is not there", async () => {
    const name = file("g.env")
    const { redact: _, ...bare } = context
    const result = await editTool().execute({ path: name, old_string: "API_TOKEN=[REDACTED:env]", new_string: "X=1" }, bare)
    expect(result.status).toBe("error")
    expect(content(name)).toBe(ENV)
  })
})

describe("a write after a redacted read", () => {
  test("the whole file written back with its placeholders in place gets its secrets back", async () => {
    const name = file("h.env")
    const shown = redact(ENV, secrets).text
    const result = await writeTool().execute({ path: name, content: shown.replace("TIMEOUT=30", "TIMEOUT=45") }, context)
    expect(result.status).toBe("success")
    expect(result.output).toContain("The 2 redaction placeholders in the content were written as the secrets they stand for in the file.")
    expect(content(name)).toBe(ENV.replace("TIMEOUT=30", "TIMEOUT=45"))
  })

  test("content whose placeholders do not line up with the file's secrets is not written", async () => {
    const name = file("i.env")
    const result = await writeTool().execute({ path: name, content: "API_TOKEN=[REDACTED:env]\n" }, context)
    expect(result.status).toBe("error")
    expect(result.output).toContain("Writing it would replace real secrets with placeholders.")
    expect(content(name)).toBe(ENV)
  })

  test("a placeholder in the content of a file that has no secrets, or of a new file, is written as it is", async () => {
    const result = await writeTool().execute({ path: "new.md", content: "Shown as [REDACTED:env].\n" }, context)
    expect(result.status).toBe("success")
    expect(content("new.md")).toBe("Shown as [REDACTED:env].\n")
  })
})

describe("the view of a file as it was shown", () => {
  test("positions map back to the real text around every kind of redaction, also one that keeps a prefix", () => {
    const real = `auth: Bearer abcdef0123456789abcdef\nkey=${KEY} end\n`
    const view = redactedView(real, (text) => redactPieces(text, []))
    expect(view.shown).toBe("auth: Bearer [REDACTED:authorization]\nkey=[REDACTED:anthropic-key] end\n")
    expect(view.pieces.map((piece) => piece.original).join("")).toBe(real)
    const spans = locate(view, "Bearer [REDACTED:authorization]\nkey=")
    expect(spans).toEqual([{ start: 6, end: real.indexOf(KEY), secrets: [{ placeholder: "[REDACTED:authorization]", original: "abcdef0123456789abcdef" }] }])
    expect(restore("token [REDACTED:authorization]", spans === "cut" ? [] : spans[0]!.secrets)).toEqual({ text: "token abcdef0123456789abcdef", restored: 1 })
  })

  test("the pieces' texts joined are exactly what redact returns, for the redactor's own examples", () => {
    const samples = [ENV, `-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\nafter`, `https://user:pa55word@example.com/x and ghp_${"a".repeat(36)}`, "nothing secret here", `${TOKEN}${TOKEN} twice`, "[REDACTED:env] already"]
    for (const sample of samples) {
      const pieces = redactPieces(sample, secrets)
      expect(pieces.map((piece) => piece.text).join("")).toBe(redact(sample, secrets).text)
      expect(pieces.map((piece) => piece.original).join("")).toBe(sample)
      for (const piece of pieces) if (piece.kind === null) expect(piece.text).toBe(piece.original)
    }
  })
})

describe("the temp directory's alias", () => {
  const temp = { dir: "/var/lib/session-temp/ses_1", alias: "/tmp" }

  test("a path under the alias is the session's file; any other path is itself", async () => {
    const { tempPath, toolPath, shownPath } = await import("../../src/tools/common.ts")
    expect(tempPath(temp, "/tmp/out.log", "/home/u/project")).toBe("/var/lib/session-temp/ses_1/out.log")
    expect(tempPath(temp, "/tmp", "/home/u/project")).toBe("/var/lib/session-temp/ses_1")
    expect(tempPath(temp, "/tmpfile", "/home/u/project")).toBe("/tmpfile")
    expect(tempPath(temp, "src/a.ts", "/home/u/project")).toBe("src/a.ts")
    expect(tempPath(undefined, "/tmp/out.log", "/home/u/project")).toBe("/tmp/out.log")
    expect(tempPath({ dir: temp.dir, alias: null }, "/tmp/out.log", "/home/u/project")).toBe("/tmp/out.log")
    expect(toolPath({ cwd: "/home/u/project", temp }, "/tmp/a/b.txt")).toBe("/var/lib/session-temp/ses_1/a/b.txt")
    expect(shownPath({ cwd: "/home/u/project", temp }, "/var/lib/session-temp/ses_1/a/b.txt")).toBe("/tmp/a/b.txt")
  })

  test("a workspace that itself lies under the alias keeps its own paths: commands see it there, on top of the temp directory", async () => {
    const { tempPath, toolPath } = await import("../../src/tools/common.ts")
    const cwd = "/tmp/checkout/project"
    expect(tempPath(temp, "/tmp/checkout/project/src/a.ts", cwd)).toBe("/tmp/checkout/project/src/a.ts")
    expect(tempPath(temp, cwd, cwd)).toBe(cwd)
    expect(toolPath({ cwd, temp }, "src/a.ts")).toBe("/tmp/checkout/project/src/a.ts")
    // A sibling of the workspace under /tmp is not something a command can see: the name means the session's temp directory.
    expect(tempPath(temp, "/tmp/checkout/other.txt", cwd)).toBe("/var/lib/session-temp/ses_1/checkout/other.txt")
    expect(tempPath(temp, "/tmp/checkout/project-two/x", cwd)).toBe("/var/lib/session-temp/ses_1/checkout/project-two/x")
  })
})
