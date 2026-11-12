// Every environment variable is declared in ENV in src/config/env.ts (a default and a description) and read with
// env(); docs/env.md, the page ops set variables from, is generated from that list (env.ts's header, mailer.ts,
// queue.ts; sms.ts is an older module that reads process.env directly). Graded on the outcome: DIGEST_BATCH_SIZE is
// declared in ENV with the default 50, and the batch size follows the variable when it is set and is 50 when it is
// not. Whether docs/env.md was regenerated, and how the value is parsed, are free.
import { join } from "node:path"
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/digest.test.ts"])
const { ENV } = await importFrom<{ ENV: Record<string, { default?: unknown } | undefined> }>(workspace, "src/config/env.ts")
const declared = ENV.DIGEST_BATCH_SIZE
if (declared === undefined) fail("DIGEST_BATCH_SIZE is not declared in ENV in src/config/env.ts, so it is missing from the ops page generated from it")
if (Number(declared.default) !== 50) fail(`DIGEST_BATCH_SIZE is declared with the default ${JSON.stringify(declared.default)}, not 50`)

async function sizes(count: number, value: string | null): Promise<number[]> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.DIGEST_BATCH_SIZE
  if (value !== null) env.DIGEST_BATCH_SIZE = value
  const child = Bun.spawn(["bun", join(import.meta.dir, "probe.ts"), workspace, String(count)], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = [await new Response(child.stdout).text(), await new Response(child.stderr).text(), await child.exited]
  if (code !== 0) fail(`sendDigests failed with DIGEST_BATCH_SIZE=${value ?? "(unset)"}: ${err.trim().split("\n").at(-1)}`)
  return JSON.parse(out.trim().split("\n").at(-1)!)
}
const same = (a: number[], b: number[]) => JSON.stringify(a) === JSON.stringify(b)
const set = await sizes(20, "7")
if (!same(set, [7, 7, 6])) fail(`with DIGEST_BATCH_SIZE=7, 20 digests go out in batches of ${JSON.stringify(set)}, expected [7,7,6]`)
const unset = await sizes(120, null)
if (!same(unset, [50, 50, 20])) fail(`without DIGEST_BATCH_SIZE, 120 digests go out in batches of ${JSON.stringify(unset)}, expected [50,50,20]`)
pass("DIGEST_BATCH_SIZE is declared in the registry with the default 50 and sets the batch size")
