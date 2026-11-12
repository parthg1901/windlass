# Troubleshooting

The errors you are likely to meet, with the message the program prints and what to do. Each message below was
produced by the built program unless it is marked otherwise; `<...>` stands for what differs from run to run.

## Not signed in

```
lh: not signed in; run `lh login` to sign in with ChatGPT, then try again
```

Exit code 1. `lh --models` says the same (`not signed in, so the models cannot be listed (they come from your ChatGPT
plan); ...`), since the list comes from your plan. What calls no model works signed out: `lh --list-sessions`,
`lh fork`, and `lh --demo`. Sign in, then check:

```sh
lh login
lh login status
```

`lh login status` prints `not signed in; run \`lh login\`` (exit code 1) when there is no saved sign-in, and says
so when a sign-in was started but not finished: run `lh login finish` and paste the address the browser ended on.

In the full-screen interface (`lh tui`) the conversation says `✗ not signed in` and how to go on: run `lh login` in
another terminal, then type `/reconnect` in the interface, which picks the new sign-in up without a restart. Leaving
before that exits with code 1 and prints the same sentence as the line interface.

## The sign-in expired or was revoked

The access token lasts an hour and is refreshed by itself; the refresh token lasts 30 days and is renewed on every
refresh. When the refresh is refused (the sign-in was revoked, or not used for 30 days), a run fails at the start:

```
lh: token request failed (400 invalid_grant): <OpenAI's description>; run `lh login` to sign in with ChatGPT, then try again
```

*Reproduced against the test suite's fake authorization server; OpenAI's own description text was not seen.* Run
`lh login` again; your sessions are kept. `lh login status` shows `access token: expired <n> minutes ago` while the
refresh has not happened yet; that alone is not a problem.

If the browser's page says the sign-in failed, the terminal says why, for example:

```
lh: sign-in failed: The callback does not belong to the sign-in that is in progress. (state_mismatch)
```

That address belongs to an older `lh login`. Start again and paste the address from the newest one.

## A session in use by another process

```
lh: session ses_<id> is in use by another lh process (pid <pid>): wait for it to finish or stop it (kill <pid>), or start a new session
```

Exit code 1, also from the full-screen interface when you leave it without having opened a session. One session can
be open in one process at a time (another terminal, an editor, the full-screen interface). Wait for that process, stop it, or start a new session (`lh` without `-c` or `--session`). A process that
died holds nothing: its sessions open normally (see "A crashed session" below).

## The sandbox is unavailable

When commands cannot be sandboxed, the first command of a session says so, and in the default mode every command
asks first; with nobody there to answer (a one-shot run) it is refused:

```
⚠ no sandbox:
  Commands cannot be sandboxed on this machine: bubblewrap (bwrap) is not
  installed.
  Install bubblewrap, for example `sudo apt install bubblewrap` or `sudo dnf
  install bubblewrap`.
  Until then every command asks before it runs, and with nobody there to ask it
  is refused.
▸ shell echo from-the-sandbox
○ not run: needs approval for running a command without the sandbox; nobody is
  here to give it, so it was refused (--unattended deny)
```

Install bubblewrap, or run interactively and approve commands one by one, or (in a container with nothing to lose)
use `--approval full`. `sh scripts/install.sh --check` runs the same check the program does.

**Ubuntu 24.04 and later (AppArmor).** bubblewrap is installed but the kernel refuses it the namespaces it needs. The
second line of the notice is then *(not triggered on the machine these docs were checked on, whose bwrap works; this
is the program's text)*:

```
  Commands cannot be sandboxed on this machine: AppArmor blocks unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and no AppArmor profile grants them to /usr/bin/bwrap.
```

followed by what to do: an administrator adds an AppArmor profile for bwrap, for example `/etc/apparmor.d/bwrap`
containing `abi <abi/4.0>, include <tunables/global> profile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }`,
then runs `sudo apparmor_parser -r /etc/apparmor.d/bwrap`. The weaker system-wide alternative is
`sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`. Other refusals have their own lines (user namespaces
switched off, a container's seccomp policy), each with its remedy.

## A command that needs the network

Sandboxed commands have no network. The command fails, and its result ends with a note for the agent:

```
▸ shell curl -sS -m 5 https://example.com -o /dev/null
  ✗ exit 6 ⊡ · 79ms
    curl: (6) Could not resolve host: example.com
    [sandbox] This command ran in the sandbox (no network, and writes only insi…
```

The agent may then ask to run it with network access. Interactively you are asked; in a one-shot run it is refused:

```
○ not run: needs approval for network access for this command; nobody is here to
  give it, so it was refused (--unattended deny)
```

Run it interactively and answer `a` (once) or `s` (for this session), or run the command yourself. A command that
hides its own failure (`curl -s ... | sed ...`) gets no note; tell the agent the sandbox has no network.

## The plan's usage limit is reached

The turn fails with the provider's message, for example:

```
✗ failed (usage_limit): Usage limit reached; it resets in 3 hours.
```

Exit code 1. *This text is from the scripted demo (`lh --demo a-non-retryable-error-usage-limit`); a real one
carries ChatGPT's own wording.* It is not retried. Wait until the limit resets, or use a smaller model
(`lh --models`); the session can be continued later with `lh -c`.

## The server child fails to start

`lh` and `lh tui` start `lh acp` as a child process. If it dies before it is ready:

```
lh: the engine could not start: <what it said> (its process exited with code 1)
```

When the process said nothing: `lh: the engine process exited with code 1 before it was ready`. If it does not answer in time:

```
lh: the engine process did not start within <n> s; giving up
```

On a slow or busy machine raise the limit, for example `LH_ENGINE_START_TIMEOUT_MS=60000`. `lh --engine direct`
runs without the child process, which tells whether the problem is the child or the session.

## A crashed session

When a process dies in the middle of a turn (killed, a crash, a power cut), nothing is lost: the session's log is
written as it goes. The next time the session is opened it resumes where it stopped:

```
↻ resuming after the previous process stopped unexpectedly
```

Open it with `lh -c` (the most recent session here) or `lh --session <id>`. The interrupted step is closed as
crashed, the agent is told its response was cut short, and a fresh step runs. A tool call that was running when the
process died is never run again behind your back: a read is settled as failed and safe to repeat, a command as
"effect unknown" (it may have run), and the agent is told which, so it checks before going on.

## A prefix diagnostic

```
⚠ prompt cache:
  session ses_<id>: the next request does not extend the previous one (<kind> block <n> <change>) and no event allows that
```

*Not triggered: it means a bug in the harness, and none is known.* Each request is meant to extend the previous one
so that the provider's prompt cache is reused; this says one did not, without a reason in the session's log. The
work goes on, only more slowly and with more tokens. Please report it with the session ID.

## Something else

- `lh --help` lists every option and exit code; [user-guide.md](user-guide.md) explains them.
- `LH_ACP_LOG=debug` makes the server child log what it does on standard error.
- A configuration file with a mistake fails the turn before anything is sent, and names the file and the key:

  ```
  ✗ failed
    The configuration could not be loaded:
    /home/me/project/.light-harness/config.json: chekcs: unknown key
    "chekcs" (did you mean "checks"?); known keys: $schema, model, effort, checks,
    verify, approval
  ```
