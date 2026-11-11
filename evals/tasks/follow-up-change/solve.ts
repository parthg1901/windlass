// The finished state after both turns.
import { join } from "node:path"

const file = join(process.argv[2]!, "src/text.ts")
await Bun.write(
  file,
  `${await Bun.file(file).text()}
/** "Crème Brûlée!" -> "creme-brulee": accents dropped, runs of anything but letters and digits become one hyphen. */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\\p{L}\\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
}
`,
)
