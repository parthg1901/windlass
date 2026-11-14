/**
 * The release steps that are not the build (`scripts/release.ts`): the tag,
 * version and changelog check, and collecting the four builds into the
 * release's files with their checksums. The builds here are small synthetic
 * files with hand-written records.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import workspace from "../../package.json" with { type: "json" }
import { brand } from "../../packages/core/src/brand.ts"
import { ROOT, TARGETS, artifactName } from "../../scripts/build.ts"
import { CHECKSUMS, INSTALL_SCRIPT, changelogSection, checkRelease, collectAssets } from "../../scripts/release.ts"

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

## [0.2.0] - 2026-12-01

### Added

- Something new.

## [0.1.0] - 2026-11-20

First release.

[Unreleased]: https://example.com/compare/v0.2.0...HEAD
[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
`

describe("the changelog and the tag", () => {
  test("a version's section runs to the next heading or the link definitions", () => {
    expect(changelogSection(CHANGELOG, "0.2.0")).toBe("\n### Added\n\n- Something new.\n")
    expect(changelogSection(CHANGELOG, "0.1.0")).toBe("\nFirst release.\n")
    expect(changelogSection(CHANGELOG, "Unreleased")).toBe("")
    expect(changelogSection(CHANGELOG, "0.3.0")).toBeUndefined()
    // 0.1.0 is not 0.1.01 or 0x1x0.
    expect(changelogSection("## [0.1.01]\n\nx\n## [0x1x0]\n\ny\n", "0.1.0")).toBeUndefined()
  })

  test("a matching tag with its section passes, with the section as the notes and the brand's name in the title", () => {
    expect(checkRelease("v0.2.0", "0.2.0", CHANGELOG)).toEqual({ tag: "v0.2.0", version: "0.2.0", title: `${brand.name} 0.2.0`, notes: "### Added\n\n- Something new.\n", problems: [] })
  })

  test("each thing that stops a release is named", () => {
    expect(checkRelease("v0.2.1", "0.2.0", CHANGELOG).problems).toEqual(["the tag v0.2.1 does not match the package.json version 0.2.0 (expected v0.2.0)"])
    expect(checkRelease("v0.3.0", "0.3.0", CHANGELOG).problems).toEqual(['CHANGELOG.md has no "## [0.3.0]" section'])
    expect(checkRelease("v0.3.0", "0.3.0", "## [0.3.0]\n\n## [0.2.0]\n\nx\n").problems).toEqual(["CHANGELOG.md's section for 0.3.0 is empty"])
    const pending = CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Not yet released.\n")
    expect(checkRelease("v0.2.0", "0.2.0", pending).problems).toEqual([expect.stringContaining('entries under "## [Unreleased]"')])
  })

  test("a dry run with no section for the version takes the Unreleased entries as the notes", () => {
    const pending = "## [Unreleased]\n\n- Coming.\n"
    const result = checkRelease("v0.0.0", "0.0.0", pending, { dryRun: true })
    expect(result.notes).toBe("- Coming.\n")
    expect(result.problems).toHaveLength(2)
    expect(checkRelease("v0.0.0", "0.0.0", pending).notes).toBe("")
  })

  test("the repository's own changelog reads: an Unreleased section, and one for the version when it is not 0.0.0", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")
    expect(changelogSection(changelog, "Unreleased")).toBeDefined()
    // Between two releases the next one's entries wait under Unreleased (docs/releasing.md moves them when it is
    // released): they stop a tag, which `check` says then, and are no fault of the changelog as it reads today.
    const waiting = (problem: string) => problem.includes('entries under "## [Unreleased]"')
    if (workspace.version !== "0.0.0") expect(checkRelease(`v${workspace.version}`, workspace.version, changelog).problems.filter((problem) => !waiting(problem))).toEqual([])
    else expect(checkRelease("v0.0.0", "0.0.0", changelog, { dryRun: true }).notes).not.toBe("")
  })
})

describe("collecting the builds", () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-assets-"))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))
  const sha = (text: string) => createHash("sha256").update(text).digest("hex")

  /** One directory per target, as the workflow downloads them: a fake executable and the build's record. */
  function builds(name: string, change: (target: (typeof TARGETS)[number], build: Record<string, unknown>) => Record<string, unknown> | null = (_, build) => build) {
    const dir = join(scratch, name)
    for (const target of TARGETS) {
      const content = `synthetic executable for ${target.id}\n`
      const build = change(target, { target: target.id, file: artifactName(target), bytes: content.length, sha256: sha(content), version: "0.1.0+0123456789", tui: true, bytecode: false, tuiMissing: null })
      if (build === null) continue
      mkdirSync(join(dir, target.id), { recursive: true })
      writeFileSync(join(dir, target.id, artifactName(target)), content)
      writeFileSync(join(dir, target.id, "build-info.json"), JSON.stringify({ binary: brand.binary, aliases: brand.aliases, builds: [build] }))
    }
    return dir
  }

  test("four good builds give the executables, one record of all four, the install script and checksums over them all", () => {
    const out = join(scratch, "out")
    const result = collectAssets(builds("good"), out, { version: "0.1.0" })
    expect(result.problems).toEqual([])
    const names = TARGETS.map(artifactName)
    expect(readdirSync(out).toSorted()).toEqual([...names, "build-info.json", CHECKSUMS, INSTALL_SCRIPT].toSorted())
    expect(result.info.builds.map((build) => build.target)).toEqual(TARGETS.map((target) => target.id))
    expect(JSON.parse(readFileSync(join(out, "build-info.json"), "utf8"))).toMatchObject({ binary: brand.binary, aliases: brand.aliases })
    expect(readFileSync(join(out, INSTALL_SCRIPT), "utf8")).toBe(readFileSync(join(ROOT, "scripts", INSTALL_SCRIPT), "utf8"))
    // `sha256sum -c` format: hash, two spaces, name; each line the file's real hash.
    const lines = readFileSync(join(out, CHECKSUMS), "utf8").trimEnd().split("\n")
    expect(lines.map((line) => line.split("  ")[1])).toEqual([...names, "build-info.json", INSTALL_SCRIPT])
    for (const line of lines) {
      const [hash, file] = line.split("  ")
      expect(hash).toBe(createHash("sha256").update(readFileSync(join(out, file!))).digest("hex"))
    }
  })

  test("a missing target, a changed file, a build without the interface, another version or commit, or a dirty tree stops it", () => {
    const problems = (name: string, change: Parameters<typeof builds>[1]) => collectAssets(builds(name, change), join(scratch, `${name}-out`), { version: "0.1.0" }).problems
    expect(problems("missing", (target, build) => (target.id === "darwin-x64" ? null : build))).toEqual(["no build of darwin-x64"])
    expect(problems("changed", (target, build) => (target.id === "linux-arm64" ? { ...build, sha256: sha("other") } : build))).toEqual([`linux-arm64: ${brand.binary}-linux-arm64 is not the file its build recorded (SHA-256 differs)`])
    expect(problems("no-tui", (target, build) => (target.id === "linux-x64" ? { ...build, tui: false, tuiMissing: "not installed" } : build))).toEqual(["linux-x64: built without the full-screen interface (not installed)"])
    expect(problems("commits", (target, build) => (target.id === "darwin-arm64" ? { ...build, version: "0.1.0+abcdefabcd" } : build))).toEqual(["the builds come from different commits: 0123456789, abcdefabcd"])
    expect(problems("version", (target, build) => (target.id === "linux-x64" ? { ...build, version: "0.0.9+0123456789" } : build))).toEqual(["linux-x64: version 0.0.9+0123456789 is not 0.1.0"])
    expect(problems("dirty", (target, build) => (target.id === "linux-x64" ? { ...build, version: "0.1.0+0123456789.dirty" } : build))).toEqual(["linux-x64: built from a tree with uncommitted changes (0.1.0+0123456789.dirty)"])
  })
})
