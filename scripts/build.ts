#!/usr/bin/env bun
/**
 * Builds the command-line program into single self-contained executables.
 *
 *   bun scripts/build.ts                     the executable for this machine
 *   bun scripts/build.ts --target linux-x64  one target (repeatable)
 *   bun scripts/build.ts --all               all four: linux-x64, linux-arm64, darwin-x64, darwin-arm64
 *   bun scripts/build.ts --out <dir>         where they go (default: dist/, which git ignores)
 *   bun scripts/build.ts --bytecode          precompile to bytecode: start-up about twice as fast (0.06 s
 *                                            instead of 0.13 s for `--version` on an arm64 Linux machine),
 *                                            about 15 MB larger, and not byte-for-byte reproducible
 *
 * Without `--bytecode` the build is reproducible: the same commit and tree
 * give the same bytes (no timestamps; the stamp holds only the commit, the
 * dirty marker and the target).
 *
 * Each executable is `<out>/<binary>-<os>-<arch>` (the binary's name from
 * `brand`), and `<out>/build-info.json` lists what was built: version,
 * size, SHA-256, and whether the full-screen interface is in it. It also
 * names the binary and its aliases (`brand.aliases`): the install script
 * installs the executable under the binary's name and links each alias to it.
 *
 * How the parts of the program that are not plain code get into one file:
 * - The version: `packages/core/src/build-stamp.ts` is replaced with the
 *   commit, a dirty marker and the target, so `--version`, the protocol's
 *   `initialize` and the provider's user agent carry them.
 * - The real engine and the full-screen interface are imported by name, so
 *   they are bundled; the program starts its own ACP server child by running
 *   the executable itself with `acp` (`packages/cli/src/self.ts`).
 * - The system prompt (a text import) and the demo scenarios (modules) are
 *   bundled like code. SQLite, with its full-text search, is Bun's own.
 * - The full-screen interface needs OpenTUI's native library for the target.
 *   Bun embeds it in the executable and loads it from there, but only when the
 *   target's package (`@opentui/core-<os>-<arch>`) is installed: the
 *   workspace installs only this machine's. For a target without it, the
 *   interface is left out and `tui` says so (`packages/cli/src/tui-unavailable.ts`).
 * - Cross-compiling needs Bun's runtime for the target. Bun downloads it on
 *   first use (the official Bun release of the same version) and caches it;
 *   `--runtime <target>=<path>` uses one already on disk instead.
 * - `.env` and `bunfig.toml` in the directory the program runs in are not
 *   loaded: a project's files must not change the program.
 *
 * External programs stay external: `bwrap` and `env` for the sandbox, `git`
 * for snapshots and undo (see docs/user-guide.md for what each one costs).
 *
 * Targets are built one at a time.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { BunPlugin } from "bun"
import { brand } from "../packages/core/src/brand.ts"
import type { BuildStamp } from "../packages/core/src/build-stamp.ts"
import { versionString } from "../packages/core/src/version.ts"

export const ROOT = resolve(import.meta.dir, "..")
const ENTRY = join(ROOT, "packages/cli/src/main.ts")
const TUI_STUB = join(ROOT, "packages/cli/src/tui-unavailable.ts")
const TUI_DIR = join(ROOT, "packages/tui")

export interface Target {
  /** `<os>-<arch>` in Node's names, as `process.platform` and `process.arch` say them. */
  readonly id: "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64"
  readonly os: "linux" | "darwin"
  readonly arch: "x64" | "arm64"
  /** Bun's compile target. */
  readonly bun: Bun.Build.CompileTarget
  /** The package with OpenTUI's native library for this target. */
  readonly nativePackage: string
  readonly nativeFile: string
  /** What `file` says about a good executable for this target. */
  readonly fileFormat: RegExp
}

export const TARGETS: readonly Target[] = [
  { id: "linux-x64", os: "linux", arch: "x64", bun: "bun-linux-x64", nativePackage: "@opentui/core-linux-x64", nativeFile: "libopentui.so", fileFormat: /ELF 64-bit LSB.*x86-64/ },
  { id: "linux-arm64", os: "linux", arch: "arm64", bun: "bun-linux-arm64", nativePackage: "@opentui/core-linux-arm64", nativeFile: "libopentui.so", fileFormat: /ELF 64-bit LSB.*(aarch64|ARM aarch64)/ },
  { id: "darwin-x64", os: "darwin", arch: "x64", bun: "bun-darwin-x64", nativePackage: "@opentui/core-darwin-x64", nativeFile: "libopentui.dylib", fileFormat: /Mach-O 64-bit.*x86_64/ },
  { id: "darwin-arm64", os: "darwin", arch: "arm64", bun: "bun-darwin-arm64", nativePackage: "@opentui/core-darwin-arm64", nativeFile: "libopentui.dylib", fileFormat: /Mach-O 64-bit.*arm64/ },
]

