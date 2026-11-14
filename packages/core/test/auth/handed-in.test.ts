/**
 * A sign-in handed in from outside (`src/auth/handed-in.ts`): the access token is read from the file the variable
 * names on every call, in either of its two forms, and the saved sign-in is then left alone: not read, not
 * refreshed, not written. Each way the file can fail has a code of its own and a message that names the variable
 * and says what to do.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { brand } from "../../src/brand.ts"
import { ACCESS_TOKEN_FILE_ENV, type AuthConfig, AuthError, type Credentials, HAND_IN_ADVICE, aboutHandedIn, accessToken, handedInTokenFile, readHandedIn, savedAccessToken } from "../../src/auth/chatgpt.ts"
import { FAILURE_TEXT, failureText } from "../../src/engine/constants.ts"
import { makeProviderError } from "../../src/provider/error.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)

/** A token endpoint that counts what it is asked: in this mode, nothing. */
function tokenServer() {
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1
      return Response.json({ access_token: `refreshed_${requests}`, refresh_token: `refresh_${requests}`, expires_in: 3600 })
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}/token`, requests: () => requests }
}

/** A data directory with a saved sign-in that is due for its refresh, and a place for the handed-in file beside it. */
function place(tokenUrl = "") {
  const root = mkdtempSync(join(tmpdir(), "auth-handed-in-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const data = join(root, "data")
  mkdirSync(data)
  const saved: Credentials = { hostId: "host", clientId: "client", account: { sub: "user_test" }, accessToken: "saved_access_0", refreshToken: "refresh_0", idToken: "id", scopes: [], expiresAt: Date.now() + 60_000 }
  writeFileSync(join(data, "auth.json"), JSON.stringify(saved))
  const file = join(root, "handed-in", "token")
  mkdirSync(join(root, "handed-in"))
  const config = (env: Record<string, string | undefined> = { [ACCESS_TOKEN_FILE_ENV]: file }): AuthConfig => ({ issuer: "test", authorizeUrl: "", tokenUrl, jwksUrl: "", dataDir: () => data, env })
  return { root, data, file, config }
}

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof AuthError)) throw new Error(`expected an AuthError, got ${String(error)}`)
  return error
}

describe("the variable", () => {
  test("is named from the brand's prefix, and names a file only when it is set and not empty", () => {
    expect(ACCESS_TOKEN_FILE_ENV).toBe(`${brand.envPrefix}ACCESS_TOKEN_FILE`)
    expect(handedInTokenFile({})).toBeNull()
    expect(handedInTokenFile({ [ACCESS_TOKEN_FILE_ENV]: "" })).toBeNull()
    expect(handedInTokenFile({ [ACCESS_TOKEN_FILE_ENV]: "/run/handed-in/token" })).toBe("/run/handed-in/token")
    // A relative path is the process's, as the file is opened.
    expect(handedInTokenFile({ [ACCESS_TOKEN_FILE_ENV]: "token" })).toBe(resolve("token"))
  })

  test("without it the saved sign-in is used, refreshed when it is due", async () => {
    const server = tokenServer()
    const at = place(server.url)
    expect(await accessToken(at.config({}))).toBe("refreshed_1")
    expect(server.requests()).toBe(1)
  })
})

describe("the file", () => {
  test("holds the bare token or what `login token --json` prints, with whitespace around either ignored", async () => {
    const at = place()
    writeFileSync(at.file, "handed-token-0001")
    expect(await readHandedIn(at.file, NOW)).toEqual({ usable: true, accessToken: "handed-token-0001", expiresAt: null })
    writeFileSync(at.file, "\n  handed-token-0002\t\r\n\n")
    expect(await readHandedIn(at.file, NOW)).toEqual({ usable: true, accessToken: "handed-token-0002", expiresAt: null })
    writeFileSync(at.file, `${JSON.stringify({ accessToken: "handed-token-0003", expiresAt: NOW + 1 })}\n`)
    expect(await readHandedIn(at.file, NOW)).toEqual({ usable: true, accessToken: "handed-token-0003", expiresAt: NOW + 1 })
    // Through `accessToken` the time is the clock's.
    writeFileSync(at.file, `\n {\n  "accessToken": "handed-token-0004",\n  "expiresAt": ${Date.now() + 600_000}\n }\n`)
    expect(await accessToken(at.config())).toBe("handed-token-0004")
  })

  test("is read on every call, so whoever handed the token in can replace it while the process runs", async () => {
    const at = place()
    const config = at.config()
    writeFileSync(at.file, "handed-token-first")
    expect(await accessToken(config)).toBe("handed-token-first")
    writeFileSync(at.file, JSON.stringify({ accessToken: "handed-token-second", expiresAt: Date.now() + 60_000 }))
    expect(await accessToken(config)).toBe("handed-token-second")
    rmSync(at.file)
    expect((await failure(accessToken(config))).code).toBe("handed_in_missing")
    writeFileSync(at.file, "handed-token-third")
    expect(await accessToken(config)).toBe("handed-token-third")
  })

  test("each way it cannot be used has its own code, names the variable and says to hand in a new token", async () => {
    const at = place()
    const config = at.config()
    const cases: readonly (readonly [string, () => void, string])[] = [
      ["handed_in_missing", () => rmSync(at.file, { force: true }), `The file ${ACCESS_TOKEN_FILE_ENV} names does not exist (${at.file}). ${HAND_IN_ADVICE}`],
      ["handed_in_empty", () => writeFileSync(at.file, ""), `The file ${ACCESS_TOKEN_FILE_ENV} names is empty (${at.file}). ${HAND_IN_ADVICE}`],
      ["handed_in_empty", () => writeFileSync(at.file, " \n\t\n"), `The file ${ACCESS_TOKEN_FILE_ENV} names is empty (${at.file}). ${HAND_IN_ADVICE}`],
      [
        "handed_in_expired",
        () => writeFileSync(at.file, JSON.stringify({ accessToken: "handed-token-old", expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5) })),
        `The access token handed in through ${ACCESS_TOKEN_FILE_ENV} expired at 2026-01-02T03:04:05.000Z (${at.file}). ${HAND_IN_ADVICE}`,
      ],
    ]
    for (const [code, arrange, message] of cases) {
      arrange()
      const error = await failure(accessToken(config))
      expect([error.code, error.message]).toEqual([code, message])
    }
    // Unreadable: something is there and it cannot be read as a file.
    rmSync(at.file, { force: true })
    mkdirSync(at.file)
    const unreadable = await failure(accessToken(config))
    expect([unreadable.code, unreadable.message]).toEqual(["handed_in_unreadable", `The file ${ACCESS_TOKEN_FILE_ENV} names cannot be read: EISDIR (${at.file}). ${HAND_IN_ADVICE}`])
    expect(aboutHandedIn(unreadable.message)).toBe(true)
    expect(aboutHandedIn("Not signed in. Run the sign-in first.")).toBe(false)
    expect(HAND_IN_ADVICE).toStartWith("Hand in a new token")
    expect(HAND_IN_ADVICE).toContain(`\`${brand.binary} login token\``)
  })

  test("a file whose permissions refuse the read is unreadable, not missing", async () => {
    // Root reads through any mode, so there is nothing to tell apart for it.
    if (process.getuid?.() === 0) return
    const at = place()
    writeFileSync(at.file, "handed-token-locked")
    chmodSync(at.file, 0o000)
    expect((await failure(accessToken(at.config()))).code).toBe("handed_in_unreadable")
  })

  test("what is neither form is malformed, and no message repeats anything the file holds", async () => {
    const at = place()
    const malformed = [
      "two words",
      "line-one\nline-two",
      "{",
      '{"accessToken": "handed-token-secret"',
      '{"accessToken": "handed-token-secret"}',
      '{"accessToken": "handed-token-secret", "expiresAt": "soon"}',
      '{"accessToken": "handed-token-secret", "expires_at": 1}',
      '{"accessToken": "", "expiresAt": 1}',
      '{"accessToken": 7, "expiresAt": 1}',
      '{"accessToken": "handed token secret", "expiresAt": 1}',
      '{"accessToken": "handed-token-secret", "expiresAt": 1e300}',
      '{"expiresAt": 1}',
    ]
    for (const content of malformed) {
      writeFileSync(at.file, content)
      const error = await failure(accessToken(at.config()))
      expect([content, error.code]).toEqual([content, "handed_in_malformed"])
      expect(error.message).toBe(`The file ${ACCESS_TOKEN_FILE_ENV} names holds neither an access token nor what \`${brand.binary} login token --json\` prints (${at.file}). ${HAND_IN_ADVICE}`)
    }
    // A token that has just expired is expired, and its value is not in the message either.
    writeFileSync(at.file, JSON.stringify({ accessToken: "handed-token-secret", expiresAt: NOW }))
    const expired = await readHandedIn(at.file, NOW)
    expect(expired).toMatchObject({ usable: false, code: "handed_in_expired", expiresAt: NOW })
    expect(JSON.stringify(expired)).not.toContain("handed-token-secret")
  })
})

