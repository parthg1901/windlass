import { join } from "node:path"

const file = join(process.argv[2]!, "src/calendar.ts")
const source = await Bun.file(file).text()
await Bun.write(file, source.replace("year % 4 === 0 && year % 100 !== 0", "(year % 4 === 0 && year % 100 !== 0) || year % 400 === 0"))
