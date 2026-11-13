/**
 * The npm packages (`scripts/npm.ts`) and the launcher they install
 * (`npm/launcher.mjs`). The builds are small synthetic files with
 * hand-written records; for the launcher the executable is a shell script
 * that reports what it was given, so the launcher runs here on Node and on
 * Bun without a real build.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import workspace from "../../package.json" with { type: "json" }
import { brand } from "../../packages/core/src/brand.ts"
import { E2E_TIMEOUT_MS } from "../../packages/core/src/testing/wait.ts"
import { TARGETS, hostTarget, type Target } from "../../scripts/build.ts"
import { CHECKSUMS } from "../../scripts/release.ts"
import {
  LAUNCHER,
  NODE_ENGINE,
  checkPack,
  expectedFiles,
  mainManifest,
  npmPack,
  packLine,
  parseNpmArgs,
  platformManifest,
  platformPackageName,
  stagePackages,
  type PackReport,
  type StagedPackage,
} from "../../scripts/npm.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)

const scratch = mkdtempSync(join(tmpdir(), "release-npm-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0
const fresh = (name: string) => {
  const dir = join(scratch, `${name}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const VERSION = "1.2.3"
const COMMIT = "abcdef0123"

/** Stands in for the executable: reports its arguments, input and environment, exits as told, or waits for a signal. */
const FAKE = `#!/bin/sh
case "$1" in
  args) shift; for arg in "$@"; do printf '[%s]\\n' "$arg"; done ;;
  exit) exit "$2" ;;
  stdin) cat ;;
  env) printf '%s\\n' "$PROBE" ;;
  trap) trap 'echo "got $2"; exit 42' "$2"; echo ready; i=0; while [ $i -lt 60 ]; do sleep 1 & wait $!; i=$((i + 1)); done; exit 1 ;;
  die) echo ready; kill -"$2" $$ ;;
esac
`

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")

/** A builds directory as `bun scripts/build.ts` leaves it, for the given targets. */
function builds(targets: readonly Target[] = TARGETS, edit: (build: Record<string, unknown>) => void = () => {}): string {
  const dir = fresh("builds")
  const records = targets.map((target) => {
    const file = `${brand.binary}-${target.id}`
    writeFileSync(join(dir, file), FAKE)
    chmodSync(join(dir, file), 0o755)
    const build: Record<string, unknown> = { target: target.id, file, bytes: FAKE.length, sha256: sha256(FAKE), version: `${VERSION}+${COMMIT}`, tui: true, bytecode: false, tuiMissing: null }
    edit(build)
    return build
  })
  writeFileSync(join(dir, "build-info.json"), JSON.stringify({ binary: brand.binary, aliases: brand.aliases, builds: records }))
  return dir
}

const stage = (dir: string, options: { partial?: boolean } = {}) => stagePackages(dir, fresh("staged"), { version: VERSION, commit: COMMIT, ...options })

describe("the package manifests", () => {
  test("the main package: the brand's npm name, the binary first in bin, then each alias, all the launcher", () => {
    const manifest = mainManifest(VERSION) as { name: string; version: string; bin: Record<string, string>; engines: { node: string }; files: string[] }
    expect(manifest.name).toBe(brand.npmPackage)
    expect(manifest.version).toBe(VERSION)
    expect(Object.keys(manifest.bin)).toEqual([brand.binary, ...brand.aliases])
    expect(new Set(Object.values(manifest.bin))).toEqual(new Set([LAUNCHER]))
    expect(manifest.engines.node).toBe(NODE_ENGINE)
    expect(manifest.files).toEqual([LAUNCHER])
    expect(JSON.stringify(manifest)).toContain(`github.com/${brand.repository}`)
  })

  test("it depends, optionally, on every target's package at exactly its own version", () => {
    const manifest = mainManifest(VERSION) as { optionalDependencies: Record<string, string>; dependencies?: unknown; os?: unknown }
    expect(manifest.optionalDependencies).toEqual(Object.fromEntries(TARGETS.map((target) => [`${brand.npmPackage}-${target.id}`, VERSION])))
    expect(manifest.dependencies).toBeUndefined()
    // Installable everywhere, so that on another platform the launcher, not npm, says what is missing.
    expect(manifest.os).toBeUndefined()
  })

  test("each platform package is for its own os and cpu, Linux's for glibc, with no bin of its own", () => {
    for (const target of TARGETS) {
      const manifest = platformManifest(target, VERSION) as { name: string; version: string; os: string[]; cpu: string[]; libc?: string[]; bin?: unknown; repository: { url: string } }
      expect(manifest.name).toBe(platformPackageName(target))
      expect(manifest.version).toBe(VERSION)
      expect(manifest.os).toEqual([target.os])
      expect(manifest.cpu).toEqual([target.arch])
      expect(manifest.libc).toEqual(target.os === "linux" ? ["glibc"] : undefined)
      expect(manifest.bin).toBeUndefined()
      // Provenance needs the repository to be the one the workflow runs in.
      expect(manifest.repository.url).toBe(`git+https://github.com/${brand.repository}.git`)
    }
  })
})

