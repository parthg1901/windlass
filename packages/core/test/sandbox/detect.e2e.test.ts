import { afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { copyFileSync, chmodSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectSandbox } from "../../src/sandbox/index.ts"
import { removeTempDirs, skipReason, tempDir } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(removeTempDirs)

test("detection is cached and cheap after the first call", () => {
  const first = detectSandbox()
  const start = performance.now()
  expect(detectSandbox()).toBe(first)
  expect(performance.now() - start).toBeLessThan(1)
})

test("darwin without sandbox-exec, and other platforms, are reported unavailable", () => {
  expect(detectSandbox({ platform: "win32" })).toMatchObject({ available: false, backend: null })
  if (!existsSync("/usr/bin/sandbox-exec")) expect(detectSandbox({ platform: "darwin" })).toMatchObject({ available: false, backend: "seatbelt" })
})

test("a bwrap path that does not exist is reported as not installed", () => {
  expect(detectSandbox({ platform: "linux", bwrapPath: "/nonexistent/bwrap", refresh: true })).toMatchObject({
    available: false,
    backend: "bwrap",
    reason: "bubblewrap (bwrap) is not installed at /nonexistent/bwrap.",
  })
})

const apparmorRestricts = existsSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") && readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1"
const restrictionSkip = skipReason ?? (apparmorRestricts ? null : "this kernel does not restrict unprivileged user namespaces through AppArmor")

test.skipIf(restrictionSkip !== null)(
  `a bwrap binary no AppArmor profile covers is diagnosed precisely${restrictionSkip ? ` (SKIPPED: ${restrictionSkip})` : ""}`,
  () => {
    // A copy of the system bwrap at a path no AppArmor profile names: exactly what an unconfigured Ubuntu 24.04 does to /usr/bin/bwrap.
    const copy = join(tempDir("detect"), "bwrap")
    copyFileSync(Bun.which("bwrap") ?? "/usr/bin/bwrap", copy)
    chmodSync(copy, 0o755)
    const result = detectSandbox({ platform: "linux", bwrapPath: copy, refresh: true })
    expect(result).toMatchObject({ available: false, backend: "bwrap" })
    if (result.available) return
    expect(result.reason).toContain("kernel.apparmor_restrict_unprivileged_userns=1")
    expect(result.remedy).toContain(`profile bwrap ${copy} flags=(unconfined) { userns, }`)
    expect(result.detail).toMatch(/uid map|RTM_NEWADDR|Permission denied|Operation not permitted/)
  },
)
