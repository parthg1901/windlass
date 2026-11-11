// bun cli.ts <command> [<record-id>]: runs one command on a sample record and prints the result and the record.
import { COMMANDS } from "./src/commands.ts"
import { sample } from "./src/record.ts"

const [name, id = "rec-1"] = process.argv.slice(2)
const command = name === undefined ? undefined : COMMANDS.get(name)
if (command === undefined) {
  console.error(`unknown command ${name ?? "(none)"}; there are ${COMMANDS.size}`)
  process.exit(2)
}
const record = sample(id)
const result = command(record)
console.log(result.ok ? "ok" : "not run")
console.log(JSON.stringify(record, null, 2))
