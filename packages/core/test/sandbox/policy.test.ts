import { describe, expect, test } from "bun:test"
import { brand } from "../../src/brand.ts"
import { defaultHiddenPaths, defaultPolicy, filterEnv, isCredentialName, sandboxCommand } from "../../src/sandbox/index.ts"

describe("defaultPolicy", () => {
  test("workspace writable, rest readable, network off, credentials stripped", () => {
    expect(defaultPolicy({ workspace: "/work", home: "/h", env: {}, platform: "linux", uid: 1000 })).toMatchObject({
      writableRoots: ["/work"],
      readRest: true,
      network: { mode: "off" },
      env: { mode: "deny" },
    })
  })

  test("hides credential stores and the harness's own directories, named from brand", () => {
    const linux = defaultHiddenPaths({ home: "/h", env: {}, platform: "linux", uid: 1000 })
    expect(linux).toEqual(
      expect.arrayContaining([
        "/h/.ssh",
        "/h/.aws",
        "/h/.config/gcloud",
        "/h/.netrc",
        `/h/.local/share/${brand.directory}`,
        `/h/.config/${brand.directory}`,
        "/run/user/1000",
        "/var/run/docker.sock",
      ]),
    )
    const xdg = defaultHiddenPaths({ home: "/h", env: { XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/conf", XDG_RUNTIME_DIR: "/rt" }, platform: "linux" })
    expect(xdg).toEqual(expect.arrayContaining([`/data/${brand.directory}`, `/conf/${brand.directory}`, "/rt"]))
    const mac = defaultHiddenPaths({ home: "/Users/u", env: {}, platform: "darwin" })
    expect(mac).toEqual(expect.arrayContaining(["/Users/u/.ssh", "/Users/u/Library/Keychains", `/Users/u/Library/Application Support/${brand.directory}`]))
    expect(mac.some((path) => path.startsWith("/run/user"))).toBe(false)
  })
})

describe("environment", () => {
  test("credential heuristic", () => {
    const stripped = [
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "openai_api_key",
      "ANTHROPIC_BASE_URL",
      "AWS_REGION",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "AZURE_CLIENT_ID",
      "HF_TOKEN",
      "DB_PASSWORD",
      "CLIENT_SECRET",
      "SSH_AUTH_SOCK",
      "NPM_CONFIG__AUTH",
      "GITHUB_PAT",
      "DATABASE_URL",
      "DOCKER_HOST",
    ]
    const kept = ["PATH", "HOME", "LANG", "TERM", "GIT_AUTHOR_NAME", "EDITOR", "PWD", "SHELL", "NODE_ENV", "XDG_CONFIG_HOME", "PATHEXT"]
    expect(stripped.filter((name) => !isCredentialName(name))).toEqual([])
    expect(kept.filter(isCredentialName)).toEqual([])
  })

  test("deny mode strips credentials and named variables; keep exempts from the heuristic", () => {
    const env = { PATH: "/bin", GITHUB_TOKEN: "t", MONKEY: "banana", NOISY: "1", UNSET: undefined }
    expect(filterEnv(env, { mode: "deny" })).toEqual({ PATH: "/bin", NOISY: "1" })
    expect(filterEnv(env, { mode: "deny", names: ["NOISY"], keep: ["MONKEY"] })).toEqual({ PATH: "/bin", MONKEY: "banana" })
    expect(filterEnv(env, { mode: "deny", stripCredentials: false })).toEqual({ PATH: "/bin", GITHUB_TOKEN: "t", MONKEY: "banana", NOISY: "1" })
  })

  test("allow mode passes exactly the named variables", () => {
    expect(filterEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "t" }, { mode: "allow", names: ["PATH", "GITHUB_TOKEN", "MISSING"] })).toEqual({ PATH: "/bin", GITHUB_TOKEN: "t" })
  })
})

describe("sandboxCommand", () => {
  test("relative paths in a policy are rejected", () => {
    expect(() => sandboxCommand({ ...defaultPolicy({ workspace: "work" }), hiddenPaths: [] }, { argv: ["true"], cwd: "/" })).toThrow("must be absolute: work")
  })

  test("an unavailable backend is returned as a typed result, not thrown", () => {
    const result = sandboxCommand(defaultPolicy({ workspace: "/w" }), { argv: ["true"], cwd: "/w" }, {
      detection: { available: false, backend: "bwrap", reason: "AppArmor blocks it", remedy: "add a profile", detail: "setting up uid map: Permission denied" },
    })
    expect(result).toEqual({ kind: "unavailable", backend: "bwrap", reason: "AppArmor blocks it", remedy: "add a profile", detail: "setting up uid map: Permission denied" })
  })
})