export interface BuildArgs {
  readonly targets: readonly Target[]
  readonly outDir: string
  /** Bun runtimes already on disk, by target id, instead of the downloaded ones. */
  readonly runtimes: Readonly<Partial<Record<Target["id"], string>>>
  readonly bytecode: boolean
}

/** The target this machine is, or `null` when it is none of the four. */
export function hostTarget(platform: string = process.platform, arch: string = process.arch): Target | null {
  return TARGETS.find((target) => target.os === platform && target.arch === arch) ?? null
}

/** Pure: the command line of this script. */
export function parseBuildArgs(argv: readonly string[], host: Target | null = hostTarget()): BuildArgs | { readonly error: string } {
  const picked: Target[] = []
  const runtimes: Partial<Record<Target["id"], string>> = {}
  let outDir = join(ROOT, "dist")
  let all = false
  let bytecode = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = () => argv[++index]
    if (arg === "--all") all = true
    else if (arg === "--bytecode") bytecode = true
    else if (arg === "--target") {
      const id = value()
      const target = TARGETS.find((item) => item.id === id)
      if (target === undefined) return { error: `--target must be one of: ${TARGETS.map((item) => item.id).join(", ")}` }
      if (!picked.includes(target)) picked.push(target)
    } else if (arg === "--out") {
      const dir = value()
      if (dir === undefined || dir === "") return { error: "--out needs a directory" }
      outDir = resolve(dir)
    } else if (arg === "--runtime") {
      const spec = value() ?? ""
      const [id, path] = [spec.slice(0, spec.indexOf("=")), spec.slice(spec.indexOf("=") + 1)]
      if (!spec.includes("=") || !TARGETS.some((item) => item.id === id) || path === "") return { error: "--runtime takes <target>=<path to that target's bun executable>" }
      runtimes[id as Target["id"]] = resolve(path)
    } else return { error: `unknown option ${arg}` }
  }
  if (all && picked.length > 0) return { error: "--all and --target cannot be combined" }
  const targets = all ? TARGETS : picked.length > 0 ? picked : host === null ? [] : [host]
  if (targets.length === 0) return { error: `this machine (${process.platform}-${process.arch}) is not a target; name one with --target` }
  return { targets, outDir, runtimes, bytecode }
}

/** The executable's file name for a target. */
export const artifactName = (target: Target): string => `${brand.binary}-${target.id}`

/** Pure: the source that replaces `build-stamp.ts`. */
export function stampModule(stamp: BuildStamp): string {
  return `export const BUILD_STAMP = Object.freeze(${JSON.stringify(stamp)})\n`
}

/** The commit and whether tracked files differ from it. Untracked files do not count: they are not part of the build's inputs unless imported, and then they are reported by the build. */
export function gitState(cwd: string = ROOT): { readonly commit: string; readonly dirty: boolean } {
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
    return result.stdout.toString().trim()
  }
  return { commit: run(["rev-parse", "--short=10", "HEAD"]), dirty: run(["status", "--porcelain", "--untracked-files=no"]) !== "" }
}

/** Where the target's native OpenTUI library is installed, or `null` when it is not. */
export function nativeLibrary(target: Target, from: string = TUI_DIR): string | null {
  try {
    // The native packages are OpenTUI's optional dependencies, so they resolve from its directory.
    const core = dirname(Bun.resolveSync("@opentui/core/package.json", from))
    const entry = Bun.resolveSync(`${target.nativePackage}/package.json`, core)
    const library = join(dirname(entry), target.nativeFile)
    return existsSync(library) ? library : null
  } catch {
    return null
  }
}

/**
 * The plugin that makes one target's bundle: the stamp in place of
 * `build-stamp.ts`; without the interface, the stub in place of the TUI
 * package; with it, every other platform's native package replaced by a
 * module that fails if it is ever loaded (it cannot be resolved here, and
 * would be dead weight if it could).
 */
