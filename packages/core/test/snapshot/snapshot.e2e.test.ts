import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type SnapshotId, SnapshotError, openSnapshots } from "../../src/snapshot/index.ts"
import { EMPTY_TREE, filesIn, listing, open, privateGit, removeTempDirs, repositoryState, sh, tempDir, userHome, write } from "./helpers.ts"

afterEach(removeTempDirs)

const session = "ses_test"

describe("take", () => {
  test("a git repository with staged, unstaged and untracked changes is never read or written", async () => {
    const repo = tempDir("repo")
    write(repo, { "a.txt": "a1\n", "b.txt": "b1\n", "src/c.ts": "c1\n", ".gitignore": "*.log\n" })
    sh(repo, "git init -q -b main && git add -A && git commit -qm one && git checkout -qb feature")
    write(repo, { "a.txt": "a-stashed\n" })
    sh(repo, "git stash -q")
    write(repo, { "a.txt": "a-staged\n", "b.txt": "b-unstaged\n", "new.txt": "untracked\n", "debug.log": "ignored\n" })
    sh(repo, "git add a.txt")
    const before = repositoryState(repo, userHome)
    const workspaceBefore = listing(repo, { skipGit: true })

    const snapshots = await open(repo)
    const s1 = await snapshots.take({ session })
    expect(await filesIn(snapshots, s1.id)).toEqual([".gitignore", "a.txt", "b.txt", "new.txt", "src/c.ts"])
    sh(repo, "echo changed >> b.txt && rm new.txt && echo d > d.txt && rm src/c.ts")
    const s2 = await snapshots.take({ session })
    const changes = await snapshots.diff(s1.id, s2.id, { patch: true })
    expect(changes.map((change) => [change.path, change.status])).toEqual([
      ["b.txt", "modified"],
      ["d.txt", "added"],
      ["new.txt", "deleted"],
      ["src/c.ts", "deleted"],
    ])
    expect(await snapshots.restore(s1.id, { session, dryRun: true })).toMatchObject({ kind: "dry_run" })
    const restored = await snapshots.restore(s1.id, { session })
    expect(restored.kind).toBe("restored")

    // Back to the starting point: the working tree, and everything about the user's repository.
    expect(listing(repo, { skipGit: true })).toEqual(workspaceBefore)
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a-staged\n")
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b-unstaged\n")
    expect(repositoryState(repo, userHome)).toEqual(before)
    expect(snapshots.gitDir.startsWith(repo)).toBe(false)
  })

  test("a workspace that is not a repository gets no .git and is snapshotted the same way", async () => {
    const ws = tempDir("plain")
    write(ws, { "index.html": "<p>hi</p>\n", "css/site.css": "p{}\n" })
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    expect(await filesIn(snapshots, s1.id)).toEqual(["css/site.css", "index.html"])
    expect(existsSync(join(ws, ".git"))).toBe(false)
    sh(ws, "rm -r css && echo new > new.txt")
    expect(await snapshots.changedFiles(s1.id, (await snapshots.take({ session })).id)).toEqual(["css/site.css", "new.txt"])
    await snapshots.restore(s1.id, { session })
    expect(Object.keys(listing(ws))).toEqual(["css/", "css/site.css", "index.html"])
  })

  test("in a subdirectory of a repository, the repository's ignore rules apply and nothing outside the workspace is touched", async () => {
    const root = tempDir("mono")
    write(root, {
      ".gitignore": "node_modules/\n*.log\n",
      "README.md": "root\n",
      "packages/app/src/main.ts": "main\n",
      "packages/other/keep.ts": "other\n",
    })
    sh(root, "git init -q -b main && git add -A && git commit -qm init")
    write(root, { "packages/app/node_modules/dep/index.js": "dep\n", "packages/app/run.log": "log\n", "packages/app/notes.md": "notes\n" })
    const before = repositoryState(root, userHome)
    const outside = listing(join(root, "packages", "other"))
    const app = join(root, "packages", "app")

    const snapshots = await open(app)
    const initial = await snapshots.take({ session })
    expect(await filesIn(snapshots, initial.id)).toEqual(["notes.md", "src/main.ts"])
    // A state where the workspace held only ignored files: restoring it removes everything captured, and nothing more.
    sh(app, "rm -r src notes.md")
    const bare = await snapshots.take({ session })
    expect(await filesIn(snapshots, bare.id)).toEqual([])
    await snapshots.restore(initial.id, { session })
    expect(readFileSync(join(app, "src/main.ts"), "utf8")).toBe("main\n")
    await snapshots.restore(bare.id, { session })
    expect(Object.keys(listing(app)).sort()).toEqual(["node_modules/", "node_modules/dep/", "node_modules/dep/index.js", "run.log"])
    await snapshots.restore(initial.id, { session })
    expect(listing(join(root, "packages", "other"))).toEqual(outside)
    expect(repositoryState(root, userHome)).toEqual(before)
  })

  test("a workspace the enclosing repository ignores stands alone", async () => {
    const root = tempDir("scratch")
    write(root, { ".gitignore": "scratch/\n", "scratch/proj/a.txt": "a\n" })
    sh(root, "git init -q")
    const snapshots = await open(join(root, "scratch", "proj"))
    expect(await filesIn(snapshots, (await snapshots.take({ session })).id)).toEqual(["a.txt"])
  })

  test("a change of the same size within the same instant is still seen", async () => {
    const ws = tempDir("racy")
    write(ws, { "f.txt": "aaaa\n" })
    const snapshots = await open(ws)
    const ids = new Set<string>()
    for (const content of ["bbbb\n", "cccc\n", "dddd\n"]) {
      ids.add((await snapshots.take({ session })).id)
      writeFileSync(join(ws, "f.txt"), content)
    }
    ids.add((await snapshots.take({ session })).id)
    expect(ids.size).toBe(4)
  })

  test("an untracked file over the limit is skipped and reported; one captured earlier keeps being captured", async () => {
    const ws = tempDir("large")
    write(ws, { "small.txt": "s\n", "grows.bin": "tiny\n" })
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    writeFileSync(join(ws, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 1))
    writeFileSync(join(ws, "grows.bin"), Buffer.alloc(3 * 1024 * 1024, 2))
    const s2 = await snapshots.take({ session })
    expect(s2.skipped).toEqual([{ path: "big.bin", reason: "too_large", bytes: 3 * 1024 * 1024 }])
    expect(await filesIn(snapshots, s2.id)).toEqual(["grows.bin", "small.txt"])
    // Restore neither deletes nor reports a file it never captured.
    const restored = await snapshots.restore(s1.id, { session })
    expect(restored.changes.map((change) => change.path)).toEqual(["grows.bin"])
    expect(statSync(join(ws, "big.bin")).size).toBe(3 * 1024 * 1024)
    expect(readFileSync(join(ws, "grows.bin"), "utf8")).toBe("tiny\n")

    const strict = await open(ws, { maxFileBytes: 1 })
    expect((await strict.take({ session })).skipped.map((file) => file.path).sort()).toEqual(["big.bin", "grows.bin", "small.txt"])
  })

  test("an unreadable file is reported, not captured with stale content", async () => {
    if (process.getuid?.() === 0) return
    const ws = tempDir("unreadable")
    write(ws, { "secret.txt": "v1\n", "ok.txt": "ok\n" })
    const snapshots = await open(ws)
    await snapshots.take({ session })
    writeFileSync(join(ws, "secret.txt"), "v2\n")
    chmodSync(join(ws, "secret.txt"), 0)
    const s2 = await snapshots.take({ session })
    expect(s2.skipped).toEqual([{ path: "secret.txt", reason: "unreadable" }])
    expect(await filesIn(snapshots, s2.id)).toEqual(["ok.txt"])
  })

  test("nested repositories and submodules are recorded, never descended into, and left alone by restore", async () => {
    const ws = tempDir("nested")
    write(ws, { "top.txt": "top\n", "lib/committed/x.txt": "x\n", "lib/fresh/y.txt": "y\n" })
    sh(join(ws, "lib/committed"), "git init -q && git add -A && git commit -qm x")
    sh(join(ws, "lib/fresh"), "git init -q")
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    expect(s1.nestedRepositories).toEqual(["lib/committed", "lib/fresh"])
    expect(await filesIn(snapshots, s1.id)).toEqual(["top.txt"])
    sh(ws, "echo changed > lib/fresh/y.txt && rm top.txt")
    await snapshots.restore(s1.id, { session })
    expect(readFileSync(join(ws, "top.txt"), "utf8")).toBe("top\n")
    expect(readFileSync(join(ws, "lib/fresh/y.txt"), "utf8")).toBe("changed\n")
  })

  test("empty directories are not recorded; restore removes directories it empties", async () => {
    const ws = tempDir("emptydirs")
    write(ws, { "a.txt": "a\n" })
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    mkdirSync(join(ws, "empty"))
    expect((await snapshots.take({ session })).id).toBe(s1.id)
    write(ws, { "deep/er/file.txt": "f\n" })
    await snapshots.restore(s1.id, { session })
    expect(existsSync(join(ws, "deep"))).toBe(false)
    expect(existsSync(join(ws, "empty"))).toBe(true)
  })

  test("concurrent snapshots of one workspace, in one process and across processes, agree and leave the repository sound", async () => {
    const ws = tempDir("concurrent")
    write(ws, Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`d${index % 10}/f${index}.txt`, `${index}\n`])))
    const dataDir = tempDir("data")
    const [first, second] = await Promise.all([openSnapshots(ws, { dataDir }), openSnapshots(ws, { dataDir })])
    if (first.kind !== "ready" || second.kind !== "ready") throw new Error("unavailable")
    const takes = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).take({ session: `s${index}` })))
    expect(new Set(takes.map((take) => take.id)).size).toBe(1)

    const script = join(tempDir("script"), "take.ts")
    writeFileSync(
      script,
      `import { openSnapshots } from ${JSON.stringify(join(import.meta.dir, "../../src/snapshot/index.ts"))}\n` +
        `const s = await openSnapshots(process.argv[2], { dataDir: process.argv[3] })\n` +
        `if (s.kind !== "ready") process.exit(2)\n` +
        `for (let i = 0; i < 3; i++) console.log((await s.take({ session: "p" + process.pid })).id)\n`,
    )
    const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, script, ws, dataDir], { stdout: "pipe", stderr: "pipe" }))
    const outputs = await Promise.all(children.map(async (child) => ({ code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })))
    for (const output of outputs) expect(output).toMatchObject({ code: 0, err: "" })
    expect(new Set(outputs.flatMap((output) => output.out.trim().split("\n")))).toEqual(new Set([takes[0]!.id]))
    expect(await first.list()).toHaveLength(8 + 12)
    const fsck = privateGit(first.gitDir, ["fsck", "--strict", "--no-dangling"])
    expect({ code: fsck.exitCode, err: fsck.stderr.toString().replace(/^notice: HEAD points to an unborn branch.*\n/m, "") }).toEqual({ code: 0, err: "" })
  }, 30_000)
})

