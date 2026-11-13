#!/usr/bin/env bun
/**
 * The two steps of a release that are not building, runnable locally
 * (`.github/workflows/release.yml` runs both; docs/releasing.md is the checklist):
 *
 *   bun scripts/release.ts check <tag> [--notes <file>]
 *       Fails when the tag is not "v" + the root package.json version, when
 *       CHANGELOG.md has no section for that version or it is empty, or when
 *       "## [Unreleased]" still has entries (the tagged code would then hold
 *       changes the release notes leave out). Otherwise writes the version's
 *       section, without its heading, to the notes file.
 *
 *   bun scripts/release.ts check --dry-run [<tag>] [--notes <file>]
 *       The same checks, reported as warnings: the tag defaults to the current
 *       version's, and the notes fall back to the Unreleased section.
 *
 *   bun scripts/release.ts assets <built-dir> <out-dir>
 *       <built-dir> holds what each target's build left (an executable and its
 *       build-info.json, one directory per target, as the workflow downloads
 *       them). Checks that all four targets are there, each one's SHA-256 is
 *       the one its build recorded, all are the package.json version and
 *       come from the same clean commit, and
 *       include the full-screen interface; then writes to <out-dir> the four
 *       executables, one merged build-info.json, the install script, and
 *       SHA256SUMS over all of them (the format `sha256sum -c` and
 *       `shasum -a 256 -c` read).
 *
 * In GitHub Actions, `check` also writes `version`, `tag` and `title` to
 * $GITHUB_OUTPUT, and every failure is an `::error::` annotation.
 */
import { createHash } from "node:crypto"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { ROOT, TARGETS, type Built } from "./build.ts"

export const CHECKSUMS = "SHA256SUMS"
export const INSTALL_SCRIPT = "install.sh"

/** Pure: the text between "## [version]" (with or without a date) and the next "## " heading or link definitions. */
export function changelogSection(text: string, version: string): string | undefined {
  const lines = text.split("\n")
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const start = lines.findIndex((line) => new RegExp(`^## \\[${escaped}\\](\\s|$)`).test(line))
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line) || /^\[[^\]]+\]: /.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join("\n")
}

export interface ReleaseCheck {
  readonly tag: string
  readonly version: string
  readonly title: string
  /** The release notes: the version's section, trimmed, ending in a newline. Empty when there is none. */
  readonly notes: string
  readonly problems: readonly string[]
}

/** Pure: what a release of `tag` would publish, and what stops it. */
export function checkRelease(tag: string, version: string, changelog: string, options: { readonly dryRun?: boolean } = {}): ReleaseCheck {
  const problems: string[] = []
  if (tag !== `v${version}`) problems.push(`the tag ${tag} does not match the package.json version ${version} (expected v${version})`)
  const section = changelogSection(changelog, version)
  const unreleased = (changelogSection(changelog, "Unreleased") ?? "").trim()
  if (section === undefined) problems.push(`CHANGELOG.md has no "## [${version}]" section`)
  else if (section.trim() === "") problems.push(`CHANGELOG.md's section for ${version} is empty`)
  if (unreleased !== "")
    problems.push(`CHANGELOG.md has entries under "## [Unreleased]" that ${tag} would publish without release notes. Move them into the "## [${version}]" section, or release them as the next version.`)
  const body = section?.trim() || (options.dryRun ? unreleased : "")
  return { tag, version, title: `${brand.name} ${version}`, notes: body === "" ? "" : `${body}\n`, problems }
}

