#!/usr/bin/env bun
/**
 * The npm packages: one main package, `brand.npmPackage`, whose `bin` (the
 * binary and each alias) is `npm/launcher.mjs`, and one package per target,
 * `<main>-<os>-<arch>`, with that target's executable in `bin/<binary>` and
 * `os`, `cpu` (and on Linux `libc`) set, so that npm installs only this
 * machine's. The main package lists all four as `optionalDependencies` of
 * exactly its own version, and the launcher runs the one npm installed.
 * Every package's names and version come from here: `brand` and the root
 * package.json.
 *
 *   bun scripts/npm.ts stage <builds> [--out <dir>] [--pack <dir>] [--partial]
 *       <builds> is a directory with the executables and their build-info.json:
 *       `dist/` after `bun scripts/build.ts`, a release's files (the
 *       `release-<version>-dry-run` artifact, or a GitHub release's downloads),
 *       or the build artifacts the workflow downloads, one directory each.
 *       Checks each executable against its record (SHA-256, the package.json
 *       version, one clean commit that is this checkout's, the full-screen
 *       interface) and against SHA256SUMS when there is one, writes the five
 *       packages to <out>/<package> (default: dist/npm), and checks each with
 *       `npm pack --dry-run`: exactly the files it should have, the executable
 *       executable, and a size within bounds. --pack also writes the five
 *       tarballs to <dir>. --partial stages the targets that are there instead
 *       of failing on the missing ones (for trying it on one machine; never for
 *       publishing).
 *
 *   bun scripts/npm.ts publish <builds> [--out <dir>] [--provenance] [--otp <code>]
 *       The same staging and checks for all four targets, then `npm publish` of
 *       each package, the four platform packages first and the main package
 *       last (so that nobody installs a main package whose executables are not
 *       there yet), skipping any whose version is already on the registry.
 *       --provenance is for the release workflow (trusted publishing); by hand
 *       you publish with your own `npm login`, and npm asks for a one-time
 *       password when your account needs one, or takes --otp.
 *
 * Failures are `::error::` annotations in GitHub Actions.
 */
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { ROOT, TARGETS, gitState, type Target } from "./build.ts"
import { CHECKSUMS, buildRecords } from "./release.ts"

export const LAUNCHER = "launcher.mjs"
/** The oldest Node the launcher runs on: the main package's `engines`. */
export const NODE_ENGINE = ">=18"
/** Bounds on what `npm pack` reports, in bytes: the launcher package is a few kilobytes, an executable about 100 MB. */
export const SIZE_LIMITS = { main: { packed: 64 * 1024, unpacked: 256 * 1024 }, platform: { packed: 100 * 1024 * 1024, unpacked: 250 * 1024 * 1024 } } as const

const OS_NAMES = { linux: "Linux", darwin: "macOS" } as const

export const platformPackageName = (target: Target): string => `${brand.npmPackage}-${target.id}`

const repository = { type: "git", url: `git+https://github.com/${brand.repository}.git` }
const common = (version: string) => ({
  version,
  license: "MIT",
  repository,
  homepage: `https://github.com/${brand.repository}#readme`,
  bugs: { url: `https://github.com/${brand.repository}/issues` },
})

/** Pure: the main package's package.json. The binary is the first `bin` entry: the launcher reads its name from there. */
export function mainManifest(version: string): Record<string, unknown> {
  return {
    name: brand.npmPackage,
    description: `${brand.name}: a coding agent for the terminal that signs in with a ChatGPT plan`,
    keywords: ["coding-agent", "agent", "cli", "terminal", "chatgpt", "acp"],
    ...common(version),
    bin: Object.fromEntries([brand.binary, ...brand.aliases].map((name) => [name, LAUNCHER])),
    files: [LAUNCHER],
    engines: { node: NODE_ENGINE },
    optionalDependencies: Object.fromEntries(TARGETS.map((target) => [platformPackageName(target), version])),
  }
}