describe("symlinks and modes", () => {
  test("a symlink pointing outside the workspace is stored as a link and never followed", async () => {
    const root = tempDir("links")
    const ws = join(root, "ws")
    write(root, { "outside/secret.txt": "top secret\n", "ws/a.txt": "a\n" })
    symlinkSync("../outside", join(ws, "out"))
    symlinkSync("../outside/secret.txt", join(ws, "secret-link"))
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    const added = await snapshots.diff(EMPTY_TREE as SnapshotId, s1.id, { patch: true })
    expect(added.map((change) => [change.path, change.after?.kind])).toEqual([
      ["a.txt", "file"],
      ["out", "symlink"],
      ["secret-link", "symlink"],
    ])
    const patches = added.map((change) => (change.patch?.kind === "text" ? change.patch.text : "")).join("")
    expect(patches).toContain("+../outside/secret.txt")
    expect(patches).not.toContain("top secret")

    rmSync(join(ws, "out"))
    rmSync(join(ws, "secret-link"))
    await snapshots.restore(s1.id, { session })
    expect(readlinkSync(join(ws, "out"))).toBe("../outside")
    expect(readlinkSync(join(ws, "secret-link"))).toBe("../outside/secret.txt")
    expect(listing(join(root, "outside"))).toEqual({ "secret.txt": expect.stringContaining("file") })
  })

  test("restore never writes or deletes through a directory replaced by a symlink", async () => {
    const root = tempDir("through")
    const ws = join(root, "ws")
    write(root, { "ws/dir/file.txt": "mine\n", "outside/file.txt": "outside\n", "outside/other.txt": "other\n" })
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    sh(ws, "rm -r dir && ln -s ../outside dir")
    const s2 = await snapshots.take({ session })
    const outsideBefore = listing(join(root, "outside"), { mtimes: true })
    await snapshots.restore(s1.id, { session })
    expect(lstatSync(join(ws, "dir")).isDirectory()).toBe(true)
    expect(readFileSync(join(ws, "dir/file.txt"), "utf8")).toBe("mine\n")
    await snapshots.restore(s2.id, { session })
    expect(readlinkSync(join(ws, "dir"))).toBe("../outside")
    expect(listing(join(root, "outside"), { mtimes: true })).toEqual(outsideBefore)
  })

  test("a file made executable is a mode change, and restore puts the mode back", async () => {
    const ws = tempDir("mode")
    write(ws, { "run.sh": "#!/bin/sh\necho hi\n" })
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    sh(ws, "chmod +x run.sh")
    const s2 = await snapshots.take({ session })
    expect(await snapshots.diff(s1.id, s2.id)).toEqual([
      { path: "run.sh", status: "mode_changed", before: { kind: "file", blob: expect.any(String) }, after: { kind: "executable", blob: expect.any(String) } },
    ])
    await snapshots.restore(s1.id, { session })
    expect(statSync(join(ws, "run.sh")).mode & 0o111).toBe(0)
    await snapshots.restore(s2.id, { session })
    expect(statSync(join(ws, "run.sh")).mode & 0o100).toBe(0o100)
  })
})

