import { join } from "node:path"

const path = join(process.argv[2]!, "src/resets.ts")
const text = await Bun.file(path).text()
await Bun.write(
  path,
  `import { MINUTE, now } from "./clock.ts"\n\n${text}`
    .replace("createdAt: Date.now()", "createdAt: now()")
    .replace('  resets.delete(token)\n  return reset.userId', '  resets.delete(token)\n  if (now() - reset.createdAt > 30 * MINUTE) throw new Error("this reset link has expired")\n  return reset.userId'),
)
