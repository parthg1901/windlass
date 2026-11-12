# lsp

Diagnostics from language servers after the agent edits a file. A language server can tell, within a second of an
edit, what a full check run tells the agent a minute later: this name does not exist, that argument has the wrong
type. This module adds that as a short note to the file tool's result, limited to what **this edit made worse**.
The note is optional. It never gates the turn, and it never waits longer than a short, fixed time.

The step loop calls it from `engine/lsp.ts` (see "As wired into the engine" at the end, which says where that
differs from the proposal under "For the engine integrator"). It imports
`config/schema.ts` (`ConfigError`, `mergeConfigFiles`), `mcp/config.ts` (`BASE_ENV`, `serverEnvironment`),
`validate.ts`, `json.ts` and `brand.ts`. The process handling in `transport.ts` (own process group, guard process,
close stdin, SIGTERM, SIGKILL) is **copied** from `mcp/stdio.ts`, not imported. That channel frames messages by
newline, and its `processGroup` and `guardGroup` helpers are private. If they are exported later, `transport.ts`
can import them instead (see "Changes outside this module").

| File | What |
| --- | --- |
| `codec.ts` | `Content-Length` framing: encoder, and a decoder for split and merged frames (pure) |
| `diagnostics.ts` | the diagnostic shape, a lenient parser, and the before/after comparison (pure) |
| `note.ts` | the note text the model sees, and its bounds (pure) |
| `config.ts` | the `lsp` section, defaults, the examples, fingerprints, which servers may start (pure) |
| `transport.ts` | the server process and its JSON-RPC connection |
| `client.ts` | one LSP session: initialize, document sync, push and pull diagnostics, answering server requests |
| `registry.ts` | servers per (server, workspace root): lazy start, backoff, `observe`, `diagnose`, `stop` |

`bun scripts/lsp-demo.ts` runs the scripted server and prints what the model would see for an edit that adds an
error to a file that already had a warning and an error. It then shows a server that never answers and one that
crashes. `bun scripts/lsp-demo.ts --python -- <command...>` runs the same kind of edit in Python against a real server.

## For users

### The configuration

In your configuration file (`~/.config/windlass/config.json`) or a project's (`.windlass/config.json`;
the directory names come from `packages/core/src/brand.ts`):

```json
{
  "lsp": {
    "waitMs": 1500,
    "warnings": false,
    "servers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "languages": {
          "typescript": ["**/*.ts", "**/*.mts", "**/*.cts"],
          "typescriptreact": ["**/*.tsx"],
          "javascript": ["**/*.js", "**/*.mjs", "**/*.cjs"],
          "javascriptreact": ["**/*.jsx"]
        },
        "rootMarkers": ["tsconfig.json", "jsconfig.json", "package.json"]
      },
      "python": {
        "command": "pyright-langserver",
        "args": ["--stdio"],
        "languages": { "python": ["**/*.py", "**/*.pyi"] },
        "rootMarkers": ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg"],
        "settings": { "python": { "analysis": { "diagnosticMode": "openFilesOnly" } } }
      },
      "go": { "command": "gopls", "languages": { "go": ["**/*.go"] }, "rootMarkers": ["go.work", "go.mod"] },
      "rust": {
        "command": "rust-analyzer",
        "languages": { "rust": ["**/*.rs"] },
        "rootMarkers": ["Cargo.toml"],
        "startupTimeoutSeconds": 120
      }
    }
  }
}
```

