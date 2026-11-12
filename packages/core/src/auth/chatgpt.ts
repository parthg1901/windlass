// Sign in with ChatGPT for open-source, locally hosted apps (ChatGPT plan usage).
// Flow reference: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//
// The first sign-in registers a client owned by the user: we send the fixed
// registration entrypoint as `client_id`, and OpenAI returns the issued client ID on
// the callback. That issued ID, never the entrypoint, is used for token exchange,
// refresh and later sign-ins.

import { Database, SQLiteError } from "bun:sqlite"
import type { webcrypto } from "node:crypto"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { brand } from "../brand.ts"

const ISSUER = "https://auth.openai.com"
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
export const RESOURCE = "https://api.openai.com/v1"
const REGISTRATION_CLIENT_ID = "dynamic_agent_client"
const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct"
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_USAGE_SCOPE}`
const AGENT_NAME = brand.name
const DEFAULT_PORT = 1455
// Refresh this long before expiry so a request never starts with a token about to lapse.
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export type Credentials = {
  hostId: string
  clientId: string
  account: { sub: string; email?: string }
  accessToken: string
  refreshToken: string
  idToken: string
  scopes: string[]
  expiresAt: number
}

export type PendingLogin = {
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  hostId: string
  // Present on reauthorization: the client ID already issued to this host.
  clientId?: string
  createdAt: number
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "AuthError"
  }
}

export function dataDir() {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), brand.directory)
}

/**
 * Where the sign-in talks to and where it keeps its files. Production uses
 * `CHATGPT_AUTH`; a test passes its own (a fake authorization server and a
 * temporary directory) to every function that takes one.
 */
export interface AuthConfig {
  /** The `iss` an ID token must carry. */
  readonly issuer: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly jwksUrl: string
  /** The directory `auth.json`, `auth-pending.json` and `host-id` are kept in. */
  readonly dataDir: () => string
}

export const CHATGPT_AUTH: AuthConfig = { issuer: ISSUER, authorizeUrl: AUTHORIZE_URL, tokenUrl: TOKEN_URL, jwksUrl: JWKS_URL, dataDir }

/** The loopback port the browser is sent back to, unless `beginLogin` is given another. */
export const LOGIN_PORT = DEFAULT_PORT

export const credentialsPath = (config: AuthConfig = CHATGPT_AUTH) => join(config.dataDir(), "auth.json")
export const pendingPath = (config: AuthConfig = CHATGPT_AUTH) => join(config.dataDir(), "auth-pending.json")
const hostIdPath = (config: AuthConfig) => join(config.dataDir(), "host-id")

export async function loadCredentials(config: AuthConfig = CHATGPT_AUTH): Promise<Credentials | undefined> {
  const file = Bun.file(credentialsPath(config))
  if (!(await file.exists())) return undefined
  return (await file.json()) as Credentials
}

export async function loadPending(config: AuthConfig = CHATGPT_AUTH): Promise<PendingLogin | undefined> {
  const file = Bun.file(pendingPath(config))
  if (!(await file.exists())) return undefined
  return (await file.json()) as PendingLogin
}

/** Forgets the saved sign-in and any sign-in in progress. The host ID stays, so the next sign-in reuses this host's registration. */
export async function forgetCredentials(config: AuthConfig = CHATGPT_AUTH): Promise<boolean> {
  const had = await Bun.file(credentialsPath(config)).exists()
  await rm(credentialsPath(config), { force: true })
  await rm(pendingPath(config), { force: true })
  return had
}

/** Builds the authorize URL and saves the PKCE state so a later process can finish the login. */
export async function beginLogin(options: { port?: number; config?: AuthConfig } = {}): Promise<{ url: string; pending: PendingLogin }> {
  const config = options.config ?? CHATGPT_AUTH
  const saved = await loadCredentials(config)
  const verifier = randomToken(48)
  const pending: PendingLogin = {
    state: randomToken(24),
    nonce: randomToken(24),
    verifier,
    redirectUri: `http://127.0.0.1:${options.port ?? DEFAULT_PORT}/auth/callback`,
    hostId: saved?.hostId ?? (await hostId(config)),
    ...(saved ? { clientId: saved.clientId } : {}),
    createdAt: Date.now(),
  }
  const params = new URLSearchParams({
    client_id: pending.clientId ?? REGISTRATION_CLIENT_ID,
    ...(pending.clientId ? {} : { agent_name_hint: AGENT_NAME }),
    ext_agent_host_id: pending.hostId,
    ...(saved ? { id_token_hint: saved.idToken } : {}),
    response_type: "code",
    redirect_uri: pending.redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: "S256",
    code_challenge: await sha256Base64Url(verifier),
  })
  await writePrivate(pendingPath(config), pending)
  return { url: `${config.authorizeUrl}?${params}`, pending }
}

