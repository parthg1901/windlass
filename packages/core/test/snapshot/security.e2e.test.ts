import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { listing, open, removeTempDirs, sh, tempDir, userEnv, userHome, write } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(removeTempDirs)

const HOOKS = [
  "pre-commit",
  "post-checkout",
  "post-index-change",
  "reference-transaction",
  "pre-auto-gc",
  "post-rewrite",
  "fsmonitor-watchman",
  "pre-push",
  "post-merge",
]
const CRLF = "line one\r\nkeyword $Id$\r\n"

/**
 * A workspace whose own repository, attributes, nested repository, global
 * config and environment all try to run `touch <markers>/<name>`.
 */
function plantTraps(ws: string, markers: string) {
  const touch = (name: string) => `touch ${markers}/${name}`
  const hooks = tempDir("hooks")
  for (const hook of HOOKS) {
    for (const dir of [hooks, join(ws, ".git", "hooks")]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, hook), `#!/bin/sh\n${touch(`hook-${hook}`)}\n`)
      chmodSync(join(dir, hook), 0o755)
    }
  }
  const config = (prefix: string) =>
    [
      "[core]",
      `\tfsmonitor = \"${touch(`${prefix}fsmonitor`)}\"`,
      `\thooksPath = ${hooks}`,
      `\tpager = ${touch(`${prefix}pager`)}`,
      `\teditor = ${touch(`${prefix}editor`)}`,
      `\tsshCommand = ${touch(`${prefix}ssh`)}`,
      `\talternateRefsCommand = ${touch(`${prefix}alternate-refs`)}`,
      `\tuntrackedCache = false`,
      `[filter "evil"]`,
      `\tclean = ${touch(`${prefix}filter-clean`)}`,
      `\tsmudge = ${touch(`${prefix}filter-smudge`)}`,
      `\tprocess = ${touch(`${prefix}filter-process`)}`,
      `\trequired = true`,
      `[diff "evil"]`,
      `\ttextconv = ${touch(`${prefix}textconv`)}`,
      `\tcommand = ${touch(`${prefix}diff-command`)}`,
      `[merge "evil"]`,
      `\tdriver = ${touch(`${prefix}merge-driver`)}`,
      `[credential]`,
      `\thelper = !${touch(`${prefix}credential`)}`,
      `[diff]`,
      `\texternal = ${touch(`${prefix}diff-external`)}`,
      "",
    ].join("\n")
  writeFileSync(join(ws, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${config("repo-")}`)
  writeFileSync(join(ws, ".gitattributes"), "* filter=evil diff=evil merge=evil text eol=crlf ident working-tree-encoding=UTF-16\n")
  writeFileSync(join(ws, "crlf.txt"), CRLF)
  sh(join(ws, "vendor", "lib"), "git init -q")
  writeFileSync(join(ws, "vendor", "lib", ".git", "config"), `[core]\n\trepositoryformatversion = 0\n${config("nested-")}`)
  return { globalConfig: config("global-") }
}

describe("a hostile workspace", () => {
  test("its config, hooks, attributes, nested repository, global config and environment never run anything", async () => {
    // Control: the traps are live. Plain git in an identical workspace sets them off.
    const control = tempDir("control")
    const controlMarkers = tempDir("control-markers")
    write(control, { "a.txt": "a\n", "vendor/lib/file.txt": "lib\n" })
    sh(control, "git init -q && git add a.txt && git commit -qm init")
    plantTraps(control, controlMarkers)
    Bun.spawnSync(["bash", "-c", "git status; git add -A; git -c filter.evil.process= -c filter.evil.required=false commit --allow-empty -qm x"], {
      cwd: control,
      env: userEnv(userHome),
    })
    expect(readdirSync(controlMarkers).sort()).toEqual(expect.arrayContaining(["repo-filter-process", "repo-fsmonitor", "hook-pre-commit"]))

    const ws = tempDir("hostile")
    const markers = tempDir("markers")
    write(ws, { "a.txt": "a\n", "vendor/lib/file.txt": "lib\n" })
    sh(ws, "git init -q && git add a.txt && git commit -qm init")
    const traps = plantTraps(ws, markers)
    const userGit = listing(join(ws, ".git"), { mtimes: true })

    // The harness itself may run under a hostile environment (inside a git hook, or with a crafted global config).
    const home = tempDir("hostile-home")
    writeFileSync(join(home, ".gitconfig"), traps.globalConfig)
    const saved = { ...process.env }
    Object.assign(process.env, {
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_DIR: join(ws, ".git"),
      GIT_WORK_TREE: ws,
      GIT_INDEX_FILE: join(ws, ".git", "index"),
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='touch ${markers}/env-parameters'`,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: `touch ${markers}/env-count`,
      GIT_EXTERNAL_DIFF: `touch ${markers}/env-external-diff`,
      GIT_SSH_COMMAND: `touch ${markers}/env-ssh`,
      GIT_ASKPASS: `${markers}/askpass`,
      GIT_EXEC_PATH: join(markers, "no-exec-path"),
    })
    try {
      const snapshots = await open(ws)
      const s1 = await snapshots.take({ session: "s" })
      expect(s1.nestedRepositories).toEqual(["vendor/lib"])
      sh(ws, "rm crlf.txt && echo b > b.txt && chmod +x a.txt", userEnv(userHome))
      const s2 = await snapshots.take({ session: "s" })
      const changes = await snapshots.diff(s1.id, s2.id, { patch: true })
      expect(changes.map((change) => change.path)).toEqual(["a.txt", "b.txt", "crlf.txt"])
      await snapshots.restore(s1.id, { session: "s", dryRun: true })
      await snapshots.restore(s1.id, { session: "s" })
      await snapshots.restore(s2.id, { session: "s", paths: ["b.txt"] })
      await snapshots.prune({ keepLast: 1, graceSeconds: 0 })
      await snapshots.list()
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }

    expect(readdirSync(markers)).toEqual([])
    // Bytes went in and came out untouched: no line-ending conversion, no $Id$ expansion, no re-encoding.
    expect(readFileSync(join(ws, "crlf.txt"), "utf8")).toBe(CRLF)
    expect(listing(join(ws, ".git"), { mtimes: true })).toEqual(userGit)
    rmSync(home, { recursive: true, force: true })
  }, 30_000)
})
