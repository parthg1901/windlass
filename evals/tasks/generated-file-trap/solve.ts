import { join } from "node:path"

const dir = process.argv[2]!
const errorsPath = join(dir, "errors.json")
const errors = (await Bun.file(errorsPath).json()) as unknown[]
errors.push({ code: "RATE_LIMITED", status: 429, message: "Too many uploads, try again in a minute." })
await Bun.write(errorsPath, `${JSON.stringify(errors, null, 2)}\n`)
if (Bun.spawnSync(["bun", "scripts/gen-errors.ts"], { cwd: dir }).exitCode !== 0) throw new Error("gen failed")
const handler = join(dir, "src/handlers/upload.ts")
const text = await Bun.file(handler).text()
await Bun.write(
  handler,
  text.replace(
    "  uploadsInWindow.set(",
    "  if ((uploadsInWindow.get(request.user) ?? 0) >= LIMIT_PER_WINDOW) return apiError(\"RATE_LIMITED\")\n  uploadsInWindow.set(",
  ).replace("export const MAX_BYTES", "export const LIMIT_PER_WINDOW = 20\nexport const MAX_BYTES"),
)
