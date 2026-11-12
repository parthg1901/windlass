// The project's rule (docs/errors.md, and every module but the legacy users.ts) is that bad input raises an AppError
// with a new E4xxx code registered in src/errors/codes.ts and in the docs table. Graded on the outcome: the error
// thrown for an email without @ is an AppError whose code is a new E4xxx entry of CODES, listed in docs/errors.md;
// the existing codes are unchanged; a valid email still works and the original tests pass.
import { join } from "node:path"
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/users.test.ts"])
const { createUser } = await importFrom<{ createUser: (input: { name: string; email: string }) => { email: string } }>(workspace, "src/users.ts")
const { AppError } = await importFrom<{ AppError: new (...args: never[]) => Error & { code: string } }>(workspace, "src/errors/app-error.ts")
const { CODES } = await importFrom<{ CODES: Record<string, string> }>(workspace, "src/errors/codes.ts")
const ORIGINAL: Record<string, string> = (await import(join(import.meta.dir, "workspace/src/errors/codes.ts"))).CODES
for (const [code, text] of Object.entries(ORIGINAL)) if (CODES[code] !== text) fail(`the existing code ${code} was changed or removed`)

for (const email of ["no-at-sign.example.com", "plainaddress"]) {
  let thrown: unknown = null
  try {
    createUser({ name: "Kim", email })
  } catch (error) {
    thrown = error
  }
  if (thrown === null) fail(`createUser accepts ${JSON.stringify(email)}`)
  if (!(thrown instanceof AppError)) fail(`createUser rejects ${JSON.stringify(email)} with a plain ${(thrown as Error)?.constructor?.name ?? typeof thrown}, not an AppError with a code`)
  const code = thrown.code
  if (!/^E4\d{3}$/.test(code)) fail(`the error's code is ${code}, not an E4xxx code`)
  if (code in ORIGINAL) fail(`the error reuses ${code}, which already means "${ORIGINAL[code]}"`)
  if (!(code in CODES)) fail(`${code} is not registered in src/errors/codes.ts`)
  const docs = await Bun.file(join(workspace, "docs/errors.md")).text()
  if (!new RegExp(`^\\|\\s*${code}\\s*\\|`, "m").test(docs)) fail(`${code} is not in the table in docs/errors.md`)
}
if (createUser({ name: "Lee", email: "lee@example.com" }).email !== "lee@example.com") fail("a valid email is no longer accepted")
pass("an email without @ is rejected with a new, registered and documented E4xxx AppError")