describe("diff", () => {
  test("statuses, unified patches, binary files and the size bounds", async () => {
    const ws = tempDir("diff")
    write(ws, { "keep.txt": "same\n", "edit.txt": "one\ntwo\nthree\n", "gone.txt": "bye\n", "kind.txt": "file\n", "bin.dat": "x" })
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    sh(ws, "printf 'one\\n2\\nthree\\n' > edit.txt && rm gone.txt && rm kind.txt && ln -s keep.txt kind.txt && printf '\\0\\1\\2' > bin.dat && seq 1 5000 > long.txt")
    const s2 = await snapshots.take({ session })

    const changes = await snapshots.diff(s1.id, s2.id, { patch: { maxFileBytes: 1000, maxTotalBytes: 100_000 } })
    expect(changes.map((change) => [change.path, change.status, change.patch?.kind])).toEqual([
      ["bin.dat", "modified", "binary"],
      ["edit.txt", "modified", "text"],
      ["gone.txt", "deleted", "text"],
      ["kind.txt", "type_changed", "text"],
      ["long.txt", "added", "text"],
    ])
    const byPath = Object.fromEntries(changes.map((change) => [change.path, change.patch]))
    expect(byPath["edit.txt"]).toEqual({ kind: "text", truncated: false, text: expect.stringContaining("@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n") })
    expect(byPath["kind.txt"]).toMatchObject({ kind: "text", text: expect.stringContaining("new file mode 120000") })
    const long = byPath["long.txt"]
    if (long?.kind !== "text") throw new Error("expected text")
    expect(long.truncated).toBe(true)
    expect(long.text.length).toBeLessThanOrEqual(1000)
    expect(long.text.endsWith("\n")).toBe(true)

    const tight = await snapshots.diff(s1.id, s2.id, { patch: { maxTotalBytes: 400 } })
    expect(tight.map((change) => change.patch?.kind)).toContain("omitted")
    expect(await snapshots.diff(s1.id, s2.id)).toHaveLength(5)
    expect(await snapshots.changedFiles(s1.id, s2.id)).toEqual(["bin.dat", "edit.txt", "gone.txt", "kind.txt", "long.txt"])
    expect(await snapshots.changedFiles(s2.id, s2.id)).toEqual([])
  })

  test("ids are validated before they reach git", async () => {
    const snapshots = await open(tempDir("ids"))
    await expect(snapshots.diff("--output=/tmp/x" as SnapshotId, EMPTY_TREE as SnapshotId)).rejects.toThrow(SnapshotError)
    await expect(snapshots.restore("0".repeat(40) as SnapshotId, { session })).rejects.toThrow("is not a snapshot")
  })
})

