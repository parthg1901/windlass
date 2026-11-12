import { describe, expect, test } from "bun:test"
import { redact } from "../../src/approval/index.ts"

// Synthetic values only, assembled at run time so the repository holds no secret-shaped literals.
const alnum = (length: number, seed = 7) => Array.from({ length }, (_, i) => "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z"[(i * seed + 3) % 31]).join("")
const upper = (length: number) => Array.from({ length }, (_, i) => "ABCDEFGHJKLMNPQRSTUVWXYZ234567"[(i * 11 + 5) % 30]).join("")
const SAMPLES = {
  "aws-access-key": `AKIA${upper(16)}`,
  "github-token": `ghp_${alnum(36)}`,
  "gitlab-token": `glpat-${alnum(20)}`,
  "slack-token": `xoxb-${alnum(12)}-${alnum(12, 5)}`,
  "stripe-key": `sk_live_${alnum(24)}`,
  "google-api-key": `AIza${alnum(35)}`,
  "npm-token": `npm_${alnum(36)}`,
  "huggingface-token": `hf_${alnum(34)}`,
  "anthropic-key": `sk-ant-api03-${alnum(40)}`,
  "openai-key": `sk-proj-${alnum(40)}`,
  jwt: `eyJ${alnum(20)}.eyJ${alnum(30, 5)}.${alnum(24, 11)}`,
} as const

describe("redact", () => {
  for (const [kind, secret] of Object.entries(SAMPLES))
    test(kind, () => {
      expect(redact(`before ${secret} after`)).toEqual({ text: `before [REDACTED:${kind}] after`, kinds: [kind as keyof typeof SAMPLES] })
    })

  test("private key blocks, terminated or cut off", () => {
    const body = Array.from({ length: 4 }, (_, i) => alnum(64, i + 3)).join("\n")
    const block = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`
    expect(redact(`key:\n${block}\ndone`).text).toBe("key:\n[REDACTED:private-key]\ndone")
    expect(redact(`key:\n-----BEGIN RSA PRIVATE KEY-----\n${body}`).text).toBe("key:\n[REDACTED:private-key]")
    expect(redact("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----").kinds).toEqual([])
  })

  test("passwords in URLs and authorization headers keep their context", () => {
    expect(redact(`postgres://app:${alnum(12)}@db:5432/x`).text).toBe("postgres://app:[REDACTED:url-password]@db:5432/x")
    expect(redact(`Authorization: Bearer ${alnum(32)}`).text).toBe("Authorization: Bearer [REDACTED:authorization]")
    expect(redact(`Authorization: Basic ${btoa(`user:${alnum(10)}`)}`).text).toBe("Authorization: Basic [REDACTED:authorization]")
  })

  test("environment values, longest first; short ones are left", () => {
    const long = `prefix-${alnum(16)}`
    const inner = long.slice(0, 12)
    expect(redact(`a=${long} b=${inner} c=shorty`, [inner, long, "shorty"]).text).toBe("a=[REDACTED:env] b=[REDACTED:env] c=shorty")
  })

  test("ordinary text and code are left alone", () => {
    const text = [
      "const apiKey = process.env.API_KEY",
      "the Bearer token-based-authentication-scheme",
      "https://example.org/path?query=1",
      "git@github.com:org/repo.git",
      "task-runner-with-a-long-hyphenated-name",
      "AKIAshort",
    ].join("\n")
    expect(redact(text)).toEqual({ text, kinds: [] })
  })

  test("a fake marker cannot hide a secret; a real marker is kept", () => {
    const secret = SAMPLES["github-token"]
    expect(redact(`[REDACTED:env:${secret}]`).text).toBe("[REDACTED:env:[REDACTED:github-token]]")
    expect(redact("[REDACTED:env] stays")).toEqual({ text: "[REDACTED:env] stays", kinds: [] })
  })

  test("idempotent and deterministic, including secrets next to each other and to markers", () => {
    const env = `envval${alnum(10)}`
    const corpus = [
      ...Object.values(SAMPLES),
      `${SAMPLES["github-token"]}${SAMPLES["aws-access-key"]}`,
      `${env}${SAMPLES["aws-access-key"]}`,
      `x${env}y${env}`,
      `Bearer ${env}`,
      `https://u:${env}@h`,
      `[REDACTED:env]${SAMPLES["npm-token"]}`,
    ]
    const random = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31)
    const next = random(42)
    const outputs = Array.from({ length: 300 }, () => {
      const separator = ["", " ", "\n", ":", "/"][Math.floor(next() * 5)]!
      return { separator, text: Array.from({ length: 1 + Math.floor(next() * 5) }, () => corpus[Math.floor(next() * corpus.length)]).join(separator) }
    })
    for (const output of outputs) {
      const once = redact(output.text, [env])
      expect(redact(once.text, [env]).text).toBe(once.text)
      expect(redact(output.text, [env])).toEqual(once)
      expect(once.text).not.toContain(env)
      // Glued together with no separator, word-boundary anchors can miss one (a stated miss).
      if (output.separator !== "") for (const secret of Object.values(SAMPLES)) expect(once.text).not.toContain(secret)
    }
  })
})
