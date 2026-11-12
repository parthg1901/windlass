import { join } from "node:path"

const dir = process.argv[2]!
const edit = async (file: string, from: string, to: string) => {
  const path = join(dir, file)
  const text = await Bun.file(path).text()
  if (!text.includes(from)) throw new Error(`${file}: ${from} not found`)
  await Bun.write(path, text.replace(from, to))
}
await edit("src/config/settings.ts", '  REPLY_TO: { default: "support@notifier.example", description: "reply address on every mail" },\n', '  REPLY_TO: { default: "support@notifier.example", description: "reply address on every mail" },\n  DIGEST_BATCH_SIZE: { default: "50", description: "digest mails handed to the relay per call" },\n')
await edit("src/digest.ts", 'import { digestMail, type Mail } from "./mailer.ts"', 'import { env } from "./config/settings.ts"\nimport { digestMail, type Mail } from "./mailer.ts"')
await edit("src/digest.ts", "const BATCH_SIZE = 50\n", "")
await edit("src/digest.ts", "  for (let start", '  const BATCH_SIZE = Number(env("DIGEST_BATCH_SIZE"))\n  for (let start')
