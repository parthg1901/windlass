# skills

A skill is a directory with a `SKILL.md`: front matter with a `name` and a one-line `description`, then
instructions, possibly with supporting files next to it. The model is told which skills exist (name and description
only, the index) and loads one with the `skill` tool when a task calls for it. A leaf module: nothing in core imports
it; it imports only `brand`, `config/schema.ts` (`ConfigError`), `instructions/source.ts` (`fingerprint`) and the tool contract.

| File | What |
| --- | --- |
| `frontmatter.ts` | the YAML subset of front matter: strict about structure, forgiving about style |
| `discover.ts` | roots, precedence, the walk, symlink containment, supporting files |
| `skill-index.ts` | the index text (sorted, bounded, fingerprinted) and what to append |
| `tool.ts` | the `skill` tool |
| `config.ts` | the `skills` configuration section |

## Discovery

Roots, highest precedence first (`skillRoots`):

1. In each directory from the working directory up to the repository root (nearest `.git`; outside a repository the
   working directory alone): `.<brand.directory>/skills`, `.agents/skills`, `.claude/skills`. Skills written for
   other harnesses work unchanged.
2. `skills.paths` from the configuration, in order.
3. The user's `<config dir>/skills` (`$XDG_CONFIG_HOME/<brand.directory>/skills`, by default `~/.config/<brand.directory>/skills`).

The nearest definition of a name wins; the others are reported as `shadowed`. Within one root the first by path
wins. A skill directory may be up to three levels below its root (grouping folders); a directory with a `SKILL.md`
is not searched further; dot-directories and `node_modules` are skipped. Symbolic links are followed only when the
target is inside the root (for supporting files: inside the skill's directory), and loops are cut. Everything is
sorted by UTF-16 code units, so the result is the same on every machine.

A malformed skill is skipped with a reason for the user, never an exception: no front matter, front matter not
closed, a line that is not `key: value`, a duplicated key, an unclosed quote, no `description`, a name that is not
letters, digits, `-`, `_` and `.` (64 at most), a file over 256 KiB. Warnings that do not skip it: no `name` (the
directory name is used), a name that differs from its directory, a description over 1024 characters, no body.
Unknown front-matter keys (`license`, `allowed-tools`, `metadata` ...) are ignored.

## The index

```
Skills you can load:
<skills lines="4">
Skills are instructions for particular kinds of task, kept as files. When a task matches a skill's description, load the skill with the skill tool (by name) before you start, and follow it.

- commit: How to commit when other people or agents work in the same working tree: stage and commit only your own paths, with a one-line conventional message. Use whenever you are asked to commit.
- harness-testing: How to test light-harness like a user, headless, ...
</skills>
```

Sorted by name, each description on one line and cut at 300 characters, 8000 characters in all; skills past that
are named without descriptions, then counted. A change is `The skills have changed. This list replaces the one you
were given before:` plus the new list; when none are left, a one-line withdrawal with fingerprint `null`. Editing a
skill's body changes nothing in the index (the next load returns the new body); editing a name or description, or
adding or removing a skill, appends an update.

## The tool

`skill`, effect `read`, input `{ "name": string }`. Its description and schema never name a skill. Each call
discovers afresh from the call's working directory, so it returns the current body:

```
<skill name="harness-testing" path="/repo/.claude/skills/harness-testing/SKILL.md">
...the instructions...
</skill>

Supporting files of this skill (paths in its instructions are relative to /repo/.claude/skills/harness-testing):
- /repo/.claude/skills/harness-testing/reference/live-api.md
```

An unknown name: `There is no skill named "deplyo". Did you mean "deploy"? Skills: deploy, review.` A skill that
exists but could not be loaded says why. `display` is `{ skill: { name, path, files } }`.

## Configuration

A new section, `skills`, for `config/schema.ts` (`parseSkillsSection`, `resolveSkillsConfig`):

```json
{ "skills": { "paths": ["~/team-skills"], "disabled": ["old-release-process"] } }
```

`paths` are absolute or start with `~/`. `disabled` leaves names out wherever they are found.

## Engine integration

1. **Tool list.** Put `skillTool({ configDir, extraPaths, disabled })` in the frozen tool list from the first
   baseline and keep it for the session's life, also across a compaction, whether or not any skill exists then, so
   that a skill appearing later never changes the list. Its spec is a constant.
2. **Index.** At every step boundary, `skillIndexSource(discoverSkills({ cwd, configDir, ... }).skills)` and the
   fingerprint the model last had for source `SKILLS_INDEX_KEY` (`"skills"`) go to `skillIndexUpdate`; append what
   it returns as an `instruction.appended` event. Keep the index out of the baseline. As with the MCP catalogue,
   `instructions/source.ts` renders and `state.ts` withdraws only their own keys, so the engine routes the `skills`
   key here or teaches those files the key; the reducer and request builder need nothing new. Discovery is a few
   `readdir` and `stat` calls per root; the engine may run it at step boundaries or watch the roots.
3. **Problems.** Show `SkillSet.problems` to the user (a `diagnostic`, a `/skills` listing); never to the model.
4. **What to record.** The tool's output is frozen in `tool.settled` like any tool's. Skills are files in the
   project or the user's directories, as trusted as `AGENTS.md`; nothing here marks them untrusted. A safety layer
   that wants to know which skill was loaded can read `display.skill.path`.

## Demo

`bun scripts/skills-demo.ts` builds a temporary project with the example skills (`examples/skills/`), a shadowed
and a broken one, and prints what discovery found, the index message, a load, a typo, and the update after an edit.
