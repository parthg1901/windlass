#!/usr/bin/env bun
/**
 * Sends one signed request to a webhook wake-up, as `docs/wake-ups.md` describes (a timestamp and an HMAC-SHA256 of
 * `<timestamp>.<body>`), and prints the status and the answer. The secret is read from the environment variable
 * WAKE_SECRET or, with `--secret-stdin`, from standard input; it is never printed and never an argument.
 *
 *   WAKE_SECRET=... bun evals/dogfood/webhook.ts http://127.0.0.1:47863/w/wk_... --body '{"status":"deployed"}'
 *   ... --github          sign as GitHub does (X-Hub-Signature-256 over the body alone)
 *   ... --bad             sign with a wrong secret (the listener must answer 401)
 *   ... --repeat          send the same signed request twice (the second must be refused: a signature is good once)
 */
import { createHmac } from "node:crypto"

function fail(message: string): never {
  console.error(`webhook: ${message}`)
  process.exit(2)
}

const argv = process.argv.slice(2)
let url = ""
let body = '{"from":"the dogfood kit"}'
let github = false
let bad = false
let repeat = false
let secretFromStdin = false
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!
  if (arg === "--body") body = argv[++index] ?? fail("--body needs a value")
  else if (arg === "--github") github = true
  else if (arg === "--bad") bad = true
  else if (arg === "--repeat") repeat = true
  else if (arg === "--secret-stdin") secretFromStdin = true
  else if (arg.startsWith("-")) fail(`unknown option ${arg}`)
  else url = arg
}
if (!url) fail("usage: webhook.ts <url> [--body <text>] [--github] [--bad] [--repeat] [--secret-stdin]")

let secret = secretFromStdin ? (await Bun.stdin.text()).trim() : (process.env.WAKE_SECRET ?? "")
if (!secret) fail("no secret: set WAKE_SECRET or pass --secret-stdin")
if (bad) secret = `${secret}-wrong`

const timestamp = String(Math.floor(Date.now() / 1000))
const headers: Record<string, string> = { "Content-Type": "application/json" }
if (github) headers["X-Hub-Signature-256"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
else {
  headers["X-Wake-Timestamp"] = timestamp
  headers["X-Wake-Signature"] = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
}

for (let attempt = 0; attempt < (repeat ? 2 : 1); attempt++) {
  try {
    const response = await fetch(url, { method: "POST", headers, body })
    console.log(`${response.status} ${(await response.text()).trim()}`)
  } catch (error) {
    console.log(`no answer: ${error instanceof Error ? error.message : String(error)}`)
  }
}