/** Pure: a platform package's package.json. */
export function platformManifest(target: Target, version: string): Record<string, unknown> {
  return {
    name: platformPackageName(target),
    description: `The ${OS_NAMES[target.os]} ${target.arch} executable of ${brand.npmPackage}; install that package instead`,
    ...common(version),
    os: [target.os],
    cpu: [target.arch],
    // Bun's Linux executables are linked against glibc.
    ...(target.os === "linux" ? { libc: ["glibc"] } : {}),
    files: ["bin/"],
    preferUnplugged: true,
  }
}

/** Pure: the README of a platform package. */
export function platformReadme(target: Target): string {
  return `# ${platformPackageName(target)}

The ${OS_NAMES[target.os]} ${target.arch} executable of [${brand.npmPackage}](https://www.npmjs.com/package/${brand.npmPackage}),
${brand.name}'s npm package. Do not install this package yourself: \`npm install -g ${brand.npmPackage}\` installs the
executable for your machine with it.
`
}

/** The files each package's tarball must hold, and nothing else. */
export function expectedFiles(kind: "main" | "platform"): readonly string[] {
  return (kind === "main" ? ["LICENSE", "README.md", LAUNCHER, "package.json"] : ["LICENSE", "README.md", `bin/${brand.binary}`, "package.json"]).sort()
}

export interface StagedPackage {
  readonly name: string
  readonly kind: "main" | "platform"
  readonly dir: string
  readonly target: Target["id"] | null
}

export interface Staging {
  readonly version: string
  /** The platform packages first, the main package last: the order they are published in. */
  readonly packages: readonly StagedPackage[]
  readonly problems: readonly string[]
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

/** The lines of a SHA256SUMS file, by file name. */
function checksums(path: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (match) sums.set(match[2]!, match[1]!)
  }
  return sums
}

export interface StageOptions {
  readonly version?: string
  /** The commit every build must come from (default: this checkout's HEAD); `null` skips the check. */
  readonly commit?: string | null
  readonly partial?: boolean
  readonly root?: string
}