These four entries are `LSP_EXAMPLES` in `config.ts` (tested to validate). Copy the ones you want. **No server is
built in or started on its own.** A server runs only when a configuration file names it, and it must already be
installed and on your `PATH`. The harness installs nothing.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | the whole feature |
| `waitMs` | `1500` | how long an edit's result may wait for diagnostics, 0 to 5000. `0` turns the note off and starts no server |
| `warnings` | `false` | report new warnings too, not only new errors |
| `maxDiagnostics` | `10` | diagnostics listed per edit, 1 to 50 |
| `servers.<name>.command`, `args` | | the server to start. It speaks LSP on stdin and stdout |
| `servers.<name>.languages` | | required. Maps each language ID (sent to the server) to glob patterns of the files it serves, relative to the working directory |
| `servers.<name>.rootMarkers` | `[]` | file names that mark a workspace root. The root is the nearest directory above the edited file, inside the working directory, that holds one of them. With none, the root is the working directory. One server process runs per root |
| `servers.<name>.env` | `{}` | the server's variables besides `BASE_ENV` (PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_ALL, LC_CTYPE, TZ). `${NAME}` is expanded from your environment. Nothing else is inherited |
| `servers.<name>.startupTimeoutSeconds` | `30` | how long the server has to answer `initialize`, 1 to 300 |
| `servers.<name>.initializationOptions` | none | sent as is in `initialize` |
| `servers.<name>.settings` | none | what the server is told when it asks for its configuration (`workspace/configuration`, by dotted section), and sent once in `didChangeConfiguration` |
| `servers.<name>.enabled` | `true` | |

The user's and the project's files are merged as usual: key by key, and lists replace. A file that two servers
serve gets diagnostics from both, with one section each in the note.

### What the agent sees

After a successful `edit` or `write` of a file a server serves, if the edit made something worse, a note follows the
tool's own output:

```
Edited src/app.ts: replaced 1 occurrence (line 12).

[Diagnostics from the language server "typescript" for src/app.ts after this edit: 2 new errors]
src/app.ts:12:5: error 2304: Cannot find name 'fetchUser'. (typescript)
src/app.ts:20:18: error 2345: Argument of type 'string' is not assignable to parameter of type 'number'. (typescript)
These are the language server's diagnostics for this file after the edit; the 3 it already had are not listed, and the project's checks remain the authority.
```

What a real server gave (pyright 1.1.414, run by `scripts/lsp-demo.ts --python`):

```
[Diagnostics from the language server "python" for greet.py after this edit: 2 new errors]
greet.py:10:13: error reportArgumentType: Argument of type "Literal[42]" cannot be assigned to parameter "name" of type "str" in function "greet" "Literal[42]" is not assignable to "str" (Pyright)
greet.py:11:7: error reportUndefinedVariable: "gret" is not defined (Pyright)
These are the language server's diagnostics for this file after the edit; the 1 it already had is not listed, and the project's checks remain the authority.
```

- Paths are relative, and lines and columns start at 1. Each item is the server's own message, code and source,
  cut to one line of 300 characters with control characters removed. Items are in document order, and servers are
  sorted by name.
- At most `maxDiagnostics` items and 2,000 characters. Anything left out is one line: `... and 1990 more new
  diagnostics not listed.`
- Diagnostics the file already had are counted in the last line, never listed.
- If nothing got worse (no new errors, or the edit fixed one), nothing is added.

**How "made worse" is decided.** Line numbers alone are not enough, because an edit moves every line below it. A
diagnostic after the edit is pre-existing when the same one was there before, matched one to one in two passes:

1. By identity: the same severity, source, code and message, on a line with the same text (whitespace collapsed,
   so re-indented code matches) and the same text under its range. This follows a diagnostic through a shift and
   through moved code.
2. By place: the same severity, source, code and message, at the line where the old line now is. Lines above the
   changed region keep their number; lines below it shift by the change in length; both may sit inside the changed
   region. This keeps a diagnostic whose own line the edit touched (`let x = 1` became `let x = 2`, and `x` is
   still unused).

A copied line that carries its error is one new error: within a group of equals, the copy farther from the
original is the one reported.

**Which version.** The client says it supports versioned diagnostics. A publication for an older version of the
document is stale and ignored. One without a version counts only if it arrives after the change was sent. After the
first fresh publication the client listens 100 ms more (within the bound), because some servers publish twice for
one version. A server that offers the pull model (`textDocument/diagnostic`) is asked directly instead.