export function buildPlugin(stamp: BuildStamp, target: Target): BunPlugin {
  return {
    name: `${brand.directory}-build`,
    setup(build) {
      build.onLoad({ filter: /[\\/]core[\\/]src[\\/]build-stamp\.ts$/ }, () => ({ contents: stampModule(stamp), loader: "ts" }))
      if (!stamp.tui) build.onResolve({ filter: /^@light-harness\/tui$/ }, () => ({ path: TUI_STUB }))
      build.onResolve({ filter: /^@opentui\/core-(linux|darwin|win32)-/ }, (args) =>
        args.path === target.nativePackage ? undefined : { path: args.path, namespace: "absent-native" },
      )
      build.onLoad({ filter: /.*/, namespace: "absent-native" }, (args) => ({
        contents: `throw new Error(${JSON.stringify(`${args.path} is not part of this ${target.id} build`)})\n`,
        loader: "js",
      }))
    },
  }
}

export interface Built {
  readonly target: Target["id"]
  readonly file: string
  readonly bytes: number
  readonly sha256: string
  readonly version: string
  readonly tui: boolean
  /** Whether the code is precompiled to bytecode (`--bytecode`). */
  readonly bytecode: boolean
  /** Why the interface was left out, when it was. */
  readonly tuiMissing: string | null
}

export async function buildTarget(target: Target, outDir: string, git = gitState(), runtime?: string, bytecode = false): Promise<Built> {
  const library = nativeLibrary(target)
  const stamp: BuildStamp = { commit: git.commit, dirty: git.dirty, target: target.bun, tui: library !== null }
  const outfile = join(outDir, artifactName(target))
  mkdirSync(outDir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [ENTRY],
    compile: {
      target: target.bun,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      ...(runtime === undefined ? {} : { executablePath: runtime }),
    },
    minify: { syntax: true, whitespace: true },
    // Embedded in the executable, so that an error's stack and source excerpt name the real files and lines
    // instead of one minified line (about 2 MB). Bun also writes it beside the executable; that copy is removed.
    sourcemap: "linked",
    ...(bytecode ? { bytecode: true, format: "esm" as const } : {}),
    plugins: [buildPlugin(stamp, target)],
  })
  if (!result.success) throw new AggregateError(result.logs, `the ${target.id} build failed:\n${result.logs.map(String).join("\n")}`)
  rmSync(join(outDir, `${basename(ENTRY, ".ts")}.js.map`), { force: true })
  const bytes = statSync(outfile).size
  const sha256 = createHash("sha256").update(await Bun.file(outfile).bytes()).digest("hex")
  return {
    target: target.id,
    file: outfile,
    bytes,
    sha256,
    version: versionString(stamp),
    tui: stamp.tui,
    bytecode,
    tuiMissing: library === null ? `${target.nativePackage} is not installed in this workspace` : null,
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseBuildArgs(argv)
  if ("error" in args) {
    process.stderr.write(`build: ${args.error}\n`)
    return 2
  }
  const git = gitState()
  const built: Built[] = []
  for (const target of args.targets) {
    const started = performance.now()
    process.stderr.write(`build: ${target.id}…\n`)
    const item = await buildTarget(target, args.outDir, git, args.runtimes[target.id], args.bytecode)
    built.push(item)
    const mb = (item.bytes / 1024 / 1024).toFixed(1)
    process.stderr.write(
      `build: ${relative(process.cwd(), item.file)}  ${mb} MB  ${item.version}  ${item.bytecode ? "bytecode  " : ""}${item.tui ? "with the full-screen interface" : `without the full-screen interface (${item.tuiMissing})`}  ${((performance.now() - started) / 1000).toFixed(1)} s\n`,
    )
  }
  const infoPath = join(args.outDir, "build-info.json")
  const previous: Built[] = existsSync(infoPath) ? ((await Bun.file(infoPath).json()) as { builds?: Built[] }).builds ?? [] : []
  const merged = [...previous.filter((item) => !built.some((next) => next.target === item.target)), ...built].sort((a, b) => a.target.localeCompare(b.target))
  await Bun.write(infoPath, `${JSON.stringify({ binary: brand.binary, aliases: brand.aliases, builds: merged.map((item) => ({ ...item, file: basename(item.file) })) }, null, 2)}\n`)
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
