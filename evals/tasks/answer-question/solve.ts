import { join } from "node:path"

await Bun.write(join(process.argv[2]!, "answer.txt"), "3600\n")
