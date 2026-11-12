/**
 * Calls every standard tool through the runtime the way the step loop will:
 * argument text in, outcome out. Prints exactly what the model would see.
 *
 *   bun scripts/tools-demo.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import type { CallId, MessageId, SessionId } from "../packages/core/src/id.ts"
import { createInterrupt } from "../packages/core/src/interrupt.ts"
import { createToolRuntime } from "../packages/core/src/tool/runtime.ts"
import { noBlobStore } from "../packages/core/src/tool/tool.ts"
import { createStandardTools } from "../packages/core/src/tools/index.ts"

const root = mkdtempSync(join(tmpdir(), `${brand.binary}-tools-demo-`))
const workspace = join(root, "workspace")
const spillDir = join(root, "spill")
const runtime = createToolRuntime({ tools: createStandardTools({ spillDir }), spillDir, putBlob: noBlobStore })

await Bun.write(
  join(workspace, "src/math.ts"),
  `export function add(a: number, b: number) {\n  return a + b\n}\n\nexport function sub(a: number, b: number) {\n  return a - b\n}\n`,
)
await Bun.write(join(workspace, "src/main.ts"), `import { add } from "./math.ts"\n\nconsole.log(add(1, 2))\n`)
await Bun.write(join(workspace, "README.md"), "# demo\n")
await Bun.write(join(workspace, "notes.txt"), Array.from({ length: 30 }, (_, index) => `note ${index + 1}`).join("\n"))

let calls = 0
async function call(name: string, argumentsText: string, signal = createInterrupt().signal) {
  calls += 1
  const outcome = await runtime.run({
    name,
    argumentsText,
    context: {
      sessionId: "ses_demo" as SessionId,
      messageId: "msg_demo" as MessageId,
      callId: `call_${calls}` as CallId,
      cwd: workspace,
      signal,
      progress: () => {},
    },
  })
  const capped = outcome.settlement.truncation === null ? "" : ` (capped from ${outcome.settlement.truncation.originalBytes} bytes)`
  console.log(`\n=== ${name} ${argumentsText}  ->  ${outcome.kind} / ${outcome.settlement.outcome}${capped}`)
  console.log(outcome.settlement.output.replaceAll(root, "<tmp>"))
}

await call("ls", "{}")
await call("ls", '{"path":"src"}')
await call("glob", '{"pattern":"**/*.ts"}')
await call("read", '{"path":"src/math.ts"}')
await call("read", '{"path":"notes.txt","offset":10,"limit":3}')
await call("read", '{"path":"src/maths.ts"}')
await call("grep", '{"pattern":"add\\\\(","context":1}')
await call("grep", '{"pattern":"multiply"}')
await call("edit", '{"path":"src/math.ts","old_string":"a + b","new_string":"a + b + 0"}')
await call("edit", '{"path":"src/math.ts","old_string":"number","new_string":"bigint"}')
await call("edit", '{"path":"src/math.ts","old_string":"return  a - b","new_string":"x"}')
await call("write", '{"path":"src/util/strings.ts","content":"export const hello = \\"hi\\"\\n"}')
await call("shell", '{"command":"ls src && echo to-stderr >&2"}')
await call("shell", '{"command":"grep -q nothing README.md"}')
await call("shell", '{"command":"echo started; sleep 5","timeout":1}')
await call("shell", '{"command":"seq 1 100000"}')
const token = createInterrupt()
setTimeout(() => token.interrupt("user"), 300)
await call("shell", '{"command":"for i in 1 2 3 4 5 6 7 8 9; do echo step $i; sleep 0.1; done"}', token.signal)
await call("read", '{"path": "src/math.ts", ')
await call("read", '{"path": 42, "limt": 3}')
await call("open", '{"path":"README.md"}')

rmSync(root, { recursive: true, force: true })
