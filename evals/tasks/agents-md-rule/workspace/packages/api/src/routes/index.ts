import handleUsers from "./users.route.ts"
import handleVersion from "./version.route.ts"

export interface Route {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly handler: () => Response | Promise<Response>
}

export const routes: Route[] = [
  { method: "GET", path: "/users", handler: handleUsers },
  { method: "GET", path: "/version", handler: handleVersion },
]
