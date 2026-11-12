import { expect, test } from "bun:test"
import { brand } from "@windlass/core"
import { LOGIN_HELP, runLogin } from "../src/login.ts"

const io = () => {
  const out = { stdout: "", stderr: "" }
  return { out, io: { env: {}, stdout: { write: (text: string) => void (out.stdout += text) }, stderr: { write: (text: string) => void (out.stderr += text) }, stdin: { isTTY: false, readAll: async () => "" } } }
}

test("login --help and -h print each form with what it does, and exit 0", async () => {
  for (const argv of [["--help"], ["-h"], ["status", "--help"]]) {
    const { out, io: given } = io()
    expect(await runLogin(argv, given)).toBe(0)
    expect(out.stdout).toBe(LOGIN_HELP)
    expect(out.stderr).toBe("")
  }
  for (const form of ["login [start]", "login finish", "login status", "login logout"]) expect(LOGIN_HELP).toContain(`  ${brand.binary} ${form}`)
  expect(LOGIN_HELP).toContain("--no-browser")
  for (const row of LOGIN_HELP.split("\n")) expect(row.length).toBeLessThan(80)
})

test("an unknown login command is still a usage error", async () => {
  const { out, io: given } = io()
  expect(await runLogin(["sideways"], given)).toBe(2)
  expect(out.stderr).toContain('unknown login command "sideways"')
})
