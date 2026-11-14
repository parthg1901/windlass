# sandbox

Runs a shell command under an OS sandbox. `sandboxCommand(policy, command)` returns the argv, env and cwd to spawn, or `{ kind: "unavailable", reason, remedy }`. It never spawns anything itself. `detectSandbox()` is cached and costs one probe of about 10 ms on Linux.

## Threat model

It stops a command from:
- writing outside the writable roots and the temp directory, including through `..`, absolute paths, and symlinks (old ones or ones it creates);
- reading or listing hidden paths: SSH, GPG, cloud and AI-tool credentials, browser profiles, the harness's own data and config directories, and the file an access token is handed in through (`auth/handed-in.ts`), wherever it is;
- using the network when it is `off`: TCP, UDP and DNS, including loopback to the host and abstract unix sockets;
- receiving credential-looking environment variables;
- on Linux, seeing or signalling host processes, and outliving a kill of its process group.

The default policy also hides `/run/user/<uid>` and the Docker, Podman, containerd, LXD and Incus sockets. Without that, `systemd-run --user` and `curl --unix-socket /var/run/docker.sock` both escaped here with network off. A unix socket on the filesystem stays reachable through a read-only mount.

It does not stop:
- reading any file that is not hidden: source, dotfiles, `/etc`;
- anything at all on the network when it is `on`, which is unrestricted;
- other filesystem unix sockets that are not on the hidden list (Linux);
- reading a hidden file (not a hidden directory) that is replaced by a rename while the command runs (Linux): the file is covered by a mount, and the rename takes the mount away for sandboxes already running. A hidden directory stays hidden whatever is renamed inside it;
- use of CPU, memory or disk (a private `/tmp` is RAM-backed tmpfs);
- kernel exploits;
- writes inside the workspace that run later outside the sandbox: `.git/hooks`, `package.json` scripts, editor task files.

## Platforms

| | Backend | Status |
|---|---|---|
| Linux | bubblewrap (`bwrap`) | Tested on Ubuntu 24.04 aarch64. Needs unprivileged user namespaces; on Ubuntu 23.10+ an AppArmor profile must grant `userns` to bwrap. Detection names the exact fix. |
| macOS | `sandbox-exec` + generated Seatbelt profile | **Untested on a real Mac.** The profile text is unit-tested. It denies by default, so a missing allowance breaks a command rather than opening a hole. |
| other | none | `unavailable` |

When bwrap cannot create namespaces, nothing else works without privileges. Landlock (enabled on this kernel) has to be applied between fork and exec of the child, which JavaScript cannot do. It needs a helper binary that applies the ruleset and then execs the command, and it only restricts files and TCP: no DNS, UDP or unix-socket isolation.

## How the shell tool uses it

1. At start-up, call `detectSandbox()`. If it is unavailable, show `reason` and `remedy` once and decide whether to run unsandboxed with approval.
2. Per command: `plan = sandboxCommand(defaultPolicy({ workspace, tempRoot }), { shell: input.command, shellPath, cwd })`, then `Bun.spawn(plan.argv, { env: { ...plan.env, PAGER: "cat", … }, cwd: plan.cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })`. `detached` is required.
3. Output streams through unchanged: bwrap and sandbox-exec pass the file descriptors straight to the command.
4. Stopping is unchanged: SIGTERM to `-pid`, grace period, SIGKILL to `-pid`. On Linux the sandbox's supervisor ignores SIGTERM (`plan.gracefulTermination`), so the command gets its full grace period. When the command exits, or the group is SIGKILLed, the kernel kills everything left in the sandbox, including processes that called `setsid`.
5. A command killed by a signal inside bwrap is reported as exit code `128+n`, not as `signalCode`. bwrap's own setup failures exit 1 with `bwrap: …` on stderr.
6. If a command fails with `Read-only file system`, `Permission denied` or a connection error, offer an escalation: re-plan with the extra writable root or `network: { mode: "on" }`, after approval.
