# snapshot

Records the whole working tree of a workspace as a git tree object, so every step can be diffed and undone, whatever
changed the files (edit tools or shell commands). `git` 2.25 or newer on PATH is the only requirement; without it
`openSnapshots` returns `{ kind: "unavailable", reason, message }`.

```ts
const snapshots = await openSnapshots(workspace)        // or { kind: "unavailable" }
const start = await snapshots.take({ session })          // { id, skipped, nestedRepositories, ... }
// ... the step runs ...
const end = await snapshots.take({ session })
await snapshots.changedFiles(start.id, end.id)           // ["src/a.ts", ...]
await snapshots.diff(start.id, end.id, { patch: true })  // statuses, modes, bounded unified diffs
const result = await snapshots.restore(start.id, { session, paths?, dryRun? })
await snapshots.restore(result.before, { session })      // undo the restore
await snapshots.prune({ session, keepLast: 0 })          // drop a session's snapshots, then gc
```

A `SnapshotId` is the tree hash: equal ids mean equal contents. Unexpected git failures throw `SnapshotError`.

## Where the data lives

One private bare git directory per workspace: `<dataDir>/<sha256(realpath)[:32]>`, with `dataDir` defaulting to
`$XDG_DATA_HOME/<brand.directory>/snapshots` (`~/.local/share/...`). Every command runs with `GIT_DIR` set to it and
`GIT_WORK_TREE` set to the workspace. Nothing is created or changed in the workspace's own `.git`: not its index, refs,
config, hooks or stash. The private directory holds copies of the user's files (including any `.env` that is not
ignored), so it is created mode 0700.

When the workspace is inside a git repository (a package in a monorepo), the work tree is that repository's root and
every command is limited to the workspace directory, so the `.gitignore` files above the workspace apply exactly as
they do for the user. Only the existence of `.git` is checked; the repository itself is never read. If that repository
ignores the workspace itself (a scratch directory, or a home-directory repository that ignores `*`), the workspace
stands alone.

## What a snapshot holds

| | Decision |
| --- | --- |
| Tracked by the user, staged or not | Captured with its working-tree content. The user's index is never read, so staged and unstaged edits look the same. |
| Untracked, not ignored | Captured. |
| Ignored (every `.gitignore` from the work-tree root down) | Not captured, unless an earlier snapshot already captured the file (git keeps tracking it). The user's `.git/info/exclude` and global excludes file are not read. A file the user force-added despite an ignore rule is not captured either: knowing about it would mean reading their index. |
| Nested repositories and submodules (a directory with its own `.git`) | Listed in `nestedRepositories`; nothing inside is read or captured, and restore never writes inside them. A directory that becomes a repository after it was captured is still descended into (git only checks untracked directories). |
| Symlinks | Stored as links (mode 120000, the target text). Never followed: a link to a file or directory outside the workspace records only where it points. |
| File modes | Only the executable bit, which is all git records. Restored files get `0666` or `0777` minus the umask. |
| Empty directories | Not recorded (git stores files, not directories). An empty directory never changes an id; restore never creates one, and removes directories it empties. |
| Untracked files over `maxFileBytes` (2 MiB) | Skipped and listed in `skipped` with their size, for the caller to warn. A file that an earlier snapshot captured keeps being captured whatever its size, so a series of snapshots never silently loses a file. |
| Unreadable files and directories | Listed in `skipped` as `unreadable`; a tracked file that became unreadable is dropped rather than kept with stale content. |
| FIFOs, sockets, devices | Ignored by git. |

## Speed

The private index is git's stat cache: a second snapshot of an unchanged tree only `lstat`s each file. On this machine
(aarch64 Linux, ext4) a generated tree of 20,000 small files took about 2.2 s for the first snapshot, 60 ms for an
unchanged second, and 90 ms after ten edits (`test/snapshot/perf.test.ts` prints the numbers).

## Concurrency