describe("the saved sign-in in this mode", () => {
  test("is not read, refreshed or written: no token request, and the data directory is as it was", async () => {
    const server = tokenServer()
    const at = place(server.url)
    const before = readFileSync(join(at.data, "auth.json"), "utf8")
    writeFileSync(at.file, "handed-token-0001")
    // The saved sign-in is due for its refresh: used, it would be refreshed and rewritten.
    expect(await accessToken(at.config())).toBe("handed-token-0001")
    rmSync(at.file)
    await failure(accessToken(at.config()))
    expect(server.requests()).toBe(0)
    expect(readdirSync(at.data)).toEqual(["auth.json"])
    expect(readFileSync(join(at.data, "auth.json"), "utf8")).toBe(before)
    // Not read: a saved sign-in that cannot even be parsed changes nothing.
    writeFileSync(join(at.data, "auth.json"), "not json")
    writeFileSync(at.file, "handed-token-0002")
    expect(await accessToken(at.config())).toBe("handed-token-0002")
    expect(readdirSync(at.data)).toEqual(["auth.json"])
  })

  test("is still what `savedAccessToken` gives, with its expiry, whatever the variable says", async () => {
    const server = tokenServer()
    const at = place(server.url)
    writeFileSync(at.file, "handed-token-0001")
    const saved = await savedAccessToken(at.config())
    expect(saved.accessToken).toBe("refreshed_1")
    expect(saved.expiresAt).toBeGreaterThan(Date.now() + 3_000_000)
    expect(server.requests()).toBe(1)
    // Fresh now: handed on as it is.
    expect((await savedAccessToken(at.config())).accessToken).toBe("refreshed_1")
    expect(server.requests()).toBe(1)
  })
})

describe("a turn that ends on rejected credentials", () => {
  const rejected = makeProviderError("auth", "HTTP 401: Unauthorized", { status: 401 })
  const saved = process.env[ACCESS_TOKEN_FILE_ENV]
  afterEach(() => {
    if (saved === undefined) delete process.env[ACCESS_TOKEN_FILE_ENV]
    else process.env[ACCESS_TOKEN_FILE_ENV] = saved
  })

  test("says to sign in again when the sign-in is this machine's", () => {
    delete process.env[ACCESS_TOKEN_FILE_ENV]
    expect(failureText(rejected)).toBe(FAILURE_TEXT.signedOut)
  })

  test("says the handed-in token was rejected and names the variable when it is handed in", () => {
    process.env[ACCESS_TOKEN_FILE_ENV] = "/run/handed-in/token"
    expect(failureText(rejected)).toBe(`Signed out: the access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected or cannot be used. Hand in a new token to continue.`)
    expect(failureText(rejected)).not.toContain("sign in again")
    expect(aboutHandedIn(failureText(rejected))).toBe(true)
  })
})