/** Writes the five packages (or, with `partial`, those whose builds are there) into `outDir`. */
export function stagePackages(buildsDir: string, outDir: string, options: StageOptions = {}): Staging {
  const root = options.root ?? ROOT
  const version = options.version ?? (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version
  const commit = options.commit === undefined ? gitState(root).commit : options.commit
  const problems: string[] = []
  if (!existsSync(buildsDir)) return { version, packages: [], problems: [`${buildsDir} does not exist`] }
  const records = buildRecords(buildsDir)
  const sums = existsSync(join(buildsDir, CHECKSUMS)) ? checksums(join(buildsDir, CHECKSUMS)) : null
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const license = join(root, "LICENSE")
  const packages: StagedPackage[] = []
  for (const target of TARGETS) {
    const found = records.flatMap((record) => record.builds.filter((build) => build.target === target.id).map((build) => ({ record, build })))
    if (found.length === 0) {
      if (!options.partial) problems.push(`no build of ${target.id}`)
      continue
    }
    if (found.length > 1) problems.push(`${found.length} builds of ${target.id}`)
    const { record, build } = found[0]!
    const source = join(record.dir, build.file)
    const before = problems.length
    if (!existsSync(source)) {
      problems.push(`${target.id}: its build-info.json names ${build.file}, which is not there`)
      continue
    }
    const actual = sha256(source)
    if (actual !== build.sha256) problems.push(`${target.id}: ${build.file} is not the file its build recorded (SHA-256 differs)`)
    if (sums !== null && sums.get(build.file) !== actual) problems.push(`${target.id}: ${build.file} ${sums.has(build.file) ? "does not match" : "is not in"} ${CHECKSUMS}`)
    if (!build.tui) problems.push(`${target.id}: built without the full-screen interface (${build.tuiMissing ?? "no reason recorded"})`)
    // `<version>+<commit>[.dirty]`
    const [base, stamp = ""] = build.version.split("+")
    if (base !== version) problems.push(`${target.id}: version ${build.version} is not ${version}`)
    if (stamp.endsWith(".dirty")) problems.push(`${target.id}: built from a tree with uncommitted changes (${build.version})`)
    if (commit !== null && stamp.replace(/\.dirty$/, "") !== commit) problems.push(`${target.id}: built from commit ${stamp.replace(/\.dirty$/, "")}, not this checkout's ${commit}`)
    if (problems.length > before) continue
    const dir = join(outDir, platformPackageName(target))
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(platformManifest(target, version), null, 2)}\n`)
    writeFileSync(join(dir, "README.md"), platformReadme(target))
    copyFileSync(license, join(dir, "LICENSE"))
    copyFileSync(source, join(dir, "bin", brand.binary))
    chmodSync(join(dir, "bin", brand.binary), 0o755)
    packages.push({ name: platformPackageName(target), kind: "platform", dir, target: target.id })
  }
  const main = join(outDir, brand.npmPackage)
  mkdirSync(main, { recursive: true })
  writeFileSync(join(main, "package.json"), `${JSON.stringify(mainManifest(version), null, 2)}\n`)
  copyFileSync(join(root, "npm", "README.md"), join(main, "README.md"))
  copyFileSync(join(root, "npm", LAUNCHER), join(main, LAUNCHER))
  chmodSync(join(main, LAUNCHER), 0o755)
  copyFileSync(license, join(main, "LICENSE"))
  packages.push({ name: brand.npmPackage, kind: "main", dir: main, target: null })
  return { version, packages, problems }
}

export interface PackReport {
  readonly name: string
  readonly version: string
  readonly files: readonly { readonly path: string; readonly size: number; readonly mode: number }[]
  readonly size: number
  readonly unpackedSize: number
  readonly filename: string
}

/** Pure: what is wrong with what `npm pack` reports for a staged package. */
export function checkPack(pkg: StagedPackage, report: PackReport, version: string): string[] {
  const problems: string[] = []
  if (report.name !== pkg.name) problems.push(`${pkg.name}: npm packs it as ${report.name}`)
  if (report.version !== version) problems.push(`${pkg.name}: npm packs version ${report.version}, not ${version}`)
  const paths = report.files.map((file) => file.path).sort()
  const expected = expectedFiles(pkg.kind)
  if (JSON.stringify(paths) !== JSON.stringify(expected)) problems.push(`${pkg.name}: the tarball holds ${paths.join(", ")}; it should hold exactly ${expected.join(", ")}`)
  const program = report.files.find((file) => file.path === (pkg.kind === "main" ? LAUNCHER : `bin/${brand.binary}`))
  if (program !== undefined && (program.mode & 0o111) === 0) problems.push(`${pkg.name}: ${program.path} is not executable in the tarball (mode ${program.mode.toString(8)})`)
  const limits = SIZE_LIMITS[pkg.kind]
  if (report.size > limits.packed) problems.push(`${pkg.name}: the tarball is ${report.size} bytes, more than ${limits.packed}`)
  if (report.unpackedSize > limits.unpacked) problems.push(`${pkg.name}: unpacked it is ${report.unpackedSize} bytes, more than ${limits.unpacked}`)
  if (pkg.kind === "platform" && report.unpackedSize < 1024 * 1024) problems.push(`${pkg.name}: unpacked it is only ${report.unpackedSize} bytes; an executable is tens of megabytes`)
  return problems
}

/** `npm pack --dry-run --json` (or, with `destination`, the real pack into it) in a staged package's directory. */
export function npmPack(pkg: StagedPackage, destination?: string): PackReport {
  const args = ["npm", "pack", "--json", ...(destination === undefined ? ["--dry-run"] : ["--pack-destination", destination])]
  const result = Bun.spawnSync(args, { cwd: pkg.dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" } })
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")} in ${pkg.dir} failed: ${result.stderr.toString().trim()}`)
  const [report] = JSON.parse(result.stdout.toString()) as PackReport[]
  return report!
}

/** A path as given relative to here when it is under here, else in full. */
const shown = (path: string) => {
  const from = relative(process.cwd(), path)
  return from === "" ? "." : from.startsWith("..") ? path : from
}