### What it will not do

- **Wait.** An edit's result waits at most `waitMs` (1.5 s by default), measured from when the tool finished. A
  server that is still starting, slow, hung or crashed adds nothing, and you (not the agent) are told why once per
  server and reason. A crash is noticed at once rather than at the deadline.
- **Dump.** Diagnostics the file already had are counted, not listed. A server that publishes thousands is cut to
  the bounds above. At most 5,000 diagnostics of one publication are kept for the comparison.
- **Report stale results.** It reports only diagnostics for the version of the document the edit produced (see
  above).
- **Run a repository's server unasked.** A server that a project's file names, or changes in any field, is not
  started until you approve exactly that definition. Approval is keyed by a fingerprint of the server's merged
  definition, so an edited command is asked about again. Your own file's servers are yours and start without a
  question.
- **Leave processes behind.** Each server runs in its own process group, and stopping takes the whole group down.
  The order is `shutdown`, `exit`, close stdin, SIGTERM, SIGKILL. A guard process kills the group if the harness dies
  without stopping.
- **Restart in a loop.** A server that fails to start or crashes is started again only at the next edit after a
  backoff: 1 s, doubling, at most 5 minutes. The count resets after 30 s of running.
- **Gate the turn.** The project's checks remain the authority (the verification gate). The note does not end a
  turn, prolong one, or stand in for a check.
- **Touch other files.** Only the edited file's diagnostics are shown. Files outside the working directory, files
  over 2 MiB and files that are not text are not sent to a server.

A language server runs outside the sandbox with your permissions, as MCP servers do.

## For the engine integrator

### What exists

```ts
const plan = planLspServers(userFile.lsp, projectFile.lsp, (key) => projectGrantExists(key))
const lsp = createLspRegistry({ plan, cwd, onNotice: (n) => showToUser(n) })
lsp.observe(path, text)                                   // after a read; never waits
const result = await lsp.diagnose({ path, before, after, signal })   // after an edit; bounded; never throws
lsp.awaitingApproval(); lsp.approve(key); lsp.status(); await lsp.stop()
```

`result.note` is the text to add (or `null`). `result.servers[i]` has `server`, `outcome` (`compared`,
`unchanged`, `timeout`, `not_running`, `crashed`, `not_approved`, `interrupted`), `comparison` (`added`,
`preExisting`, `fixed`, `afterTotal`) and `detail`. `result.skipped` is `off`, `outside_workspace`, `no_server`,
`too_large` or `null`. `result.listed`, `result.omitted` and `result.waitedMs` complete it.

### Where the engine calls it

1. **After a read.** When `read` settles successfully on a file a server could serve, call
   `lsp.observe(absolutePath, fileText)` with the file's full text from disk, not the capped output. This starts
   the server early (lazily, in the background) and opens the document, so the diagnostics from before the edit
   are ready when the edit comes. It never waits. It is optional: without it the first edit opens the document
   as it was and waits for both sets inside the same bound, which with a real server often does not fit.
2. **After an edit.** For a call of a tool with `effect: "write"` and `touches` (`edit`, `write`):
   - Before `execute`, in the runtime's `authorize` path after the call was allowed, read the file's current text
     as `before` (`null` if it does not exist; skip diagnostics for a file over 2 MiB).
   - After `execute` returned with `status: "success"`, read the file from disk as `after`, and call
     `lsp.diagnose({ path, before, after, signal: context.signal })`. Do this in the same "after the tool ran,
     before the result is capped and stored" step the hooks module asks for (`RunHooks.afterExecute` in
     `tool/runtime.ts`).
   - Do nothing for an error result, a refused or denied call, a call that threw, or a shell command (no `touches`).
