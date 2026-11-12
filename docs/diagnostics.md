# Diagnostics from a language server

A language server knows within a second of an edit what a test run says a minute later: this name does not exist,
that argument has the wrong type. When you configure one, `windlass` asks it about each file the agent edits and adds
what **the edit made worse** to the edit's result, as a short note the agent reads before its next step. The note
never blocks or prolongs a turn: the project's checks stay the authority. No server is built in and nothing is
installed for you. Everything on this page was run against the program with a scripted model and a scripted
language server (none of the servers named below was installed on the test machine);
`test/release/feature-docs-2.test.ts` checks the keys, limits and messages against the code.

## The smallest working example

Install a language server yourself, then name it in your own configuration file, `~/.config/windlass/config.json`:

```json
{
  "lsp": {
    "servers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "languages": { "typescript": ["**/*.ts", "**/*.tsx"] },
        "rootMarkers": ["tsconfig.json", "package.json"]
      }
    }
  }
}
```

Then work as usual. The server is started the first time the agent reads or edits a file it serves, and stopped
when the session ends. You see nothing new; the agent's `edit` and `write` results gain a note when an edit
introduced an error.

## What the agent sees

After a successful `edit` or `write` of a file a server serves, if the file now has an error it did not have
before, this follows the tool's own output:

```text
Edited math.ts: replaced 1 occurrence (line 1).

[Diagnostics from the language server "typescript" for math.ts after this edit: 1 new error]
math.ts:1:54: error E1: cannot find name 'offset' (fixture)
These are the language server's diagnostics for this file after the edit; the 1 it already had is not listed, and the project's checks remain the authority.
```

(The diagnostic line is the scripted server's; a real server's codes, messages and source name are its own.)

- **Only what the edit added.** Errors the file already had are counted in the last line, never listed. An edit
  that adds nothing, or fixes an error, gets no note at all.
- **Each line** is the server's own message with its code and source, at `<file>:<line>:<column>`.
- **Bounded.** At most `maxDiagnostics` items (10 by default) and 2,000 characters; the rest is one line, such as
  `... and 27 more new diagnostics not listed.`
- **A new file** gets its errors too, ending
  `diagnostics it already had are not listed, and the project's checks remain the authority.`

The real model, told to write a line the server rejects, reported the error from the note in its answer.

## Errors only, unless you ask

New warnings are not reported by default. With `"warnings": true` the note lists both:

```text
[Diagnostics from the language server "typescript" for math.ts after this edit: 1 new error, 1 new warning]
```

## The keys

| Key in `lsp` | Value |
|---|---|
| `enabled` | `false` turns the feature off |
| `waitMs` | how long an edit's result may wait for the server, 0 to 5000 milliseconds; default 1500. `0` turns the note off |
| `warnings` | `true` reports new warnings too; default `false` |
| `maxDiagnostics` | diagnostics listed per edit, 1 to 50; default 10 |
| `servers` | the servers, by name (letters, digits, `_`, `.` and `-`, at most 64 characters) |

| Key in a server | Value |
|---|---|
| `command` | the program to start; it speaks the Language Server Protocol on its standard input and output |
| `args` | its arguments, a list of strings |
| `env` | environment variables for it, added to a basic set (`PATH`, `HOME`, ...) |
| `languages` | required: each language ID the server is told, with the glob patterns of the files it serves, relative to the working directory |
| `rootMarkers` | file names that mark a project root (`Cargo.toml`, `tsconfig.json`): the server is started for the nearest directory above the edited file that holds one |
| `startupTimeoutSeconds` | how long the server may take to start, 1 to 300; default 30 |
| `initializationOptions` | sent to the server as they are when it starts |
| `settings` | what the server is told when it asks for its configuration |
| `enabled` | `false` leaves the server out |

Other servers are configured the same way, for example:

```json
{
  "lsp": {
    "servers": {
      "python": { "command": "pyright-langserver", "args": ["--stdio"], "languages": { "python": ["**/*.py"] }, "rootMarkers": ["pyproject.toml"] },
      "go": { "command": "gopls", "languages": { "go": ["**/*.go"] }, "rootMarkers": ["go.mod"] },
      "rust": { "command": "rust-analyzer", "languages": { "rust": ["**/*.rs"] }, "rootMarkers": ["Cargo.toml"], "startupTimeoutSeconds": 120 }
    }
  }
}
```

## The wait, and what happens past it

An edit's result waits for the server at most `waitMs` (1.5 seconds by default). Past that the edit's result is
stored without a note, the agent is told nothing, and you are told once:

```text
⚠ lsp: The language server "<name>" did not give diagnostics within 1500 ms of an edit, so the edit got none. This is said once; it may keep happening if the server is slow.
⚠ lsp: The language server "<name>" was still starting when an edit needed its diagnostics; the edit got none. Later edits get them once it is ready.
```

A slow server costs each edit the whole wait: with a server that took 3 seconds to answer, both edits of a turn
waited 1.5 seconds and got nothing. Lower `waitMs`, or set it to `0`, if a server is slower than it is useful.
The diagnostics of a late answer are not delivered afterwards.

## What can go wrong

- **The server is not installed, or exits at once.** The edit goes through without a note and you are told why,
  with the end of what the server wrote:

  ```text
  ⚠ lsp: The language server "<name>" could not be started: could not start "<command>": Executable not found in $PATH: "<command>". Edits get no diagnostics from it; it is tried again at the next edit after 1 s.
  ```

- **The server crashes.** The same, noticed at once rather than after the wait:
  `⚠ lsp: The language server "<name>" stopped (the server process exited with code 3; it wrote: ...). Edits get no diagnostics until it is started again, at the next edit after 1 s.`
- **Changes made by a command are not seen.** Only `edit` and `write` are followed by a note; a file the agent
  changes with a shell command gets none, and neither does a file no server's `languages` match.
- **A language server runs outside the sandbox**, with your permissions, like an MCP server.

## A project's server

A server can also be named in the project's file, `.windlass/config.json`. Like a project's MCP server
([mcp.md](mcp.md)), it **is not started** until you approve it: opening a repository must not run a command the
repository chose. You are told at the first turn, and once more when an edit would have used it:

```text
⚠ lsp: This project's configuration names the language server "<name>" (<command and arguments>). It was not started: a server a project names runs only after you approve it.
⚠ lsp: The language server "<name>" from this project's configuration is not started: it waits for your approval.
```

The agent is not told, and its edits go through without notes.

## Not yet

<!-- NOT-YET(lsp-approve): no client can approve a project's language server -->
- **Approving a project's server.** Neither `windlass` nor `windlass tui` asks about it or has a command for it, so a
  project's server never starts. After reading what it runs, copy it into your own file.
<!-- NOT-YET(lsp-command): no /lsp command -->
- **Seeing the servers.** There is no `/lsp` command: no list of servers, their state, or why one failed, beyond
  the `⚠ lsp:` lines.
<!-- NOT-YET(lsp-shown): the clients do not show the note -->
- **Seeing the note.** The edit's row (`✓ +1 -1`) is the same with and without a note. `--json` has it: the
  `tool.settled` event's `output` ends with the note, and its `diagnostics` field has the counts, the wait and
  each server's outcome (`compared`, `timeout`, `crashed`, `not_running`).
- **Anything but diagnostics.** The agent gets no go-to-definition, references or rename from the server.
