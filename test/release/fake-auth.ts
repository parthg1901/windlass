/**
 * A fake ChatGPT authorization server for the sign-in tests: the three
 * endpoints `packages/core/src/auth/chatgpt.ts` talks to, with the checks a
 * real one makes (PKCE, the redirect URI, the issued client ID) and an ID
 * token signed with a key it publishes. A refresh rotates the refresh token
 * and refuses one already used. Nothing here reaches the network.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuthConfig } from "../../packages/core/src/auth/chatgpt.ts"

export const ISSUED_CLIENT_ID = "client_issued_test"
export const ACCOUNT = { sub: "user_test", email: "someone@example.test" }

export interface FakeAuth {
  readonly config: AuthConfig
  readonly dir: string
  /** Tokens it handed out: they must never appear in the program's output. */
  readonly secrets: string[]
  /** How many requests the token endpoint has had, and how many of them were refreshes it granted. */
  requests(): { readonly token: number; readonly refreshes: number }
  /** What the browser would do: follow the authorize address and return where it was sent back to. */
  authorize(url: string, options?: { deny?: boolean }): Promise<string>
  stop(): void
}

export async function startFakeAuth(options: { scopes?: string } = {}): Promise<FakeAuth> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "test-key", alg: "ES256", use: "sig" }
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>()
  const secrets: string[] = []
  let counter = 0
  let tokenRequests = 0
  let refreshes = 0
  /** The one refresh token that is still good. */
  let current: string | null = null
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/authorize") {
        const params = url.searchParams
        const back = new URL(params.get("redirect_uri")!)
        back.searchParams.set("state", params.get("state")!)
        if (params.get("deny") === "1") back.searchParams.set("error", "access_denied")
        else {
          const code = `code_${++counter}`
          codes.set(code, { challenge: params.get("code_challenge")!, nonce: params.get("nonce")!, redirectUri: back.origin + back.pathname })
          back.searchParams.set("code", code)
          back.searchParams.set("client_id", ISSUED_CLIENT_ID)
        }
        return Response.redirect(back.href, 302)
      }
      if (url.pathname === "/token") {
        tokenRequests += 1
        const form = new URLSearchParams(await request.text())
        if (form.get("grant_type") === "refresh_token") {
          if (current === null || form.get("refresh_token") !== current || form.get("client_id") !== ISSUED_CLIENT_ID)
            return Response.json({ error: "invalid_grant", error_description: "the refresh token was already used or is not known" }, { status: 400 })
          refreshes += 1
          const accessToken = `access-${crypto.randomUUID()}`
          current = `refresh-${crypto.randomUUID()}`
          secrets.push(accessToken, current)
          return Response.json({ access_token: accessToken, refresh_token: current, expires_in: 3600 })
        }
        const grant = codes.get(form.get("code") ?? "")
        const challenge = Buffer.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")))).toString("base64url")
        if (grant === undefined || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri") || form.get("client_id") !== ISSUED_CLIENT_ID)
          return Response.json({ error: "invalid_grant", error_description: "the code, verifier, redirect URI or client does not match" }, { status: 400 })
        codes.delete(form.get("code")!)
        const now = Math.floor(Date.now() / 1000)
        const idToken = await sign(keys.privateKey, { iss: issuer, aud: ISSUED_CLIENT_ID, sub: ACCOUNT.sub, email: ACCOUNT.email, nonce: grant.nonce, exp: now + 3600, iat: now })
        const accessToken = `access-${crypto.randomUUID()}`
        const refreshToken = `refresh-${crypto.randomUUID()}`
        secrets.push(accessToken, refreshToken, idToken)
        current = refreshToken
        return Response.json({ access_token: accessToken, refresh_token: refreshToken, id_token: idToken, expires_in: 3600, scope: options.scopes ?? "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" })
      }
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] })
      return new Response("not found", { status: 404 })
    },
  })
  const issuer = `http://127.0.0.1:${server.port}`
  const dir = mkdtempSync(join(tmpdir(), "release-auth-"))
  return {
    config: { issuer, authorizeUrl: `${issuer}/authorize`, tokenUrl: `${issuer}/token`, jwksUrl: `${issuer}/jwks`, dataDir: () => dir },
    dir,
    secrets,
    requests: () => ({ token: tokenRequests, refreshes }),
    authorize: async (address, { deny = false } = {}) => {
      const response = await fetch(deny ? `${address}&deny=1` : address, { redirect: "manual" })
      return response.headers.get("location")!
    },
    stop: () => {
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function sign(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const input = `${part({ alg: "ES256", kid: "test-key", typ: "JWT" })}.${part(claims)}`
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input))
  return `${input}.${Buffer.from(new Uint8Array(signature)).toString("base64url")}`
}