3. **Composing with the hooks module.** Run the after-tool hooks **first**, then diagnostics. A hook such as a
   formatter can rewrite the file, and the diagnostics must be about the text the agent will see next, so `after`
   is read from disk after the hooks ran. The output is then the tool's output byte for byte, the hooks' notes, a
   blank line, and the diagnostics note (`${output}\n\n${note}`). Like the hooks' notes it goes in before the cap.
   For a tool that capped itself, the note follows the capped text and the result can be at most 2,000 characters
   over the cap on top of the hooks' allowance. Redaction applies to the whole text as now.
4. **The bound.** `diagnose` returns within `waitMs` of being called (plus scheduling) and never throws. The engine
   must not add waits of its own around it or retry it. With several write calls in a step, each waits on its own,
   in the line of calls as now. `waitMs: 0` returns at once.
5. **Interrupt.** Pass the call's `ToolContext.signal`. An abort returns at once with no note (`interrupted`). The
   server still gets the new text, so the next edit compares correctly. The result is stored as it would have been.
6. **Lifetime.** Create one registry per working directory and configuration, at engine start or lazily at a
   session's first edit, and share it between sessions with the same working directory and plan. `await
   lsp.stop()` in `Engine.close()`: it ends every server and its process group, bounded by about three times the
   grace (1 s each) per server, all servers in parallel. After `stop`, `diagnose` returns `skipped: "off"`. If the
   process dies without it, the guard kills the groups. A configuration change takes effect when the registry is
   recreated (stop the old one).

### What to record durably

The note's text is frozen inside `tool.settled.output`, like a hook's note, and is never rendered again. Record as
fields, never parsed back out of the text, on the same `tool.settled` (a new optional field, owned by the event
schema), for example:

```ts
diagnostics: {
  noteAdded: boolean,            // result.note !== null
  listed: number, omitted: number,
  waitedMs: number,              // display data, like a check's duration
  servers: [{ name: string, origin: "user" | "project", fingerprint: string,
              outcome: ServerOutcome, new: number, preExisting: number, fixed: number }],
}
```

`timedOut` is `outcome === "timeout"`. Nothing else needs recording: the documents and diagnostics the servers hold
are not state the log must rebuild. A replay replays the stored output with the note in it and starts no server.
The request prefix is untouched: no tool, spec or system-prompt text depends on this configuration. The note is part
of a tool result, which is appended like any other.

`onNotice` messages are for a client to show (status line, log). They are not durable and never reach the model.

### Approving a project's server

As for MCP servers (`engine/mcp.ts`). `planLspServers(user, project, isApproved)` marks each server `origin` `user`
or `project`, and `approved`. A user's server is always approved. A project's server is approved when
`isApproved(lspApprovalKey(plan))` holds. Store an approval as a project grant
`{ scope: "project", rule: { kind: "tool", tool: lspApprovalKey(plan) } }`, beside the MCP servers' grants, with the
same 30-day expiry (`PROJECT_GRANT_TTL_MS`), never in the repository. At execution start (or at the first edit of a
file it serves), put one question per entry of `lsp.awaitingApproval()`. It gives `name`, `subject` (the command
word for word), `details` (lines for the client) and `key`. Choices are allow for this project, not now, and no. On
"allow", write the grant and call `lsp.approve(key)`. Nobody present: ask nothing, start nothing. An unapproved
server only produces `not_approved` and a notice, and the model is told nothing.

### The verification gate

Independent. The note does not replace the checks (its last sentence tells the model so), adds no round, and has
no say in whether a turn ends. The gate runs at the end of the turn exactly as now, whatever notes were shown.
Diagnostics may make the gate pass sooner, because the model fixes an error before the checks see it. That is the
whole point and needs no wiring.

### Taint

**Not a taint source of its own.** The note is part of the file tool's result, and that result is already
classified by its path (`approval/taint.ts`). A file outside the workspace gets no note at all, and a file under
`approval.untrustedPaths` makes the result a source as it does now. What the note adds is the edited file's own code
(workspace content, which by decision is not a source) and messages from a program you configured or approved,
running locally on that same code. Tainting every edit's result would taint every session that has a language
server, and an always-on warning teaches people to ignore it.

One exception, matching the hooks module: a note from a **project's** server when the repository is untrusted (the
project's configuration file matches `approval.untrustedPaths`) should be a source. The project chose that program
and its messages. Record `origin` on the field above and map `tool.settled` results with a project server's note in
an untrusted repository to a source (e.g. `lsp-untrusted-project`). Stated gap: a server that itself reaches the
network (downloading type stubs) is not detected, like unsandboxed commands.

### Changes outside this module

1. `config/schema.ts`: `lsp: parseLspSection` in `FEATURE_SECTIONS`, and `readonly lsp?: LspConfigSection` on
   `ConfigFile`. It is merged like `mcp` (key by key). `planLspServers` takes both files' sections separately to
   know the origin, and merges them with `mergeConfigFiles` itself.
2. `tool/runtime.ts`: the `RunHooks.afterExecute` step from the hooks README, with access to the call's input (for
   `touches`). Also a matching step before `execute` to read `before`, or `authorize` reading it.
3. `engine/`: the registry's lifetime (start lazily, `stop()` in `Engine.close()`), the two call sites above, the
   approval question and grant, and `onNotice` to the client.
4. `event/durable.ts`, `message/reducer.ts`: the optional `diagnostics` field on `tool.settled`, with a scenario.
5. `approval/taint.ts`: the project-server exception above.
6. Optional: export `processGroup` and `guardGroup` from `mcp/stdio.ts` so `transport.ts` imports them instead of
   keeping a copy.

## Limits and what is not proven

- Tested against scripted servers (`packages/core/test/lsp/fixtures/server.ts`: push with versions, pull only,
  slow, silent, stale-first, crash on the n-th change, flood, stubborn) and once by hand against pyright 1.1.414
  through the demo. With pyright, the first edit after a cold start took 1.4 to 3.6 s, so it can miss the default
  1.5 s bound. Warm edits took 0.1 to 0.9 s on a loaded two-core machine. No TypeScript, Go or Rust server was
  available to try.
- A server that publishes stale diagnostics **without** version numbers cannot be told apart from a fresh
  publication. The first set after the change is taken.
- With more than 5,000 diagnostics in one publication, the rest are not compared, so "new" can be undercounted.
- `didChange` always sends the full text. That is correct for every sync kind but costs bandwidth on huge files,
  which is why files over 2 MiB are skipped.
- No `workspace/didChangeWatchedFiles`: a server that depends on other files (types defined in a file the agent
  changed with a shell command) may be out of date until those files are opened.

## As wired into the engine

`engine/lsp.ts` and `engine/engine.ts` do what "For the engine integrator" asks for, with these details:

- **Lifetime.** `LspHub` holds one registry per working directory and configuration (who approved what is not
  part of the key: an approval given later is told to the registry that exists), shared by the sessions that
  work there. A session takes hold of it when an execution reads its configuration, and lets go when it closes
  or its configuration names no server any more; the last release stops it, and `Engine.close()` stops all.
- **The calls.** `observe` after a successful `read`-class call that names one file a server serves; the
  file's text before an edit is read in the runtime's `authorize`, once the call may run; `diagnose` in
  `RunHooks.afterExecute`, after the after hooks, with the text read from disk again. Nothing is read for a file
  no enabled server serves.
- **The record** is `tool.settled.diagnostics` as proposed, plus `untrusted: true` when the note holds a
  project server's messages in a repository the user marked untrusted; the taint fold reads that field
  (a `diagnostics_note` entry, source kind `lsp-untrusted-project`).
- **Approval.** `EngineSession.lsp()` gives the started servers and the ones that wait;
  `approveLspServer(name, fingerprint?)` writes the project grant and calls `approve(key)`. Until then the user
  is told once by a `diagnostic` of kind `lsp`, as for every notice of the registry.