const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} kB`)

/** Pure: one line saying what a package's tarball holds. */
export const packLine = (report: PackReport): string =>
  `${report.name}@${report.version}  ${mb(report.size)} packed, ${mb(report.unpackedSize)} unpacked  ${report.files.map((file) => file.path).join(", ")}`

/** Whether `name@version` is on the registry already. */
export function published(name: string, version: string): boolean {
  const result = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_update_notifier: "false" } })
  return result.exitCode === 0 && result.stdout.toString().trim() === version
}

interface Args {
  readonly command: "stage" | "publish"
  readonly builds: string
  readonly out: string
  readonly pack: string | null
  readonly partial: boolean
  readonly provenance: boolean
  readonly otp: string | null
}

/** Pure: this script's command line. */
export function parseNpmArgs(argv: readonly string[]): Args | { readonly error: string } {
  const [command, ...rest] = argv
  if (command !== "stage" && command !== "publish") return { error: "the command is stage or publish" }
  let out = join(ROOT, "dist", "npm")
  let pack: string | null = null
  let partial = false
  let provenance = false
  let otp: string | null = null
  const positional: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!
    const value = () => {
      const next = rest[++index]
      if (next === undefined || next === "") throw new Error(`${arg} needs a value`)
      return next
    }
    try {
      if (arg === "--out") out = resolve(value())
      else if (arg === "--pack" && command === "stage") pack = resolve(value())
      else if (arg === "--partial" && command === "stage") partial = true
      else if (arg === "--provenance" && command === "publish") provenance = true
      else if (arg === "--otp" && command === "publish") otp = value()
      else if (arg.startsWith("-")) return { error: `unknown option ${arg} for ${command}` }
      else positional.push(arg)
    } catch (error) {
      return { error: (error as Error).message }
    }
  }
  if (positional.length !== 1) return { error: `${command} takes one directory of builds` }
  return { command, builds: resolve(positional[0]!), out, pack, partial, provenance, otp }
}

const USAGE = "usage: bun scripts/npm.ts stage <builds> [--out <dir>] [--pack <dir>] [--partial] | publish <builds> [--out <dir>] [--provenance] [--otp <code>]"

function main(argv: readonly string[]): number {
  const error = (message: string) => console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `npm: ${message}`)
  const args = parseNpmArgs(argv)
  if ("error" in args) {
    error(args.error)
    console.error(USAGE)
    return 2
  }
  const staging = stagePackages(args.builds, args.out, { partial: args.partial })
  for (const problem of staging.problems) error(problem)
  if (staging.problems.length > 0) return 1
  // With --pack, the real pack is the check (it reports what the dry run would); otherwise the dry run.
  if (args.pack !== null) mkdirSync(args.pack, { recursive: true })
  const problems: string[] = []
  for (const pkg of staging.packages) {
    const report = npmPack(pkg, args.pack ?? undefined)
    console.log(packLine(report))
    if (args.pack !== null) console.log(`  packed ${shown(join(args.pack, report.filename))}`)
    problems.push(...checkPack(pkg, report, staging.version))
  }
  for (const problem of problems) error(problem)
  if (problems.length > 0) return 1
  const missing = TARGETS.length - staging.packages.filter((pkg) => pkg.kind === "platform").length
  console.log(`staged ${staging.packages.length} packages of version ${staging.version} in ${shown(args.out)}${missing > 0 ? ` (partial: ${missing} target(s) left out)` : ""}`)
  if (args.command === "stage") return 0
  for (const pkg of staging.packages) {
    if (published(pkg.name, staging.version)) {
      console.log(`${pkg.name}@${staging.version} is already on the registry: not publishing it again`)
      continue
    }
    const command = ["npm", "publish", pkg.dir, "--access", "public", ...(args.provenance ? ["--provenance"] : []), ...(args.otp === null ? [] : ["--otp", args.otp])]
    console.log(`publishing ${pkg.name}@${staging.version}`)
    const result = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] })
    if (result.exitCode !== 0) {
      error(`npm publish of ${pkg.name}@${staging.version} failed (exit code ${result.exitCode}); what was published before it stays, and running this again skips it`)
      return 1
    }
  }
  console.log(`published ${staging.packages.map((pkg) => `${pkg.name}@${staging.version}`).join(", ")}`)
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