describe("staging", () => {
  test("all four builds give five packages, the platform packages first, with the executable in bin/", () => {
    const staging = stage(builds())
    expect(staging.problems).toEqual([])
    expect(staging.packages.map((pkg) => pkg.name)).toEqual([...TARGETS.map(platformPackageName), brand.npmPackage])
    for (const pkg of staging.packages) {
      const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8")) as { version: string }
      expect(manifest.version).toBe(VERSION)
      if (pkg.kind === "platform") expect(readFileSync(join(pkg.dir, "bin", brand.binary), "utf8")).toBe(FAKE)
      else expect(readFileSync(join(pkg.dir, LAUNCHER), "utf8")).toContain("optionalDependencies")
    }
  })

  test("each thing that stops it is named", () => {
    const [first, ...rest] = TARGETS
    expect(stage(builds(rest)).problems).toEqual([`no build of ${first!.id}`])
    expect(stage(builds(TARGETS, (build) => build.target === "linux-x64" && (build.sha256 = "0".repeat(64)))).problems).toEqual([expect.stringContaining("linux-x64: ")])
    expect(stage(builds(TARGETS, (build) => build.target === "darwin-x64" && (build.tui = false))).problems).toEqual([expect.stringContaining("darwin-x64: built without the full-screen interface")])
    expect(stage(builds(TARGETS, (build) => build.target === "linux-arm64" && (build.version = `9.9.9+${COMMIT}`))).problems).toEqual([`linux-arm64: version 9.9.9+${COMMIT} is not ${VERSION}`])
    expect(stage(builds(TARGETS, (build) => build.target === "darwin-arm64" && (build.version = `${VERSION}+${COMMIT}.dirty`))).problems).toEqual([expect.stringContaining("darwin-arm64: built from a tree with uncommitted changes")])
    expect(stage(builds(TARGETS, (build) => build.target === "linux-x64" && (build.version = `${VERSION}+1111111111`))).problems).toEqual([`linux-x64: built from commit 1111111111, not this checkout's ${COMMIT}`])
    expect(stage(join(scratch, "nowhere")).problems).toEqual([expect.stringContaining("does not exist")])
  })

  test("a release's SHA256SUMS is checked too", () => {
    const dir = builds()
    const lines = TARGETS.map((target) => `${sha256(FAKE)}  ${brand.binary}-${target.id}\n`)
    writeFileSync(join(dir, CHECKSUMS), lines.join(""))
    expect(stage(dir).problems).toEqual([])
    writeFileSync(join(dir, CHECKSUMS), lines.slice(1).join("") + `${"1".repeat(64)}  ${brand.binary}-${TARGETS[0]!.id}\n`)
    expect(stage(dir).problems).toEqual([`${TARGETS[0]!.id}: ${brand.binary}-${TARGETS[0]!.id} does not match ${CHECKSUMS}`])
    writeFileSync(join(dir, CHECKSUMS), lines.slice(1).join(""))
    expect(stage(dir).problems).toEqual([`${TARGETS[0]!.id}: ${brand.binary}-${TARGETS[0]!.id} is not in ${CHECKSUMS}`])
  })

  test("--partial stages the targets that are there, with the main package still naming all four", () => {
    const staging = stage(builds([TARGETS[1]!]), { partial: true })
    expect(staging.problems).toEqual([])
    expect(staging.packages.map((pkg) => pkg.name)).toEqual([platformPackageName(TARGETS[1]!), brand.npmPackage])
    const main = JSON.parse(readFileSync(join(staging.packages[1]!.dir, "package.json"), "utf8")) as { optionalDependencies: object }
    expect(Object.keys(main.optionalDependencies)).toHaveLength(TARGETS.length)
  })

  test("the root package.json's version is the default", () => {
    const staging = stagePackages(builds(TARGETS, (build) => (build.version = `${workspace.version}+${COMMIT}`)), fresh("staged"), { commit: COMMIT })
    expect(staging.problems).toEqual([])
    expect(staging.version).toBe(workspace.version)
  })
})