describe("restore", () => {
  test("ignored files are never deleted, even ones captured before they were ignored", async () => {
    const ws = tempDir("ignored")
    write(ws, { ".gitignore": "node_modules/\ndist/\n", "src/a.ts": "a\n" })
    const snapshots = await open(ws)
    const s0 = await snapshots.take({ session })
    write(ws, { "node_modules/pkg/index.js": "pkg\n", "dist/out.js": "out\n", "src/b.ts": "b\n", "trace.log": "trace\n" })
    await snapshots.take({ session })
    sh(ws, "echo '*.log' >> .gitignore")
    const restored = await snapshots.restore(s0.id, { session })
    expect(restored.changes.map((change) => change.path).sort()).toEqual([".gitignore", "src/b.ts"])
    expect(restored.kept).toEqual([{ path: "trace.log", reason: "ignored" }])
    expect(Object.keys(listing(ws)).sort()).toEqual([".gitignore", "dist/", "dist/out.js", "node_modules/", "node_modules/pkg/", "node_modules/pkg/index.js", "src/", "src/a.ts", "trace.log"])
  })

  test("selected paths only, with a dry run first; a path outside the workspace is refused", async () => {
    const ws = tempDir("select")
    write(ws, { "a.txt": "a1\n", "b.txt": "b1\n", "dir/c.txt": "c1\n", "dir/d.txt": "d1\n" })
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    sh(ws, "echo a2 > a.txt && echo b2 > b.txt && echo c2 > dir/c.txt && rm dir/d.txt && echo e > dir/e.txt")
    const dry = await snapshots.restore(s1.id, { session, paths: ["a.txt", "dir"], dryRun: true })
    expect(dry.kind).toBe("dry_run")
    expect(dry.changes.map((change) => [change.path, change.status])).toEqual([
      ["a.txt", "modified"],
      ["dir/c.txt", "modified"],
      ["dir/d.txt", "added"],
      ["dir/e.txt", "deleted"],
    ])
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("a2\n")

    const done = await snapshots.restore(s1.id, { session, paths: ["a.txt", join(ws, "dir")] })
    expect(done.changes).toEqual(dry.changes)
    expect(["a.txt", "b.txt", "dir/c.txt", "dir/d.txt"].map((path) => readFileSync(join(ws, path), "utf8"))).toEqual(["a1\n", "b2\n", "c1\n", "d1\n"])
    expect(existsSync(join(ws, "dir/e.txt"))).toBe(false)
    await expect(snapshots.restore(s1.id, { session, paths: ["../elsewhere"] })).rejects.toThrow("outside the workspace")
  })

  test("a restore can be undone with the snapshot it returns", async () => {
    const ws = tempDir("undo")
    write(ws, { "a.txt": "v1\n" })
    const snapshots = await open(ws)
    const s1 = await snapshots.take({ session })
    sh(ws, "echo v2 > a.txt && echo extra > extra.txt && chmod +x a.txt")
    const edited = listing(ws)
    const restored = await snapshots.restore(s1.id, { session })
    expect(Object.keys(listing(ws))).toEqual(["a.txt"])
    const undone = await snapshots.restore(restored.before, { session })
    expect(undone.kind).toBe("restored")
    expect(listing(ws)).toEqual(edited)
  })

  test("an uncaptured file where the snapshot has a file is left alone and reported; a directory of captured files is replaced", async () => {
    const ws = tempDir("in-the-way")
    write(ws, { "x.txt": "captured\n", "y.txt": "y1\n", "d": "d was a file\n" })
    const snapshots = await open(ws)
    const s0 = await snapshots.take({ session })
    sh(ws, "rm x.txt d && mkdir d && echo inner > d/inner.txt && echo y2 > y.txt")
    await snapshots.take({ session })
    // x.txt comes back, but as an ignored (so uncaptured) file: git would overwrite it and the overwrite could not be undone.
    sh(ws, "echo x.txt > .gitignore && echo precious > x.txt")
    const dry = await snapshots.restore(s0.id, { session, dryRun: true })
    expect(dry.kept).toEqual([{ path: "x.txt", reason: "not_captured" }])
    const result = await snapshots.restore(s0.id, { session })
    expect(result.kind).toBe("restored")
    expect(result.changes.map((change) => [change.path, change.status]).sort()).toEqual([
      [".gitignore", "deleted"],
      ["d", "added"],
      ["d/inner.txt", "deleted"],
      ["y.txt", "modified"],
    ])
    expect(["x.txt", "y.txt", "d"].map((path) => readFileSync(join(ws, path), "utf8"))).toEqual(["precious\n", "y1\n", "d was a file\n"])
  })
})

