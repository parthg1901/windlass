import { join } from "node:path"

const dir = process.argv[2]!
const edit = async (file: string, from: string, to: string) => {
  const path = join(dir, file)
  const text = await Bun.file(path).text()
  if (!text.includes(from)) throw new Error(`${file}: ${from} not found`)
  await Bun.write(path, text.replace(from, to))
}
await edit("src/errors/codes.ts", '  E4010: "an email address is required",\n', '  E4010: "an email address is required",\n  E4011: "email address is not valid",\n')
await edit("docs/errors.md", "| E4010 | an email address is required |\n", "| E4010 | an email address is required |\n| E4011 | email address is not valid |\n")
await edit("src/users.ts", '  if (users.some(', '  if (!input.email.includes("@")) throw new AppError("E4011", input.email)\n  if (users.some(')