describe("npm pack", () => {
  const report = (pkg: StagedPackage, files: { path: string; mode?: number }[], size = 1000, unpackedSize = 2 * 1024 * 1024): PackReport => ({
    name: pkg.name,
    version: VERSION,
    files: files.map((file) => ({ path: file.path, size: 10, mode: file.mode ?? 0o644 })),
    size,
    unpackedSize,
    filename: `${pkg.name}-${VERSION}.tgz`,
  })
  const main: StagedPackage = { name: brand.npmPackage, kind: "main", dir: "", target: null }
  const platform: StagedPackage = { name: platformPackageName(TARGETS[0]!), kind: "platform", dir: "", target: TARGETS[0]!.id }

  test("exactly the expected files, the program executable, and sizes within bounds", () => {
    const files = (kind: "main" | "platform") => expectedFiles(kind).map((path) => ({ path, mode: path === LAUNCHER || path.startsWith("bin/") ? 0o755 : 0o644 }))
    expect(checkPack(main, report(main, files("main"), 3000, 8000), VERSION)).toEqual([])
    expect(checkPack(platform, report(platform, files("platform"), 40e6, 95e6), VERSION)).toEqual([])
    expect(checkPack(platform, report(platform, [...files("platform"), { path: "test.db" }]), VERSION)).toEqual([expect.stringContaining("it should hold exactly")])
    expect(checkPack(platform, report(platform, expectedFiles("platform").map((path) => ({ path })), 40e6, 95e6), VERSION)).toEqual([expect.stringContaining("is not executable in the tarball")])
    expect(checkPack(main, report(main, files("main"), 1e6, 2e6), VERSION)).toHaveLength(2)
    expect(checkPack(platform, report(platform, files("platform"), 1000, 2000), VERSION)).toEqual([expect.stringContaining("an executable is tens of megabytes")])
    expect(checkPack(platform, { ...report(platform, files("platform")), version: "0.0.1" }, VERSION)).toEqual([`${platform.name}: npm packs version 0.0.1, not ${VERSION}`])
  })

  test("npm itself packs the staged packages as checked (only the synthetic executable's size is off)", () => {
    const staging = stage(builds([TARGETS[0]!]), { partial: true })
    for (const pkg of staging.packages) {
      const packed = npmPack(pkg)
      expect(packLine(packed)).toContain(`${pkg.name}@${VERSION}`)
      const problems = checkPack(pkg, packed, VERSION)
      if (pkg.kind === "main") expect(problems).toEqual([])
      else expect(problems).toEqual([expect.stringContaining("an executable is tens of megabytes")])
    }
  }, 60_000)
})

describe("the command line", () => {
  test("stage and publish, with their options", () => {
    expect(parseNpmArgs(["stage", "dist", "--pack", "out", "--partial"])).toMatchObject({ command: "stage", partial: true, provenance: false })
    expect(parseNpmArgs(["publish", "release", "--provenance", "--otp", "123456"])).toMatchObject({ command: "publish", provenance: true, otp: "123456", partial: false })
    expect(parseNpmArgs(["publish", "release", "--partial"])).toEqual({ error: "unknown option --partial for publish" })
    expect(parseNpmArgs(["stage", "release", "--provenance"])).toEqual({ error: "unknown option --provenance for stage" })
    expect(parseNpmArgs(["stage"])).toEqual({ error: "stage takes one directory of builds" })
    expect(parseNpmArgs(["publish", "x", "--otp"])).toEqual({ error: "--otp needs a value" })
    expect(parseNpmArgs(["pack"])).toHaveProperty("error")
  })
})

const host = hostTarget()
const node = Bun.which("node")
const runtimes = [["bun", process.execPath], ...(node === null ? [] : [["node", node]])] as const

