# Releasing

A release is a GitHub release with these files, and nothing is published anywhere else:

- the four executables `scripts/build.ts` makes: `windlass-linux-x64`, `windlass-linux-arm64`, `windlass-darwin-x64`
  and `windlass-darwin-arm64`;
- `build-info.json`, the build's record of them (version, commit, size, SHA-256), which `install.sh` reads for the
  alias;
- `install.sh`, the same install script as `scripts/install.sh`;
- `SHA256SUMS`, the checksums of all of the above, in the format `shasum -a 256 -c` and `sha256sum -c` read.

Its notes are the version's section of `CHANGELOG.md`.

## What the workflows do

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

- **hygiene**: fails on tracked files that `.gitignore` excludes, on file names that look like sign-in data, session
  databases, traces or keys, and on content that looks like a credential or a real home directory. Deliberately fake
  secrets in tests are spelled with `synthetic` in them, and example paths use the made-up users `me`, `u`, `user`
  and `someone`.
- **typecheck**: `bun run typecheck`.
- **test**: `bun test`, split into three shards, on Linux x64 and arm64 and on macOS arm64. On Linux the job
  installs bubblewrap and, when AppArmor refuses it user namespaces, adds the profile from
  [troubleshooting](troubleshooting.md), so the sandbox tests run instead of skipping. On macOS it installs tmux, which
  the full-screen interface's end-to-end tests drive. No test reaches the model: the runners have no sign-in.
- **build**: each executable built on its own platform (Linux x64 and arm64, macOS arm64 and x64), so the
  full-screen interface's native library is in it, then run there: `--version`, a demo, the install script, and
  `test/release/binary.test.ts`.

`.github/workflows/release.yml` runs when a tag `v*` is pushed:

1. `bun scripts/release.ts check <tag>`: the tag is `v` + the root `package.json` version, `CHANGELOG.md` has a
   non-empty section for that version, and nothing is left under `## [Unreleased]`.
2. Every CI job above, with each executable kept as a workflow artifact.
3. `bun scripts/release.ts assets`: the four builds are all there, each file's SHA-256 is the one its build
   recorded, all are that version from one clean commit with the full-screen interface; it writes the release's
   files and `SHA256SUMS`.
4. `gh release create` with those files and the changelog section as the notes.

Run by hand (Actions, Release, "Run workflow", or `gh workflow run release.yml --ref <branch>`), the same workflow
is a dry run on that branch: the checks of step 1 are reported as warnings, the notes fall back to the Unreleased
section, and instead of a release the files are kept as the workflow artifact `release-<version>-dry-run`.

## Releasing a version

Only the maintainer pushes a version tag; nothing else releases.

1. Decide the version. In `CHANGELOG.md`, move the entries under `## [Unreleased]` into a new
   `## [<version>] - <YYYY-MM-DD>` section below it, leaving `## [Unreleased]` empty, and add its link at the
   bottom (the first release links to `releases/tag/v<version>`, later ones to `compare/v<previous>...v<version>`):

   ```
   [Unreleased]: https://github.com/parthg1901/windlass/compare/v<version>...HEAD
   [<version>]: https://github.com/parthg1901/windlass/releases/tag/v<version>
   ```

2. Set `version` in the root `package.json` to the same version.
3. Run `bun run typecheck`, `bun test test/release` and `bun scripts/release.ts check v<version>`.
4. Commit, push `main`, and wait for CI to pass on that commit.
5. Optionally, run the dry run on `main` and look at the artifact.
6. `git tag v<version>`, then `git push origin v<version>`. Push the one tag by name: never `git push --tags`.
7. Watch the Release workflow. When it is done, check the release page, and that the README's download commands
   work against it (they fetch `releases/latest`).

A failed run can be re-run from the Actions page. A release that went out with a mistake is fixed with a new
version, not by moving the tag: others may already have downloaded the files the checksums name.

## Before the first release

- The README's download commands point at `releases/latest`, which does not exist until the first release.
- Protect the `v*` tags on GitHub (a tag ruleset) so that only the maintainer can push them.
