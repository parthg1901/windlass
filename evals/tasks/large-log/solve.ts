import { join } from "node:path"

const dir = process.argv[2]!
const users = new Set<string>()
for (const line of (await Bun.file(join(dir, "data/events.log")).text()).split("\n")) {
  const match = line.match(/ level=ERROR user=(\S+) code=E42 /)
  if (match) users.add(match[1]!)
}
await Bun.write(join(dir, "answer.txt"), `${users.size}\n`)