/** The two packages installed side by side, as npm installs them: `<root>/node_modules/<name>`. */
function installed(): { readonly root: string; readonly launcher: string; readonly main: string; readonly platform: string } {
  const staging = stage(builds([host!]), { partial: true })
  const root = fresh("installed")
  mkdirSync(join(root, "node_modules"))
  const [platform, main] = staging.packages.map((pkg) => {
    const to = join(root, "node_modules", pkg.name)
    renameSync(pkg.dir, to)
    return to
  })
  return { root, launcher: join(main!, LAUNCHER), main: main!, platform: platform! }
}

/** Reads a stream as it comes: `until` waits for a text (so a signal is sent only once the executable is ready for it), `rest` reads to the end. */
function reading(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  const more = async () => {
    const { value, done } = await reader.read()
    if (!done) seen += decoder.decode(value, { stream: true })
    return !done
  }
  return {
    until: async (text: string) => {
      while (!seen.includes(text) && (await more()));
      return seen
    },
    rest: async () => {
      while (await more());
      return seen
    },
  }
}

describe.skipIf(host === null)("the launcher", () => {
  for (const [runtime, path] of runtimes) {
    describe(`on ${runtime}`, () => {
      const run = (launcher: string, args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) =>
        Bun.spawnSync([path, launcher, ...args], { stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...options.env } })

      test("runs this machine's executable with the arguments, input and environment, and exits with its code", () => {
        const { launcher } = installed()
        const args = run(launcher, ["args", "two words", "", "--flag", "ü"])
        expect(args.exitCode).toBe(0)
        expect(args.stdout.toString()).toBe("[two words]\n[]\n[--flag]\n[ü]\n")
        expect(run(launcher, ["stdin"], { stdin: "piped in\n" }).stdout.toString()).toBe("piped in\n")
        expect(run(launcher, ["env"], { env: { PROBE: "from the caller" } }).stdout.toString()).toBe("from the caller\n")
        for (const code of [0, 1, 2, 3, 130, 143]) expect(run(launcher, ["exit", String(code)]).exitCode).toBe(code)
      }, 30_000)

      test("passes SIGTERM, SIGHUP and (with no terminal) SIGINT on, and exits as the executable did", async () => {
        const { launcher } = installed()
        for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
          const proc = Bun.spawn([path, launcher, "trap", signal.slice(3)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
          const out = reading(proc.stdout)
          expect(await out.until("ready")).toContain("ready")
          proc.kill(signal)
          expect(await proc.exited, signal).toBe(42)
          expect(await out.rest(), signal).toContain(`got ${signal.slice(3)}`)
        }
      }, 30_000)

      test("an executable ended by a signal ends the launcher by the same signal", async () => {
        const { launcher } = installed()
        const proc = Bun.spawn([path, launcher, "die", "TERM"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        await proc.exited
        expect(proc.signalCode).toBe("SIGTERM")
      }, 30_000)

      test("names the missing platform package when optional dependencies were left out", () => {
        const { launcher, platform } = installed()
        rmSync(platform, { recursive: true })
        const result = run(launcher, ["--version"])
        expect(result.exitCode).toBe(1)
        const said = result.stderr.toString()
        expect(said).toContain(`${brand.npmPackage}-${host!.id}, the package with the executable for this machine (${host!.id}), is not installed`)
        expect(said).toContain("--omit=optional")
        expect(said).toContain(`npm install -g ${brand.npmPackage}`)
        expect(said.startsWith(`${brand.binary}: `)).toBe(true)
      }, 30_000)

      test("says so on a platform with no package, and when the two versions differ", () => {
        const { launcher, main, platform } = installed()
        const manifestPath = join(main, "package.json")
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { optionalDependencies: Record<string, string> }
        delete manifest.optionalDependencies[`${brand.npmPackage}-${host!.id}`]
        writeFileSync(manifestPath, JSON.stringify(manifest))
        const unsupported = run(launcher, ["--version"])
        expect(unsupported.exitCode).toBe(1)
        expect(unsupported.stderr.toString()).toContain(`there is no executable for this machine (${host!.id})`)

        const other = installed()
        const platformManifestPath = join(other.platform, "package.json")
        writeFileSync(platformManifestPath, JSON.stringify({ ...JSON.parse(readFileSync(platformManifestPath, "utf8")), version: "0.0.1" }))
        const mismatch = run(other.launcher, ["--version"])
        expect(mismatch.exitCode).toBe(1)
        expect(mismatch.stderr.toString()).toContain(`is version 0.0.1, but ${brand.npmPackage} is version ${VERSION}`)
        expect(platform).not.toBe(other.platform)
      }, 30_000)
    })
  }
})
