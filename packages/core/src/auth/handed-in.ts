// A sign-in handed in from outside. Several processes can run on one ChatGPT-plan sign-in without sharing a data
// directory (each in a sandbox of its own, on machines of their own): refresh tokens rotate, so a copied `auth.json`
// signs the other copies out at its first refresh. Instead one process holds the sign-in and does all the
// refreshing, and hands the others its short-lived access token (`login token`), which they read from a file.
//
// This is the reading side: the variable that names the file, and the file's two forms. It is not an API key and
// not another provider: the token is the access token of a ChatGPT-plan sign-in that another process holds.

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { brand } from "../brand.ts"

/** Names the file an access token is handed in through. Set and not empty: the saved sign-in is not used at all. */
export const ACCESS_TOKEN_FILE_ENV = `${brand.envPrefix}ACCESS_TOKEN_FILE`

/** What to do about a handed-in token that cannot be used. Every message about one ends with it. */
export const HAND_IN_ADVICE = `Hand in a new token: write the output of \`${brand.binary} login token\`, run where the sign-in is saved, to that file.`

/** A handed-in token that the provider rejected; `detail` is the provider's answer. */
export const handedInRejected = (detail: string) => `The access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected (${detail}). ${HAND_IN_ADVICE}`

/** Why a handed-in token cannot be used. Stable: a caller may tell them apart. */
export type HandedInProblem = "handed_in_missing" | "handed_in_unreadable" | "handed_in_empty" | "handed_in_malformed" | "handed_in_expired"

/** What the file gives. `expiresAt` (milliseconds since the epoch) is `null` when the file does not state one. */
export type HandedIn =
  | { readonly usable: true; readonly accessToken: string; readonly expiresAt: number | null }
  | { readonly usable: false; readonly code: HandedInProblem; readonly message: string; readonly expiresAt: number | null }

/** The file the access token is handed in through (absolute), or `null` when the variable is unset or empty. */
export function handedInTokenFile(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const value = env[ACCESS_TOKEN_FILE_ENV]
  return value === undefined || value === "" ? null : resolve(value)
}

/** Whether a message about the sign-in is about a handed-in token: it names the variable and says what to do itself. */
export function aboutHandedIn(message: string): boolean {
  return message.includes(ACCESS_TOKEN_FILE_ENV)
}

// What can go into an `Authorization` header: no spaces, no control characters.
const TOKEN = /^[\x21-\x7e]+$/

/**
 * Reads the file as it is now. It holds the bare token, or the object `login token --json` prints
 * (`{"accessToken": string, "expiresAt": number}`); surrounding whitespace is ignored. Never throws, and no message
 * contains anything the file holds.
 */
export async function readHandedIn(path: string, now: number = Date.now()): Promise<HandedIn> {
  const problem = (code: HandedInProblem, what: string, expiresAt: number | null = null): HandedIn => ({ usable: false, code, message: `${what} (${path}). ${HAND_IN_ADVICE}`, expiresAt })
  const file = `The file ${ACCESS_TOKEN_FILE_ENV} names`
  let text: string
  try {
    text = (await readFile(path, "utf8")).trim()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" ? problem("handed_in_missing", `${file} does not exist`) : problem("handed_in_unreadable", `${file} cannot be read${code === undefined ? "" : `: ${code}`}`)
  }
  if (text === "") return problem("handed_in_empty", `${file} is empty`)
  const malformed = () => problem("handed_in_malformed", `${file} holds neither an access token nor what \`${brand.binary} login token --json\` prints`)
  if (!text.startsWith("{")) return TOKEN.test(text) ? { usable: true, accessToken: text, expiresAt: null } : malformed()
  let value: { accessToken?: unknown; expiresAt?: unknown }
  try {
    value = JSON.parse(text)
  } catch {
    return malformed()
  }
  const { accessToken, expiresAt } = value
  // A time a `Date` can hold, so that it can be shown.
  if (typeof accessToken !== "string" || !TOKEN.test(accessToken) || typeof expiresAt !== "number" || !(Math.abs(expiresAt) <= 8.64e15)) return malformed()
  if (expiresAt <= now) return problem("handed_in_expired", `The access token handed in through ${ACCESS_TOKEN_FILE_ENV} expired at ${new Date(expiresAt).toISOString()}`, expiresAt)
  return { usable: true, accessToken, expiresAt }
}
