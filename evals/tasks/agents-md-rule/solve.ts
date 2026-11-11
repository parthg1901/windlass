import { join } from "node:path"

const routes = join(process.argv[2]!, "packages/api/src/routes")
await Bun.write(
  join(routes, "health.route.ts"),
  `import { json } from "../http.ts"

export default function handleHealth() {
  return json({ status: "ok" })
}
`,
)
const index = join(routes, "index.ts")
await Bun.write(
  index,
  (await Bun.file(index).text())
    .replace('import handleUsers', 'import handleHealth from "./health.route.ts"\nimport handleUsers')
    .replace('  { method: "GET", path: "/users"', '  { method: "GET", path: "/health", handler: handleHealth },\n  { method: "GET", path: "/users"'),
)