/**
 * Completes a login from the callback URL (or just its query string). Works both for a
 * loopback listener and for a URL pasted from a browser on another machine.
 */
export async function finishLogin(callback: string, pending?: PendingLogin, config: AuthConfig = CHATGPT_AUTH): Promise<Credentials> {
  const login = pending ?? (await loadPending(config))
  if (!login) throw new AuthError("no_pending_login", "No sign-in is in progress. Start one first.")
  const params = callbackParams(callback)
  if (params.get("state") !== login.state)
    throw new AuthError("state_mismatch", "The callback does not belong to the sign-in that is in progress.")
  const error = params.get("error")
  if (error) throw new AuthError(error, params.get("error_description") ?? `Sign-in was not completed (${error}).`)
  const code = params.get("code")
  if (!code) throw new AuthError("missing_code", "The callback has no authorization code.")
  const returnedId = params.get("client_id") ?? undefined
  if (login.clientId && returnedId && returnedId !== login.clientId)
    throw new AuthError("client_mismatch", "The callback returned a different client ID than the one saved.")
  const clientId = login.clientId ?? returnedId
  if (!clientId || clientId === REGISTRATION_CLIENT_ID)
    throw new AuthError("registration_incomplete", "Registration did not return an issued client ID.")

  const tokens = await tokenRequest(config, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: login.verifier,
    redirect_uri: login.redirectUri,
    resource: RESOURCE,
  })
  const claims = await verifyIdToken(config, tokens.id_token, clientId, login.nonce)
  const previous = await loadCredentials(config)
  if (previous && previous.clientId === clientId && previous.account.sub !== claims.sub)
    throw new AuthError("account_mismatch", "This sign-in is for a different account than the saved one.")
  const credentials = toCredentials(tokens, clientId, login.hostId, claims, [])
  if (!credentials.scopes.includes(PLAN_USAGE_SCOPE))
    throw new AuthError("plan_usage_not_granted", "Sign-in succeeded but ChatGPT plan usage was not granted.")
  await writePrivate(credentialsPath(config), credentials)
  await rm(pendingPath(config), { force: true })
  return credentials
}

// One refresh at a time, in this process and across processes: refresh tokens rotate, so a second
// concurrent refresh would present a token that the first one already consumed.
let refreshing: Promise<Credentials> | undefined

const fresh = (credentials: Credentials) => credentials.expiresAt - Date.now() > REFRESH_MARGIN_MS

/** Returns a usable access token, refreshing and saving the rotated tokens when needed. */
export async function accessToken(config: AuthConfig = CHATGPT_AUTH): Promise<string> {
  const credentials = await loadCredentials(config)
  if (!credentials) throw new AuthError("signed_out", "Not signed in. Run the sign-in first.")
  if (fresh(credentials)) return credentials.accessToken
  refreshing ??= refreshOnce(config).finally(() => {
    refreshing = undefined
  })
  return (await refreshing).accessToken
}

const REFRESH_LOCK_WAIT_MS = 30_000
const REFRESH_LOCK_POLL_MS = 100

/**
 * Refreshes under `<data dir>/auth.lock`, an exclusive transaction on a SQLite database used only for that
 * (the operating system drops it when the holder dies). Whoever waited for the lock reads the file again
 * first: the process that held it has usually just saved the tokens this one needs.
 */
async function refreshOnce(config: AuthConfig): Promise<Credentials> {
  await mkdir(config.dataDir(), { recursive: true, mode: 0o700 })
  const lock = new Database(join(config.dataDir(), "auth.lock"), { create: true })
  try {
    lock.run("PRAGMA busy_timeout = 0")
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MS
    for (;;) {
      try {
        lock.run("BEGIN EXCLUSIVE")
        break
      } catch (error) {
        if (!(error instanceof SQLiteError && error.code?.startsWith("SQLITE_BUSY"))) throw error
        if (Date.now() >= deadline)
          throw new AuthError("refresh_locked", "Another process has been refreshing the sign-in for too long. Try again.")
        await Bun.sleep(REFRESH_LOCK_POLL_MS)
      }
    }
    try {
      const credentials = await loadCredentials(config)
      if (!credentials) throw new AuthError("signed_out", "Not signed in. Run the sign-in first.")
      if (fresh(credentials)) return credentials
      return await refresh(config, credentials)
    } finally {
      lock.run("ROLLBACK")
    }
  } finally {
    lock.close()
  }
}

