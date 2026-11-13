# Windlass

A coding agent for the terminal: you describe a change, and it reads your code, edits files and runs commands in
your project until the change is done. It is one program, `windlass` (`wl` for short), with a line interface, a
full-screen interface, and a server for editors (the Agent Client Protocol). It signs in with a ChatGPT plan.

## Install

```sh
npm install -g windlass-agent
windlass --version
```

This installs the executable for your machine (Linux or macOS, x64 or arm64; Linux with glibc) from a package of
its own, `windlass-agent-<os>-<arch>`, which npm picks as an optional dependency. Nothing else is needed at run time:
not Bun, and Node only to start it. If optional dependencies are left out (`--omit=optional`), `windlass` says which
package is missing.

To run you also need `git`, GNU `env` (coreutils) and, on Linux, `bwrap` (bubblewrap) for the sandbox.

## Use

```sh
windlass login            # sign in with your ChatGPT plan
windlass --demo list      # scripted sessions: no model, no sign-in
windlass tui              # the full-screen interface, in your project's folder
windlass "fix the failing test"
```

The [README](https://github.com/parthg1901/windlass#readme) and the
[user guide](https://github.com/parthg1901/windlass/blob/main/docs/user-guide.md) have the rest. MIT licence.
