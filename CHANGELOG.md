# Changelog

All notable changes to Windlass are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, a minor version may break compatibility).

## [Unreleased]

## [0.1.0] - 2026-11-13

The first release: a coding agent for the terminal that signs in with a ChatGPT plan.

### Added

- **Three interfaces, one program.** `windlass` (or `wl`) is a line interface, `windlass tui` a full-screen one, and
  `windlass acp` a server for editors that speak the Agent Client Protocol. `windlass "<task>"` runs one task to the
  end without you.
- **Works in your project.** The agent reads, searches, edits files and runs commands, then runs the checks you
  configure (tests, a type check) and carries on until they pass or says which still fail.
- **Asks before what matters.** Commands run in an operating-system sandbox without network (bubblewrap on Linux,
  `sandbox-exec` on macOS); anything that needs more asks first. Secrets in tool output are redacted before the model
  sees them.
- **Undo, review and forks.** `/undo` and `/redo` take files and conversation back or forward a turn, `/diff` and
  `/review` show and comment on what a turn changed, and a session can be forked to try another way.
- **Sessions that last.** Every session is kept on your machine and can be resumed (`windlass -c`), replayed or
  exported; long sessions are compacted, and the prompt cache's share of each request is shown as you work.
- **Yours to shape.** Project instructions (`AGENTS.md`), agents, skills, slash commands, hooks, MCP servers,
  language-server diagnostics, subagents, background commands and wake-ups, opt-in memory and telemetry.
- **Executables** for Linux and macOS, x64 and arm64, with SHA-256 checksums and an install script, and on npm:
  `npm install -g windlass-agent` installs the one for your machine.

[Unreleased]: https://github.com/parthg1901/windlass/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/parthg1901/windlass/releases/tag/v0.1.0
