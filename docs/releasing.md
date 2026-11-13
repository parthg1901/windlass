# Releasing

A release is five packages on npm and a GitHub release, and nothing is published anywhere else.

The npm packages, all of the same version (`scripts/npm.ts` makes them; the names come from `brand.npmPackage`):

- `windlass-agent`, which `npm install -g windlass-agent` installs: `npm/launcher.mjs` as the `windlass` and `wl`
  commands, and `optionalDependencies` on the four below at exactly its own version. The launcher runs on Node 18 or
  later or on Bun, finds this machine's package, and runs its executable with the same arguments, standard streams
  and environment, passing on SIGTERM and SIGHUP (and SIGINT and SIGQUIT when no stream is a terminal, since from a
  terminal they already reach the executable), and exits with its exit code or by its signal. When the package is
  missing (`--omit=optional`, a platform with none) it says which, and exits 1.
- `windlass-agent-linux-x64`, `windlass-agent-linux-arm64`, `windlass-agent-darwin-x64` and
  `windlass-agent-darwin-arm64`: each holds its target's executable as `bin/windlass`, with `os`, `cpu` (and on
  Linux `libc: glibc`) set so that npm installs only the one for the machine.

The GitHub release has these files:

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
  `test/release/binary.e2e.test.ts`.

`.github/workflows/release.yml` runs when a tag `v*` is pushed:

1. `bun scripts/release.ts check <tag>`: the tag is `v` + the root `package.json` version, `CHANGELOG.md` has a
   non-empty section for that version, and nothing is left under `## [Unreleased]`.
2. Every CI job above, with each executable kept as a workflow artifact.
3. `bun scripts/release.ts assets`: the four builds are all there, each file's SHA-256 is the one its build
   recorded, all are that version from one clean commit with the full-screen interface; it writes the release's
   files and `SHA256SUMS`.
4. `bun scripts/npm.ts stage`: the five npm packages from those files, each checked with `npm pack` (exactly the
   files it should have, the executable executable, the size within bounds) and packed; the tarballs are installed
   with `npm install -g` on Node 18.0.0 and `windlass --version`, `wl --version`, a demo and a usage error's exit
   code are run through the launcher.
5. `bun scripts/npm.ts publish --provenance`: publishes the four platform packages, then `windlass-agent`, with npm's
   trusted publishing (the job's OIDC token, `id-token: write`; no npm token is stored anywhere) and a provenance
   statement. A package whose version is already on the registry is skipped, so a re-run, or a version published by
   hand, goes on to step 6.
6. `gh release create` with the files of step 3 and the changelog section as the notes.

Run by hand (Actions, Release, "Run workflow", or `gh workflow run release.yml --ref <branch>`), the same workflow
is a dry run on that branch: the checks of step 1 are reported as warnings, the notes fall back to the Unreleased
section, nothing is published, and the release's files and the five tarballs are kept as the workflow artifacts
`release-<version>-dry-run` and `npm-<version>-dry-run` (for 7 days).

## Releasing a version

Only the maintainer pushes a version tag; nothing else releases. The npm packages are published only by the Release
workflow on that tag, or by the maintainer by hand (the first release, below).

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
7. Watch the Release workflow. When it is done, check the release page, that the README's download commands work
   against it (they fetch `releases/latest`), and that each package's page on npmjs.com shows the version with its
   provenance. `npm install -g windlass-agent` then `windlass --version` on any machine says the new version.

A failed run can be re-run from the Actions page; packages it had already published are skipped. A release that went
out with a mistake is fixed with a new version, not by moving the tag: others may already have downloaded the files
the checksums name, and npm refuses the same version twice.

## The first release: 0.1.0 by hand, then 0.1.1 through the workflow

npm's trusted publishing (docs.npmjs.com, "Trusted publishing for npm packages", and `npm help trust`):

- A trusted publisher can be configured only for a package that already exists on the registry, so the first
  version of all five is published once by hand, with your own npm login. That version has no provenance statement.
- Configuring it from the command line (`npm trust`) needs npm 11.15.0 or later and two-factor authentication on
  your npm account; publishing through it needs npm 11.5.1 and Node 22.14 or later on the runner (the workflow uses
  Node 24 and upgrades npm when it is older).
- A new trusted-publisher configuration must complete a publish within 2 days, or it expires and has to be revoked
  and created again.
- Each package's `repository.url` must be this repository (`scripts/npm.ts` writes it from `brand.repository`), and
  provenance is made only for a public package from a public repository.

Steps, with `0.1.0` (its changelog section and the version in `package.json` are already in place):

1. Run the checks of "Releasing a version", step 3, with `v0.1.0`. Push `main` and wait for CI to pass.
2. Build the four executables from that commit: run the dry run on `main`
   (`gh workflow run release.yml --ref main`), wait for it to pass, and download its release files into a new, empty
   directory outside the repository, then check them:

   ```
   gh run list --workflow release.yml --limit 1          # the run's ID
   gh run download <run-id> --name release-0.1.0-dry-run --dir ~/windlass-0.1.0
   cd ~/windlass-0.1.0/release && shasum -a 256 -c SHA256SUMS && cd -
   ```

   `npm-0.1.0-dry-run`, in the same run, holds the five tarballs the workflow packed and installed from those files.
3. `npm login` (as the account that will own the packages, with two-factor authentication on).
4. In a clean checkout of exactly that commit (`git status` shows nothing; `bun install --frozen-lockfile` done),
   publish all five with one command:

   ```
   bun scripts/npm.ts publish ~/windlass-0.1.0/release
   ```

   It checks the executables against their records, `SHA256SUMS`, the version and this checkout's commit, stages
   and checks the packages with `npm pack --dry-run`, then publishes the four platform packages and `windlass-agent`
   last. npm asks for a one-time password when your account needs one (or pass `--otp <code>`, valid for one
   publish only, so leave it out to be asked each time). If a publish fails, run the same command again: what went
   out is skipped. Check with `npm view windlass-agent` and `npm install -g windlass-agent && windlass --version`.
5. Configure trusted publishing for all five (npm 11.15.0 or later; the first one asks for two-factor
   authentication, and npm's page offers to skip it for the next 5 minutes):

   ```
   for pkg in windlass-agent windlass-agent-linux-x64 windlass-agent-linux-arm64 windlass-agent-darwin-x64 windlass-agent-darwin-arm64; do
     npm trust github "$pkg" --file release.yml --repo parthg1901/windlass --allow-publish --yes
     sleep 2
   done
   ```

   `npm trust list <pkg>` shows each one. On npmjs.com this is the package's Settings, "Trusted publishing", GitHub
   Actions, workflow `release.yml`, no environment.
6. `git tag v0.1.0` on that commit, then `git push origin v0.1.0`. The workflow runs the checks, tests and builds,
   finds all five at 0.1.0 on the registry and skips publishing, then creates the GitHub release. (Pushed before
   step 4, the publish would fail for want of a trusted publisher, and no GitHub release would be made; re-running
   it after step 4 makes it.)
7. Within the 2 days of step 5, release **0.1.1** through the workflow ("Releasing a version"; it needs a changelog
   section with at least one entry). That publish validates the trusted publishers, and each package's page then
   shows its provenance.
8. Then, as npm recommends, in each package's settings choose "Require two-factor authentication and disallow
   tokens", so that only the workflow can publish.

## Before the first release

- The README's download commands point at `releases/latest`, which does not exist until the first release.
- Protect the `v*` tags on GitHub (a tag ruleset) so that only the maintainer can push them.