export interface Assets {
  readonly files: readonly string[]
  readonly checksums: string
  readonly info: { readonly binary: string; readonly aliases: readonly string[]; readonly builds: readonly Built[] }
  readonly problems: readonly string[]
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

/** Every build-info.json under `dir` (one level of subdirectories, or `dir` itself), with the directory it is in. */
export function buildRecords(dir: string): { readonly dir: string; readonly binary: string; readonly aliases: readonly string[]; readonly builds: readonly Built[] }[] {
  const dirs = [dir, ...readdirSync(dir).map((name) => join(dir, name)).filter((path) => statSync(path).isDirectory())]
  return dirs.filter((path) => existsSync(join(path, "build-info.json"))).map((path) => ({ dir: path, ...(JSON.parse(readFileSync(join(path, "build-info.json"), "utf8")) as { binary: string; aliases: string[]; builds: Built[] }) }))
}

/** Collects the four builds from `builtDir` into `outDir`, with the merged record, the install script and the checksums. */
export function collectAssets(builtDir: string, outDir: string, options: { readonly version?: string; readonly root?: string } = {}): Assets {
  const root = options.root ?? ROOT
  const problems: string[] = []
  const records = buildRecords(builtDir)
  const builds: Built[] = []
  mkdirSync(outDir, { recursive: true })
  for (const target of TARGETS) {
    const found = records.flatMap((record) => record.builds.filter((build) => build.target === target.id).map((build) => ({ record, build })))
    if (found.length === 0) {
      problems.push(`no build of ${target.id}`)
      continue
    }
    if (found.length > 1) problems.push(`${found.length} builds of ${target.id}`)
    const { record, build } = found[0]!
    const source = join(record.dir, build.file)
    if (!existsSync(source)) {
      problems.push(`${target.id}: its build-info.json names ${build.file}, which is not there`)
      continue
    }
    if (sha256(source) !== build.sha256) problems.push(`${target.id}: ${build.file} is not the file its build recorded (SHA-256 differs)`)
    if (!build.tui) problems.push(`${target.id}: built without the full-screen interface (${build.tuiMissing ?? "no reason recorded"})`)
    copyFileSync(source, join(outDir, build.file))
    builds.push(build)
  }
  // `<version>+<commit>[.dirty]`: the release's version, one commit for all, and a clean tree.
  if (options.version !== undefined) for (const build of builds) if (build.version.split("+")[0] !== options.version) problems.push(`${build.target}: version ${build.version} is not ${options.version}`)
  const commits = new Set(builds.map((build) => /\+([0-9a-f]+)/.exec(build.version)?.[1] ?? build.version))
  if (commits.size > 1) problems.push(`the builds come from different commits: ${[...commits].join(", ")}`)
  for (const build of builds) if (/\+[0-9a-f]+\.dirty/.test(build.version)) problems.push(`${build.target}: built from a tree with uncommitted changes (${build.version})`)
  const first = records[0]
  const info = { binary: first?.binary ?? brand.binary, aliases: first?.aliases ?? brand.aliases, builds }
  writeFileSync(join(outDir, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`)
  copyFileSync(join(root, "scripts", INSTALL_SCRIPT), join(outDir, INSTALL_SCRIPT))
  const files = [...builds.map((build) => build.file), "build-info.json", INSTALL_SCRIPT]
  const checksums = files.map((file) => `${sha256(join(outDir, file))}  ${file}\n`).join("")
  writeFileSync(join(outDir, CHECKSUMS), checksums)
  return { files: [...files, CHECKSUMS], checksums, info, problems }
}

function main(argv: readonly string[]): number {
  const error = (message: string) => console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `release: ${message}`)
  const warn = (message: string) => console.error(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `release (dry run): ${message}`)
  const [command, ...rest] = argv
  if (command === "check") {
    const dryRun = rest.includes("--dry-run")
    const notesAt = rest.indexOf("--notes")
    const notesFile = notesAt === -1 ? undefined : rest[notesAt + 1]
    const positional = rest.filter((arg, index) => !arg.startsWith("--") && (notesAt === -1 || index !== notesAt + 1))
    const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version
    const tag = positional[0] ?? (dryRun ? `v${version}` : undefined)
    if (tag === undefined || (notesAt !== -1 && notesFile === undefined)) {
      error("usage: bun scripts/release.ts check <tag> [--notes <file>] | check --dry-run [<tag>] [--notes <file>]")
      return 2
    }
    const result = checkRelease(tag, version, readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), { dryRun })
    for (const problem of result.problems) (dryRun ? warn : error)(problem)
    if (result.problems.length > 0 && !dryRun) return 1
    if (notesFile !== undefined) writeFileSync(notesFile, result.notes)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\ntitle=${result.title}\n`)
    console.log(`${dryRun ? "dry run of " : ""}release ${tag}: "${result.title}", release notes of ${result.notes.trim() === "" ? 0 : result.notes.trim().split("\n").length} lines${result.problems.length > 0 ? `, ${result.problems.length} problem(s) a tag would stop at` : ""}`)
    return 0
  }
  if (command === "assets" && rest.length === 2) {
    const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version
    const result = collectAssets(rest[0]!, rest[1]!, { version })
    for (const problem of result.problems) error(problem)
    if (result.problems.length > 0) return 1
    process.stdout.write(result.checksums)
    console.log(`release assets in ${rest[1]}: ${result.files.map((file) => basename(file)).join(", ")}`)
    return 0
  }
  error("usage: bun scripts/release.ts check <tag> [--notes <file>] [--dry-run] | assets <built-dir> <out-dir>")
  return 2
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
