#!/usr/bin/env bun
// Makes a throwaway copy of a real repository for a dogfood pass (see README.md beside this file).
//
//   bun evals/dogfood/setup.ts [--out <dir>] [--seed <name>] [--source <repo>] [--no-install]
//   bun evals/dogfood/setup.ts --seeds
//
// It clones the source repository (never touching it), installs its dependencies from the lockfile,
// writes the harness's project configuration with the project's real checks, optionally plants a
// seeded bug, and commits all of that in the clone so the working tree starts clean. It prints the
// workspace path and the commands to start the harness in it. Remove the workspace with `rm -rf`
// when the pass is done. Nothing here reads or writes the harness's data directory.

import { existsSync } from "node:fs"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"

const REPO = resolve(import.meta.dir, "../..")
const DEFAULT_SOURCE = "/home/ubuntu/projects/prefixlens"

/** The project's real check commands (prefixlens: `bun test`, 203 tests in about 4 s; `tsc --noEmit`, about 1 s). */
const CHECKS = [
  { name: "test", command: "bun test", timeoutSeconds: 180, when: ["src/**", "test/**", "*.json"] },
  { name: "types", command: "bun run typecheck", timeoutSeconds: 120, when: ["src/**", "test/**", "tsconfig.json"] },
]

interface Seed {
  readonly description: string
  readonly file: string
  readonly from: string
  readonly to: string
}

/** Bugs planted on purpose, each a one-line change a developer could plausibly have made. */
const SEEDS: Record<string, Seed> = {
  "usage-bug": {
    description: "OpenAI usage counts cached tokens twice: input_tokens is no longer reduced by the cached part (9 tests fail, in the trace, billing, cache-writes, record, cli and params tests)",
    file: "src/usage.ts",
    from: "    input_tokens: total - cached - (writes ?? 0),\n    cache_read_tokens: cached,",
    to: "    input_tokens: total - (writes ?? 0),\n    cache_read_tokens: cached,",
  },
}

function parse(argv: string[]) {
  const options = { out: "", seed: "", source: DEFAULT_SOURCE, install: true, listSeeds: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const value = () => {
      const next = argv[++index]
      if (next === undefined) fail(`${arg} needs a value`)
      return next!
    }
    if (arg === "--out") options.out = value()
    else if (arg === "--seed") options.seed = value()
    else if (arg === "--source") options.source = value()
    else if (arg === "--no-install") options.install = false
    else if (arg === "--seeds") options.listSeeds = true
    else if (arg === "-h" || arg === "--help") {
      console.log("usage: bun evals/dogfood/setup.ts [--out <dir>] [--seed <name>] [--source <repo>] [--no-install] | --seeds")
      process.exit(0)
    } else fail(`unknown argument ${arg}`)
  }
  return options
}

function fail(message: string): never {
  console.error(`setup: ${message}`)
  process.exit(2)
}

function run(cwd: string, ...cmd: string[]) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) fail(`${cmd.join(" ")} failed in ${cwd}:\n${result.stderr.toString()}${result.stdout.toString()}`)
  return result.stdout.toString()
}

const options = parse(process.argv.slice(2))
if (options.listSeeds) {
  for (const [name, seed] of Object.entries(SEEDS)) console.log(`${name}\n  ${seed.description}`)
  process.exit(0)
}
if (options.seed && !SEEDS[options.seed]) fail(`unknown seed "${options.seed}"; known: ${Object.keys(SEEDS).join(", ")}`)
const source = resolve(options.source)
if (!existsSync(join(source, ".git"))) fail(`${source} is not a git repository`)
if (source === REPO) fail("the source must not be this repository")

const out = options.out ? resolve(options.out) : await mkdtemp(join(tmpdir(), "dogfood-"))
if (existsSync(join(out, ".git"))) fail(`${out} already holds a repository; pick another --out`)
await mkdir(out, { recursive: true })
// A local clone: the source's objects are copied or hard-linked, and the source is only read.
run(tmpdir(), "git", "clone", "--quiet", "--no-hardlinks", source, out)
// The clone has `origin` pointing at the source. Remove it so nothing in the pass can push back to it.
run(out, "git", "remote", "remove", "origin")
run(out, "git", "config", "user.name", "dogfood")
run(out, "git", "config", "user.email", "dogfood@example.invalid")
run(out, "git", "config", "commit.gpgsign", "false")

if (options.install && existsSync(join(out, "bun.lock"))) run(out, "bun", "install", "--frozen-lockfile")

const configDir = join(out, `.${brand.directory}`)
await mkdir(configDir, { recursive: true })
const config = { model: "gpt-6-luna", effort: "low", checks: CHECKS, verify: { mode: "gate", maxRounds: 3 } }
await writeFile(join(configDir, "config.json"), JSON.stringify(config, null, 2) + "\n")
run(out, "git", "add", `.${brand.directory}/config.json`)
run(out, "git", "commit", "--quiet", "-m", "chore: project configuration for the coding agent")

if (options.seed) {
  const seed = SEEDS[options.seed]!
  const path = join(out, seed.file)
  const text = await readFile(path, "utf8")
  if (!text.includes(seed.from)) fail(`seed ${options.seed}: ${seed.file} no longer has the expected text; update SEEDS`)
  await writeFile(path, text.replace(seed.from, seed.to))
  run(out, "git", "commit", "--quiet", "-am", "refactor: simplify usage normalisation")
}

const cli = `bun ${join(REPO, "packages/cli/src/main.ts")}`
console.log(`workspace: ${out}`)
console.log(`seed:      ${options.seed || "none"}`)
console.log(`checks:    ${CHECKS.map((check) => `${check.name} (${check.command})`).join(", ")}`)
console.log("")
console.log(`  ${cli} --cwd ${out} --model gpt-6-luna --effort low "<prompt>"     # one-shot`)
console.log(`  ${cli} --cwd ${out} --model gpt-6-luna --effort low                # interactive`)
console.log(`  ${cli} tui --cwd ${out} --model gpt-6-luna --effort low            # full screen`)
console.log(`  rm -rf ${out}                                                       # when done`)
