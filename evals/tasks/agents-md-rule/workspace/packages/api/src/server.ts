import { json } from "./http.ts"
import { routes } from "./routes/index.ts"

export function dispatch(method: string, path: string) {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path)
  return route ? route.handler() : json({ error: "not found" }, 404)
}

if (import.meta.main) {
  const server = Bun.serve({ port: 0, fetch: (request) => dispatch(request.method, new URL(request.url).pathname) })
  console.log(`listening on ${server.url}`)
}
