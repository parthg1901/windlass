/** The build script's pure parts and the version string. Nothing here builds: see `binary.test.ts` for the executable. */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import workspace from "../../package.json" with { type: "json" }
import { brand } from "../../packages/core/src/brand.ts"
import { platformString, userAgent, versionLine, versionString } from "../../packages/core/src/version.ts"
import { selfCommand } from "../../packages/cli/src/self.ts"
import { ROOT, TARGETS, artifactName, buildPlugin, gitState, hostTarget, nativeLibrary, parseBuildArgs, stampModule } from "../../scripts/build.ts"

const stamp = { commit: "0123456789", dirty: false, target: "bun-linux-x64", tui: true } as const

describe("the version", () => {
  test("from source, and stamped by a build, clean or dirty", () => {
    expect(versionString(null)).toBe(`${workspace.version}+source`)
    expect(versionString(stamp, "1.2.3")).toBe("1.2.3+0123456789")
    expect(versionString({ ...stamp, dirty: true }, "1.2.3")).toBe("1.2.3+0123456789.dirty")
  })

  test("--version names the product, the version and the platform, and says when the interface is left out", () => {
    expect(versionLine(null)).toBe(`${brand.name} ${workspace.version}+source (${process.platform}-${process.arch})`)
    expect(versionLine({ ...stamp, tui: false })).toBe(`${brand.name} ${workspace.version}+0123456789 (${platformString()}, without the full-screen interface)`)
  })

  test("the provider's user agent carries the same version", () => {
    expect(userAgent()).toBe(`${brand.name}/${versionString()} (${process.platform}; ${process.arch})`)
  })

  test("from source the program starts its server child as Bun running main.ts", () => {
    const command = selfCommand(["acp"])
    expect(command[0]).toBe(process.execPath)
    expect(command[1]).toEndWith("packages/cli/src/main.ts")
    expect(command.slice(2)).toEqual(["acp"])
  })
})

describe("the build script", () => {
  test("four targets, named from the brand", () => {
    expect(TARGETS.map((target) => target.id)).toEqual(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"])
    expect(TARGETS.map(artifactName)).toEqual(TARGETS.map((target) => `${brand.binary}-${target.id}`))
    expect(hostTarget("linux", "arm64")?.id).toBe("linux-arm64")
    expect(hostTarget("darwin", "x64")?.bun).toBe("bun-darwin-x64")
    expect(hostTarget("win32", "x64")).toBeNull()
  })

  test("arguments", () => {
    const host = hostTarget("linux", "x64")
    expect(parseBuildArgs([], host)).toMatchObject({ targets: [host], outDir: `${ROOT}/dist`, bytecode: false })
    expect(parseBuildArgs(["--all"], host)).toMatchObject({ targets: TARGETS })
    expect(parseBuildArgs(["--target", "darwin-arm64", "--target", "darwin-arm64", "--bytecode"], host)).toMatchObject({ targets: [TARGETS[3]], bytecode: true })
    expect(parseBuildArgs(["--out", "/tmp/out", "--runtime", "darwin-x64=/opt/bun-darwin-x64"], host)).toMatchObject({ outDir: "/tmp/out", runtimes: { "darwin-x64": "/opt/bun-darwin-x64" } })
    expect(parseBuildArgs(["--target", "windows-x64"], host)).toEqual({ error: "--target must be one of: linux-x64, linux-arm64, darwin-x64, darwin-arm64" })
    expect(parseBuildArgs(["--all", "--target", "linux-x64"], host)).toEqual({ error: "--all and --target cannot be combined" })
    expect(parseBuildArgs(["--runtime", "linux-x64"], host)).toMatchObject({ error: expect.stringContaining("--runtime takes") })
    expect(parseBuildArgs([], null)).toMatchObject({ error: expect.stringContaining("name one with --target") })
    expect(parseBuildArgs(["--fast"], host)).toEqual({ error: "unknown option --fast" })
  })

  test("the stamp module is what the program reads", async () => {
    const source = stampModule(stamp)
    const file = join(mkdtempSync(join(tmpdir(), "release-stamp-")), "build-stamp.ts")
    await Bun.write(file, source)
    const module = await import(file)
    expect(module.BUILD_STAMP).toEqual(stamp)
    expect(Object.isFrozen(module.BUILD_STAMP)).toBe(true)
  })

  test("what `file` says about each target's executable", () => {
    const samples: Record<string, string> = {
      "linux-x64": "ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked",
      "linux-arm64": "ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), dynamically linked",
      "darwin-x64": "Mach-O 64-bit x86_64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|PIE>",
      "darwin-arm64": "Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|PIE>",
    }
    for (const target of TARGETS) for (const [id, sample] of Object.entries(samples)) expect(target.fileFormat.test(sample), `${target.id} vs ${id}`).toBe(target.id === id)
  })

  test("the native library is found for this machine only when its package is installed", () => {
    const host = hostTarget()
    for (const target of TARGETS) {
      const library = nativeLibrary(target)
      if (library !== null) expect(library).toEndWith(target.nativeFile)
      if (target !== host) continue
      // The workspace's install always has this machine's package (it is how the TUI runs from source).
      expect(library).not.toBeNull()
    }
  })

  test("the plugin swaps the stamp in, and the interface out when the native library is absent", async () => {
    const resolved: Record<string, unknown> = {}
    const loads: { filter: RegExp; namespace?: string; load: (args: { path: string }) => unknown }[] = []
    const capture = (tui: boolean) => {
      buildPlugin({ ...stamp, tui }, TARGETS[0]!).setup({
        onLoad: (options: { filter: RegExp; namespace?: string }, load: (args: { path: string }) => unknown) => void loads.push({ ...options, load }),
        onResolve: (options: { filter: RegExp }, resolve: (args: { path: string }) => unknown) => {
          for (const path of ["@light-harness/tui", "@opentui/core-linux-x64", "@opentui/core-darwin-arm64"]) if (options.filter.test(path)) resolved[`${tui}:${path}`] = resolve({ path })
        },
      } as never)
    }
    capture(true)
    capture(false)
    expect(resolved["true:@light-harness/tui"]).toBeUndefined()
    expect(resolved["false:@light-harness/tui"]).toEqual({ path: `${ROOT}/packages/cli/src/tui-unavailable.ts` })
    expect(resolved["true:@opentui/core-linux-x64"]).toBeUndefined()
    expect(resolved["true:@opentui/core-darwin-arm64"]).toEqual({ path: "@opentui/core-darwin-arm64", namespace: "absent-native" })
    const stampLoad = loads.find((item) => item.filter.test("/x/packages/core/src/build-stamp.ts"))
    expect(stampLoad?.load({ path: "" })).toEqual({ contents: stampModule({ ...stamp, tui: true }), loader: "ts" })
  })

  test("git state: a commit and a dirty flag", () => {
    const state = gitState()
    expect(state.commit).toMatch(/^[0-9a-f]{10}$/)
    expect(typeof state.dirty).toBe("boolean")
  })
})
