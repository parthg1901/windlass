import { handleGetUser } from "./api.ts"
import { describe } from "./report.ts"

for (const id of [1, 2, 4]) console.log(describe(id))
console.log(JSON.stringify(handleGetUser("3")))
console.log(JSON.stringify(handleGetUser("9")))
