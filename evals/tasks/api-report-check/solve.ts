import { join } from "node:path"

const dir = process.argv[2]!
const stats = join(dir, "src/stats.ts")
await Bun.write(
  stats,
  `${await Bun.file(stats).text()}
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("median of no values")
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
`,
)
const proc = Bun.spawnSync(["bun", "scripts/api-check.ts", "--update"], { cwd: dir })
if (proc.exitCode !== 0) throw new Error("api-check --update failed")