Snapshots of one workspace are independent. Each works on its own copy of the shared index, made with a hard link:
git replaces an index by writing a new file and renaming it, so the shared one never changes underneath anyone, and
its timestamp (which git's same-instant-change check depends on) carries over exactly. Objects are written atomically
by git; each snapshot gets its own ref; the last capture to finish becomes the shared stat cache. Tested with eight
concurrent snapshots in one process plus four processes taking three each.

## Running no user code

- The environment is built from scratch (PATH and TMPDIR only), so a `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_CONFIG_*`,
  `GIT_EXEC_PATH` or `GIT_EXTERNAL_DIFF` inherited from a parent process does nothing.
- `GIT_DIR` is always the private directory, so the workspace's `.git/config` and hooks are never seen.
- System and global config are off (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, HOME pointed at the private
  directory for older git), and so are the system and global attributes files.
- Every call passes `-c core.fsmonitor=false -c core.hooksPath=/dev/null` and the rest of `COMMAND_CONFIG` in
  `git.ts`; command-line config wins over every file and reaches the git processes gc starts.
- The private `info/attributes` (highest precedence) resets `text`, `eol`, `ident`, `filter`, `working-tree-encoding`,
  `diff` and `merge`, so a `.gitattributes` cannot pick a driver, convert line endings, expand `$Id$` or re-encode:
  bytes are stored and restored exactly. No driver is defined anywhere git looks in any case.
- Diffs run with `--no-ext-diff --no-textconv`; no credentials are passed and `protocol.allow=never`.
- Nested repositories are excluded by pathspec, so git never reads their config or refs.

`test/snapshot/security.test.ts` plants all of these (fsmonitor, hooksPath and hooks, filter clean/smudge/process,
textconv, diff and merge drivers, credential helper, pager, editor, sshCommand, a hostile nested repository, a hostile
global config and environment), checks with plain git in an identical workspace that the traps fire, and then checks
that take, diff, restore and prune fire none of them and that the user's `.git` is unchanged to the mtime.

## Restore

`restore(target, { session, paths?, dryRun? })` first takes a snapshot (`before`) so it can be undone, then applies
the difference between `before` and the target, for every path or only the listed ones (files or directories, relative
to the workspace or absolute inside it; anything outside is refused). It uses git's two-tree fast-forward
(`read-tree -m -u`), which checks every path before writing anything and refuses to write through a symlink. It:

- deletes only files `before` captured, never ignored files: a deletion of a path ignored now is skipped and reported
  as `kept: ignored`;
- never overwrites anything it did not capture (an ignored or oversized file, or a directory holding one, where the
  target has a file): the path is reported as `kept: not_captured`;
- never writes inside a nested repository (`kept: nested_repository`);
- restores content, symlinks and the executable bit, and removes directories it empties;
- touches nothing outside the workspace. On git older than 2.36, emptying the whole workspace of a subdirectory
  workspace may remove the workspace directory itself (newer git never removes the current directory).

`dryRun` returns the same `changes` and `kept` without writing. `kind: "blocked"` means git refused (a file changed
while the restore ran) and nothing was written. A dry run's `before` has no ref, so it is collected after the grace
period.

## Retention

Each `take` (and each restore's `before`) is a ref `refs/snapshots/<hex(session)>/<ms>-…` pointing at the tree.
`prune({ session?, olderThanMs?, keepLast?, graceSeconds? })` deletes refs (one session's, or the workspace's), then
runs `git gc`. An object stays while any ref of any session reaches it, so dropping one session never affects
another. Unreferenced objects younger than `graceSeconds` (default an hour) survive, so a snapshot being taken
concurrently is never cut.

## What the step loop needs to record per step

(It does, as `snapshot.taken`, `snapshot.coverage`, `revert.started` and the restore record of `history.reverted`:
see `docs/architecture.md`.)

- the snapshot ids at step start and end (and the workspace path they belong to);
- `skipped` from each snapshot, to warn that those files cannot be undone;
- `nestedRepositories`, if it wants to say that changes inside them are not tracked;
- for a revert: the target id, the `paths` if partial, the returned `before` id (the undo point), and the `kept` list.
