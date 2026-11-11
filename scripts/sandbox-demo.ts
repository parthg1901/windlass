/**
 * Runs a few commands under the default sandbox policy in a temporary
 * workspace and prints what was allowed and what was blocked. The "home" is a
 * fake one holding fake credentials, so nothing real is read even if a check
 * misbehaves; the host-service checks (systemd user manager, Docker socket)
 * use the real ones and only ever run `true` or a ping.
 *
 *   bun scripts/sandbox-demo.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { type SandboxPolicy, defaultPolicy, detectSandbox, sandboxCommand } from "../packages/core/src/sandbox/index.ts"

const detection = detectSandbox()
if (!detection.available) {
  console.log(`Sandbox unavailable: ${detection.reason}`)
  if (detection.remedy) console.log(`\nTo fix:\n${detection.remedy}`)
  if (detection.detail) console.log(`\nProbe output: ${detection.detail}`)
  process.exit(1)
}
console.log(`Backend: ${detection.backend}${detection.backend === "bwrap" ? ` (${detection.bwrapPath}, graceful SIGTERM: ${detection.envPath ? "yes" : "no"}, Landlock in kernel: ${detection.landlock ? "yes" : "no"})` : ""}`)

// /var/tmp rather than /tmp: inside the sandbox /tmp is private, and the "outside" directory should be visible but read-only.
const root = mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : "/tmp", `${brand.directory}-sandbox-demo-`))
const workspace = join(root, "workspace")
const outside = join(root, "outside")
const home = join(root, "home")
mkdirSync(workspace)
mkdirSync(outside)
mkdirSync(join(home, ".ssh"), { recursive: true })
mkdirSync(join(home, ".local", "share", brand.directory), { recursive: true })
writeFileSync(join(home, ".ssh", "id_ed25519"), "-----BEGIN FAKE PRIVATE KEY-----\n")
writeFileSync(join(home, ".local", "share", brand.directory, "auth.json"), '{"access_token":"fake"}\n')
symlinkSync("../outside", join(workspace, "escape"))

const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (socket) => void socket.end("hi\n"), data: () => {} } })
const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", GITHUB_TOKEN: "ghp_fake", OPENAI_API_KEY: "sk-fake", PROJECT_MODE: "dev" }
const offline = defaultPolicy({ workspace, home, env: {} })
const online: SandboxPolicy = { ...offline, network: { mode: "on" } }
const uid = process.getuid?.() ?? 0

const checks: Array<{ label: string; command: string; expect: "allowed" | "blocked"; policy?: SandboxPolicy }> = [
  { label: "write a file in the workspace", command: "echo built > out.txt", expect: "allowed" },
  { label: "write to a directory next to the workspace", command: `echo x > ${outside}/pwned`, expect: "blocked" },
  { label: "write in the home directory", command: `touch ${home}/.bashrc`, expect: "blocked" },
  { label: "write outside through a symlink in the workspace", command: "echo x > escape/pwned", expect: "blocked" },
  { label: "write to /tmp (private, discarded afterwards)", command: "echo x > /tmp/scratch", expect: "allowed" },
  { label: "read a system file (/etc/passwd)", command: "head -c 30 /etc/passwd >/dev/null", expect: "allowed" },
  { label: "read ~/.ssh/id_ed25519", command: `cat ${home}/.ssh/id_ed25519`, expect: "blocked" },
  { label: `read the harness's own auth.json`, command: `cat ${home}/.local/share/${brand.directory}/auth.json`, expect: "blocked" },
  { label: "see GITHUB_TOKEN / OPENAI_API_KEY", command: 'test -n "$GITHUB_TOKEN$OPENAI_API_KEY"', expect: "blocked" },
  { label: "see an ordinary variable (PROJECT_MODE)", command: 'test "$PROJECT_MODE" = dev', expect: "allowed" },
  { label: "TCP to a listener on the host (network off)", command: `exec 3<>/dev/tcp/127.0.0.1/${listener.port}`, expect: "blocked" },
  { label: "DNS lookup of example.com (network off)", command: "getent hosts example.com", expect: "blocked" },
  { label: "TCP to the same listener (network on)", command: `exec 3<>/dev/tcp/127.0.0.1/${listener.port}`, expect: "allowed", policy: online },
  { label: "start a unit with systemd-run --user", command: `XDG_RUNTIME_DIR=/run/user/${uid} systemd-run --user --wait -q true`, expect: "blocked" },
  { label: "talk to the Docker socket", command: "curl -sf -m 3 --unix-socket /var/run/docker.sock http://docker/_ping", expect: "blocked" },
]

let surprises = 0
console.log(`Workspace: ${workspace}\n`)
for (const check of checks) {
  const plan = sandboxCommand(check.policy ?? offline, { shell: check.command, shellPath: "/bin/bash", cwd: workspace }, { env })
  if (plan.kind !== "ready") throw new Error(plan.reason)
  const child = Bun.spawn(plan.argv, { env: plan.env, cwd: plan.cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const outcome = code === 0 ? "allowed" : "blocked"
  if (outcome !== check.expect) surprises += 1
  const evidence = (stderr || stdout).trim().split("\n")[0]?.replace(root, "<demo>") ?? ""
  const mark = outcome === "allowed" ? "ALLOWED" : "BLOCKED"
  console.log(`${outcome === check.expect ? "  " : "!!"} ${mark}  ${check.label}${evidence ? `\n            ${evidence}` : ""}`)
}
console.log(`\nOn the host afterwards: out.txt in workspace: ${existsSync(join(workspace, "out.txt"))}, pwned outside: ${existsSync(join(outside, "pwned"))}, /tmp/scratch: ${existsSync("/tmp/scratch")}`)
console.log(surprises === 0 ? "Every check behaved as the policy says." : `${surprises} check(s) did not match the policy (marked !!).`)

listener.stop(true)
rmSync(root, { recursive: true, force: true })
process.exit(surprises === 0 ? 0 : 1)