describe("retention", () => {
  test("pruning one session's snapshots leaves another session's intact and collects the rest", async () => {
    const ws = tempDir("retention")
    write(ws, { "shared.txt": "shared\n" })
    const snapshots = await open(ws)
    const shared = await snapshots.take({ session: "A" })
    write(ws, { "only-a.txt": "a only\n" })
    const aOnly = await snapshots.take({ session: "A" })
    const blobA = (await snapshots.diff(shared.id, aOnly.id))[0]!.after!.blob
    sh(ws, "rm only-a.txt && echo b > only-b.txt")
    const b1 = await snapshots.take({ session: "B" })
    write(ws, { "b2.txt": "b2\n" })
    const b2 = await snapshots.take({ session: "B" })
    expect(privateGit(snapshots.gitDir, ["cat-file", "-e", blobA]).exitCode).toBe(0)

    const dropped = await snapshots.prune({ session: "A", keepLast: 0, graceSeconds: 0 })
    expect(dropped.removed.map((ref) => ref.id)).toEqual([aOnly.id, shared.id])
    expect((await snapshots.list()).map((ref) => ref.session)).toEqual(["B", "B"])
    // A's objects are gone (the private index holds B's latest state only); B's snapshots still work.
    expect(privateGit(snapshots.gitDir, ["cat-file", "-e", blobA]).exitCode).not.toBe(0)
    expect(privateGit(snapshots.gitDir, ["cat-file", "-e", shared.id]).exitCode).not.toBe(0)
    expect(await snapshots.changedFiles(b1.id, b2.id)).toEqual(["b2.txt"])
    await snapshots.restore(b1.id, { session: "B" })
    expect(existsSync(join(ws, "b2.txt"))).toBe(false)
    expect(readFileSync(join(ws, "only-b.txt"), "utf8")).toBe("b\n")

    const now = Date.now()
    expect((await snapshots.prune({ olderThanMs: 60_000, now })).removed).toEqual([])
    expect((await snapshots.prune({ keepLast: 1 })).remaining).toBe(1)
    expect((await snapshots.prune({ olderThanMs: 0, now: now + 1000 })).remaining).toBe(0)
  })
})

describe("availability", () => {
  test("no git, an old git, and a missing workspace are typed results", async () => {
    const ws = tempDir("avail")
    expect(await openSnapshots(ws, { gitPath: join(ws, "no-such-git"), dataDir: tempDir("data") })).toMatchObject({ kind: "unavailable", reason: "git_not_found" })
    const fake = join(ws, "old-git")
    writeFileSync(fake, "#!/bin/sh\necho 'git version 2.20.1'\n")
    chmodSync(fake, 0o755)
    expect(await openSnapshots(ws, { gitPath: fake, dataDir: tempDir("data") })).toMatchObject({ kind: "unavailable", reason: "git_too_old" })
    expect(await openSnapshots(join(ws, "missing"), { dataDir: tempDir("data") })).toMatchObject({ kind: "unavailable", reason: "workspace_invalid" })
  })
})
