import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { type PathContext, isWithin, pathFact, realPath } from "../../src/approval/index.ts"
import { resolvePath } from "../../src/tools/common.ts"

/** A file system that is only links: every other path is a plain file or directory, or does not exist. */
function links(map: Record<string, string>) {
  return (path: string) => map[path] ?? null
}

function context(map: Record<string, string> = {}, overrides: Partial<PathContext> = {}): PathContext {
  return { cwd: "/w", workspace: "/w", home: "/h", hiddenPaths: ["/h/.ssh", "/h/.local/share/x"], readlink: links(map), ...overrides }
}

describe("pathFact", () => {
  test("inside, with `..` that stays inside, and a file that does not exist yet", () => {
    expect(pathFact("src/a.ts", context())).toEqual({ given: "src/a.ts", real: "/w/src/a.ts", place: "workspace", relative: "src/a.ts" })
    expect(pathFact("src/../b.ts", context()).real).toBe("/w/b.ts")
    expect(pathFact("new/dir/c.ts", context()).place).toBe("workspace")
  })

  test("`..` that leaves the workspace, and absolute paths", () => {
    expect(pathFact("../etc/passwd", context())).toMatchObject({ real: "/etc/passwd", place: "outside", relative: null })
    expect(pathFact("/w/../../etc", context()).real).toBe("/etc")
    expect(pathFact("/wx/a", context()).place).toBe("outside")
  })

  test("a link inside the workspace that points outside", () => {
    expect(pathFact("out/key", context({ "/w/out": "/o" }))).toMatchObject({ real: "/o/key", place: "outside" })
    expect(pathFact("rel/key", context({ "/w/rel": "../o" }))).toMatchObject({ real: "/o/key", place: "outside" })
  })

  test("a link chain that ends inside, and a link outside that points in", () => {
    const fs = context({ "/w/a": "b", "/w/b": "/tmp/c", "/tmp/c": "/w/real" })
    expect(pathFact("a/file", fs)).toMatchObject({ real: "/w/real/file", place: "workspace", relative: "real/file" })
    expect(pathFact("/tmp/in/x", context({ "/tmp/in": "/w/sub" }))).toMatchObject({ real: "/w/sub/x", place: "workspace" })
  })

  test("`..` is removed before links are followed, as the file tools open the path", () => {
    // resolvePath("/w", "out/../x") is "/w/x"; the tool never visits /o.
    expect(resolvePath("/w", "out/../x")).toBe("/w/x")
    expect(pathFact("out/../x", context({ "/w/out": "/o/deep" })).real).toBe("/w/x")
    // A `..` inside a link target is applied after the link, like the kernel does.
    expect(pathFact("up/x", context({ "/w/up": "/o/deep/.." })).real).toBe("/o/x")
  })

  test("a link loop cannot be resolved and counts as outside", () => {
    expect(pathFact("loop/x", context({ "/w/loop": "/w/loop2", "/w/loop2": "/w/loop" }))).toEqual({
      given: "loop/x",
      real: null,
      place: "outside",
      relative: null,
    })
  })

  test("hidden paths, reached directly, through a link, or when the hidden path is itself a link", () => {
    expect(pathFact("~/.ssh/id_ed25519", context()).place).toBe("hidden")
    expect(pathFact("keys/id", context({ "/w/keys": "/h/.ssh" }))).toMatchObject({ real: "/h/.ssh/id", place: "hidden" })
    expect(pathFact("/secure/ssh/id", context({ "/h/.ssh": "/secure/ssh" })).place).toBe("hidden")
    expect(pathFact("~/.sshx", context()).place).toBe("outside")
  })

  test("protected directories inside the workspace", () => {
    expect(pathFact(".git/hooks/pre-commit", context()).place).toBe("protected")
    expect(pathFact(`.${brand.directory}/config.json`, context()).place).toBe("protected")
    expect(pathFact(".gitignore", context()).place).toBe("workspace")
    expect(pathFact("hooks/pre-commit", context({ "/w/hooks": ".git/hooks" })).place).toBe("protected")
  })

  test("a workspace reached through a link", () => {
    const fs = context({ "/link": "/w" }, { cwd: "/link", workspace: "/link" })
    expect(pathFact("a.ts", fs)).toMatchObject({ real: "/w/a.ts", place: "workspace", relative: "a.ts" })
  })
})

describe("isWithin", () => {
  test("by whole components", () => {
    expect(isWithin("/w", "/w")).toBe(true)
    expect(isWithin("/w", "/w/a")).toBe(true)
    expect(isWithin("/w", "/wx")).toBe(false)
    expect(isWithin("/", "/anything")).toBe(true)
  })
})

describe("realPath on a real file system", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "approval-paths-")))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const readlink = (path: string) => {
    try {
      return readlinkSync(path)
    } catch {
      return null
    }
  }

  test("agrees with realpath for links in parents, relative targets and chains", () => {
    mkdirSync(join(root, "ws/src"), { recursive: true })
    mkdirSync(join(root, "outside/deep"), { recursive: true })
    writeFileSync(join(root, "outside/deep/secret"), "x")
    symlinkSync(join(root, "outside"), join(root, "ws/out"))
    symlinkSync("../../outside/deep", join(root, "ws/src/rel"))
    symlinkSync("out", join(root, "ws/chain"))
    for (const path of ["ws/out/deep/secret", "ws/src/rel/secret", "ws/chain/deep", "ws/src"])
      expect(realPath(join(root, path), readlink)).toBe(realpathSync(join(root, path)))
    const fact = pathFact("src/rel/secret", { cwd: join(root, "ws"), workspace: join(root, "ws"), home: "/nonexistent", hiddenPaths: [], readlink })
    expect(fact).toMatchObject({ real: join(root, "outside/deep/secret"), place: "outside" })
  })
})
