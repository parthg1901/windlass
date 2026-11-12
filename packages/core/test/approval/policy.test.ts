import { describe, expect, test } from "bun:test"
import { DEFAULT_APPROVAL, approvalSection, grant, resolveApprovalConfig } from "../../src/approval/index.ts"
import { safeDecode } from "../../src/validate.ts"

const decodeError = (value: unknown) => {
  const result = safeDecode((input, path) => approvalSection(input, path === "" ? "approval" : path), value)
  return result.ok ? null : result.error.message
}

describe("approvalSection", () => {
  test("every key optional", () => {
    expect(approvalSection({}, "approval")).toEqual({})
    expect(approvalSection({ mode: "ask", unattended: "stop", taint: "off", untrustedPaths: ["vendor/**"] }, "approval")).toEqual({
      mode: "ask",
      unattended: "stop",
      taint: "off",
      untrustedPaths: ["vendor/**"],
    })
  })

  test("rejects unknown keys, unknown values and negated globs, naming the path", () => {
    expect(decodeError({ mdoe: "ask" })).toBe('approval.mdoe: expected a known key (mode, unattended, taint, untrustedPaths), got "mdoe"')
    expect(decodeError({ mode: "yolo" })).toBe('approval.mode: expected "ask" | "auto" | "full", got "yolo"')
    expect(decodeError({ unattended: "allow" })).toBe('approval.unattended: expected "deny" | "stop", got "allow"')
    expect(decodeError({ untrustedPaths: ["!src/**"] })).toContain("approval.untrustedPaths[0]")
    expect(decodeError([])).toContain("expected object")
  })
})

describe("resolveApprovalConfig", () => {
  test("defaults: auto, deny when unattended, taint enforced", () => {
    expect(resolveApprovalConfig(null, null)).toEqual({ policy: DEFAULT_APPROVAL, ignored: [] })
    expect(DEFAULT_APPROVAL).toEqual({ mode: "auto", unattended: "deny", taint: "enforce", untrustedPaths: [] })
  })

  test("a project can tighten", () => {
    expect(resolveApprovalConfig({ mode: "full", taint: "off" }, { mode: "ask", unattended: "stop", taint: "enforce", untrustedPaths: ["b"] }).policy).toEqual({
      mode: "ask",
      unattended: "stop",
      taint: "enforce",
      untrustedPaths: ["b"],
    })
    expect(resolveApprovalConfig({ untrustedPaths: ["a", "b"] }, { untrustedPaths: ["b", "c"] }).policy.untrustedPaths).toEqual(["a", "b", "c"])
  })

  test("a project cannot loosen, and what it tried is reported", () => {
    const resolved = resolveApprovalConfig(null, { mode: "full", taint: "off" })
    expect(resolved.policy).toEqual(DEFAULT_APPROVAL)
    expect(resolved.ignored).toEqual(['mode "full" (the user\'s is "auto")', 'taint "off" (the user\'s is "enforce")'])
    expect(resolveApprovalConfig({ unattended: "stop" }, { unattended: "deny" }).policy.unattended).toBe("stop")
  })
})

describe("grant", () => {
  test("round-trips through JSON and rejects unknown rules", () => {
    const value = { scope: "session", rule: { kind: "sandbox-write", root: "/opt/cache" }, at: 12, grantedAt: 1 } as const
    expect(grant(JSON.parse(JSON.stringify(value)), "")).toEqual(value)
    expect(safeDecode(grant, { ...value, rule: { kind: "prefix", prefix: "npm" } }).ok).toBe(false)
  })
})
