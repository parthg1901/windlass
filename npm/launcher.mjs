#!/usr/bin/env node
// The command the npm package installs (its `bin`, for the binary and each alias). It finds the
// executable for this machine in the platform package npm installed beside it (an optional
// dependency, `<this package>-<os>-<arch>`, which npm picks by its `os`, `cpu` and `libc`) and runs it
// with the same arguments, standard input, output and error, and environment, then exits as it did:
// with its exit code, or by the same signal.
//
// It runs on Node (the `engines` version or later) and on Bun, uses nothing but their built-in
// modules, and names no product: the package's names come from the package.json beside it.
//
// Signals: SIGTERM and SIGHUP are passed on to the executable. SIGINT and SIGQUIT are passed on
// only when no standard stream is a terminal: from a terminal, Ctrl-C and Ctrl-\ already reach the
// executable, which is in the same process group, and a second copy would count as a second press.
// Either way this process does not die of them before the executable has ended.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { constants } from "node:os"
import { dirname, join } from "node:path"
import { isatty } from "node:tty"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(here, "package.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
// The binary's name is the first `bin` entry; the others are its aliases.
const binary = Object.keys(manifest.bin ?? {})[0] ?? manifest.name
const platform = `${process.platform}-${process.arch}`
const platformPackage = `${manifest.name}-${platform}`
const known = Object.keys(manifest.optionalDependencies ?? {})

function fail(lines) {
  process.stderr.write(lines.map((line) => `${binary}: ${line}\n`).join(""))
  process.exit(1)
}

/** Whether this is Linux with musl instead of glibc (Alpine, for one), which the Linux executables do not run on. */
function musl() {
  if (process.platform !== "linux") return false
  try {
    const header = process.report?.getReport?.()?.header
    return header !== undefined && header.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}

function executable() {
  const reinstall = `Reinstall with optional dependencies included: npm install -g ${manifest.name}`
  if (!known.includes(platformPackage)) {
    const targets = known.map((name) => name.slice(manifest.name.length + 1)).join(", ")
    fail([`there is no executable for this machine (${platform}) in ${manifest.name}; there are executables for ${targets}.`])
  }
  let found
  try {
    found = createRequire(manifestPath).resolve(`${platformPackage}/package.json`)
  } catch {
    if (musl()) fail([`${platformPackage} is not installed: its executable needs glibc, and this Linux uses musl.`])
    fail([
      `${platformPackage}, the package with the executable for this machine (${platform}), is not installed.`,
      `npm leaves it out when optional dependencies are omitted (--omit=optional, --no-optional, or omit=optional in an .npmrc).`,
      reinstall,
    ])
  }
  const installed = JSON.parse(readFileSync(found, "utf8")).version
  if (installed !== manifest.version)
    fail([`${platformPackage} is version ${installed}, but ${manifest.name} is version ${manifest.version}; they must be the same.`, reinstall])
  return join(dirname(found), "bin", binary)
}

const path = executable()
const terminal = [0, 1, 2].some((fd) => isatty(fd))
let child = null
// Listening before the executable starts, so that no signal arrives while nobody would pass it on.
const handlers = ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"].map((signal) => {
  const handler = () => {
    if ((signal === "SIGINT" || signal === "SIGQUIT") && terminal) return
    if (child !== null && child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  process.on(signal, handler)
  return [signal, handler]
})

child = spawn(path, process.argv.slice(2), { stdio: "inherit" })
let started = false
child.on("spawn", () => {
  started = true
})
child.on("error", (error) => {
  if (!started) fail([`could not run ${path}: ${error.message}`])
})
child.on("exit", (code, signal) => {
  for (const [name, handler] of handlers) process.off(name, handler)
  if (signal === null) process.exit(code ?? 1)
  // Ended by a signal: end by the same one, so whoever started this sees what happened. Should it not end
  // this process (it is ignored here), exit with the shell's number for it instead.
  process.kill(process.pid, signal)
  setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 200)
})