async function refresh(config: AuthConfig, credentials: Credentials): Promise<Credentials> {
  const tokens = await tokenRequest(config, {
    grant_type: "refresh_token",
    client_id: credentials.clientId,
    refresh_token: credentials.refreshToken,
    resource: RESOURCE,
  })
  const next = toCredentials(
    { ...tokens, id_token: tokens.id_token ?? credentials.idToken },
    credentials.clientId,
    credentials.hostId,
    credentials.account,
    credentials.scopes,
  )
  await writePrivate(credentialsPath(config), next)
  return next
}

type TokenResponse = {
  access_token: string
  refresh_token: string
  id_token: string
  expires_in?: number
  scope?: string
}

async function tokenRequest(config: AuthConfig, body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `${AGENT_NAME}/0` },
    body: new URLSearchParams(body),
  })
  const text = await response.text()
  const json = parseJson(text)
  if (!response.ok) {
    const code = typeof json?.error === "string" ? json.error : `http_${response.status}`
    const detail = typeof json?.error_description === "string" ? json.error_description : text.slice(0, 300)
    throw new AuthError(code, `Token request failed (${response.status} ${code}): ${detail}`)
  }
  if (typeof json?.access_token !== "string" || typeof json.refresh_token !== "string")
    throw new AuthError("bad_token_response", "The token response is missing tokens.")
  return json as unknown as TokenResponse
}

function toCredentials(
  tokens: TokenResponse,
  clientId: string,
  hostId: string,
  account: { sub: string; email?: string },
  fallbackScopes: string[],
): Credentials {
  return {
    hostId,
    clientId,
    account: { sub: account.sub, ...(account.email ? { email: account.email } : {}) },
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    scopes: tokens.scope?.split(" ").filter(Boolean) ?? fallbackScopes,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }
}

type IdClaims = { sub: string; email?: string }

async function verifyIdToken(config: AuthConfig, token: string, audience: string, nonce: string): Promise<IdClaims> {
  const [headerPart, payloadPart, signaturePart] = token.split(".")
  if (!headerPart || !payloadPart || !signaturePart) throw new AuthError("bad_id_token", "The ID token is malformed.")
  const header = parseJson(decodeBase64Url(headerPart))
  const claims = parseJson(decodeBase64Url(payloadPart))
  if (!header || !claims) throw new AuthError("bad_id_token", "The ID token is malformed.")

  const algorithm =
    header.alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : header.alg === "ES256"
        ? { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }
        : undefined
  if (!algorithm) throw new AuthError("bad_id_token", `Unsupported ID token algorithm: ${String(header.alg)}`)
  const jwks = (await (await fetch(config.jwksUrl)).json()) as { keys?: Array<Record<string, unknown> & { kid?: string }> }
  const jwk = jwks.keys?.find((key) => key.kid === header.kid)
  if (!jwk) throw new AuthError("bad_id_token", "No published key matches the ID token.")
  const key = await crypto.subtle.importKey("jwk", jwk as webcrypto.JsonWebKey, algorithm, false, ["verify"])
  const valid = await crypto.subtle.verify(
    algorithm,
    key,
    bytesFromBase64Url(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  )
  if (!valid) throw new AuthError("bad_id_token", "The ID token signature is invalid.")

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== config.issuer) throw new AuthError("bad_id_token", "The ID token has the wrong issuer.")
  if (!audiences.includes(audience)) throw new AuthError("bad_id_token", "The ID token is for a different client.")
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now())
    throw new AuthError("bad_id_token", "The ID token has expired.")
  if (claims.nonce !== nonce) throw new AuthError("bad_id_token", "The ID token nonce does not match.")
  if (typeof claims.sub !== "string") throw new AuthError("bad_id_token", "The ID token has no subject.")
  return { sub: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) }
}

async function hostId(config: AuthConfig) {
  const file = Bun.file(hostIdPath(config))
  if (await file.exists()) return (await file.text()).trim()
  const id = `urn:uuid:${crypto.randomUUID()}`
  await writePrivate(hostIdPath(config), id)
  return id
}

function callbackParams(callback: string) {
  const trimmed = callback.trim()
  const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed
  return new URLSearchParams(query.split("#")[0])
}

// Write to a temporary file and rename so a crash never leaves half-written credentials.
async function writePrivate(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await Bun.write(temporary, typeof value === "string" ? value : JSON.stringify(value, null, 2))
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function randomToken(bytes: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function sha256Base64Url(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}

function bytesFromBase64Url(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"))
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8")
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
