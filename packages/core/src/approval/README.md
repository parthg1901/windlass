# approval

Decides, for each tool call, whether it runs, runs in the sandbox, asks the user, or is denied. The decision comes from the tool's effect class, facts about its path arguments, the sandbox, the session's taint, remembered approvals, and whether a person is there to answer. It never reads a shell command's text to guess what it does. Everything here is pure; the integration does the lookups and the writes.

## Modes

| | `ask` | `auto` (default) | `full` (opt-in) |
|---|---|---|---|
| Read a file | runs | runs | runs |
| Read a credential store (`~/.ssh`, …) | asks, once only | asks, once only | runs |
| Edit a workspace file | asks | runs | runs |
| Edit in `.git/` or `.<brand.directory>/` | asks | asks | runs |
| Edit outside the workspace | asks | asks | runs |
| Edit a credential store or the harness's data | refused | refused | runs |
| Shell command, sandbox available | asks, then runs sandboxed | runs sandboxed | runs unsandboxed |
| Shell command, no sandbox on this machine | asks, runs unsandboxed | asks, runs unsandboxed | runs |
| Command asking for network or a writable directory | asks | asks | runs |
| Network tool (web fetch) | asks | asks | runs |
| MCP tool (any declared effect) | asks | asks | runs |
| **After untrusted content:** network and MCP tools, command network, unsandboxed commands | ask; earlier approvals for them stop applying | same | commands run sandboxed; the rest ask |

"Sandboxed" means: writes only inside the workspace and a temp directory, no network, credential stores hidden, credential variables stripped (see `../sandbox/README.md`). Without a sandbox, `auto` does not quietly become `full`: each command asks, and the question says why the sandbox is missing.

When no one is present (a script, an eval, a scheduled run), "asks" becomes a refusal the model sees (`unattended: "deny"`) or a refusal that also ends the run (`"stop"`). Nothing ever waits, and no setting turns an ask into a run; for that, pick a looser mode.

Configuration, `approval` section: `mode`, `unattended`, `taint` (`"enforce"`, or `"off"` for a throwaway container), `untrustedPaths` (workspace globs that count as untrusted, `["**"]` for a repository from someone else). A project file can only make these stricter.

## Remembering

The user can allow once, for this session, or for this project (30 days). What is remembered is a capability, shown in the question exactly as stored: network for sandboxed commands; sandboxed commands writing under one directory; file tools writing under one directory; commands without the sandbox; one network or MCP tool by name. Never a command or command prefix: whether `npm test` and `npm test; curl …` are "the same" cannot be decided without a shell parser. Network for commands and commands without the sandbox are remembered at most for the session, credential reads never. A project grant for a network or MCP tool never applies while the session is tainted, and a session grant for anything that can send data out applies then only if it was given after the taint began.

## Threat model

It stops:
- the model writing outside the workspace, into `.git` or the harness's settings, or into credential stores, without the user seeing the real path (links followed);
- a sandboxed command reaching the network or writing outside its roots unless the model asks explicitly and the user approves that one capability;
- a project configuration file loosening the user's policy;
- after the conversation has taken in web pages, MCP results or files from outside the workspace, data leaving through a tool or a command the user approved before that content arrived.

It does not stop:
- a model that is already misled from doing damage inside the workspace, or writing files that run later outside the sandbox (`package.json` scripts, editor tasks; `.git/hooks` is covered for the file tools but not for sandboxed commands, see below);
- a user approving something they should not have, or what is sent once network is approved after the taint;
- instructions in workspace files (they are trusted unless `untrustedPaths` says otherwise), or in the output of a command that read an outside file or used the network in `full` or without a sandbox: the harness cannot tell what a command read;
- anything in `full` without taint, by design; reading non-hidden files outside the workspace, which runs freely but taints;
- a link swapped in by a parallel process between the decision and the write (the check is not atomic).

## What the integration must do

1. Before each call: classify path arguments with `pathFact` (a `readlink` wrapper; pass the working directory for tools that default to it), the shell's `sandbox` argument with `escalationRequest` + `escalationFacts`, derive taint with `deriveTaint`, then `decide`. Do not start a write tool while a command runs in the same session, so a planted link cannot slip in between.
2. `run_sandboxed`: `defaultPolicy({ workspace, tempRoot, network })` plus `writableRoots`. Better: bind `.git/hooks`, `.git/config` and `.<brand.directory>/` read-only inside the sandbox (a sandbox change).
3. `ask`: send the question through the client (ACP or CLI) with its choices; on approval `stampGrants(choice.grants, seq, now)` and run as `then`. Prepend `approvedNote(note)` if the user wrote one; on refusal return `declinedMessage(note)` as the tool's error result.
4. `deny`: settle the call with `message` as an error result, never run it; on `stop`, end the run with a distinct status.
5. Record durably, per call: the decision, the path facts and escalation it was made from, and whether the command ran sandboxed and with network (`HistoryEntry` is derived from these); every answer and the grants it created; `taint_cleared` when the user clears it. Do not re-derive path facts from the disk later.
6. Store session grants in the session log, project grants in the user's data directory keyed by the project's real path, never in the repository. Forks start with no grants but inherit taint.
7. After a sandboxed command fails, append `sandboxHint(...).note` to its output before `tool.settled`.
8. Run `redact` on every tool output before it is shown or stored, with the values of the environment variables `isCredentialName` matches.
9. Add `escalationSchema` as the shell tool's `sandbox` property, merge the `approval` section with `resolveApprovalConfig` (not `mergeConfigFiles`), and show `ignored` and the sandbox's `reason`/`remedy` once.
10. Name MCP tools with their server (`server__tool`) so a grant names one server's tool.
