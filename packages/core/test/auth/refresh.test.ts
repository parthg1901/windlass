/**
 * Refresh tokens rotate: a token presented twice is refused. Several harness
 * processes share one `auth.json`, so the refresh must happen once across all
 * of them, and the ones that waited must use what the first one saved.
 */
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accessToken, type AuthConfig, type Credentials } from "../../src/auth/chatgpt.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A token endpoint that rotates refresh tokens, refuses a used one, and answers slowly enough for callers to overlap. */
function tokenServer() {
  let current = "refresh_0"
  let refreshes = 0
  const refused: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const form = new URLSearchParams(await request.text())
      await Bun.sleep(300)
      const presented = form.get("refresh_token")
      if (presented !== current) {
        refused.push(String(presented))
        return Response.json({ error: "invalid_grant", error_description: "refresh token was already used" }, { status: 400 })
      }
      refreshes += 1
      current = `refresh_${refreshes}`
      return Response.json({ access_token: `access_${refreshes}`, refresh_token: current, expires_in: 3600 })
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}/token`, refreshes: () => refreshes, refused }
}

function staleSignIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-refresh-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const credentials: Credentials = {
    hostId: "host",
    clientId: "client",
    account: { sub: "user_test" },
    accessToken: "access_0",
    refreshToken: "refresh_0",
    idToken: "id",
    scopes: [],
    expiresAt: Date.now() + 60_000,
  }
  writeFileSync(join(dir, "auth.json"), JSON.stringify(credentials))
  return dir
}

test("several processes that find the token stale refresh it once and all use the new one", async () => {
  const server = tokenServer()
  const dir = staleSignIn()
  const child = join(import.meta.dir, "refresh-child.ts")
  const processes = Array.from({ length: 4 }, () => Bun.spawn(["bun", child, server.url, dir], { stdout: "pipe", stderr: "pipe" }))
  const results = await Promise.all(
    processes.map(async (process) => ({ code: await process.exited, out: (await new Response(process.stdout).text()).trim(), err: await new Response(process.stderr).text() })),
  )
  expect(results.map((result) => result.err).join("")).toBe("")
  expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0])
  expect(results.map((result) => result.out)).toEqual(["access_1", "access_1", "access_1", "access_1"])
  expect(server.refreshes()).toBe(1)
  expect(server.refused).toEqual([])
}, 30_000)

test("several callers in one process refresh once", async () => {
  const server = tokenServer()
  const dir = staleSignIn()
  const config: AuthConfig = { issuer: "test", authorizeUrl: "", tokenUrl: server.url, jwksUrl: "", dataDir: () => dir }
  expect(await Promise.all([accessToken(config), accessToken(config), accessToken(config)])).toEqual(["access_1", "access_1", "access_1"])
  expect(server.refreshes()).toBe(1)
})
