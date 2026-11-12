/**
 * Agents and slash commands against the examples: what discovery finds, what
 * the model is told (the agent index, a session's baseline section, a switch
 * in the middle of a session), a call an agent refuses, a subagent's
 * combined restrictions, the command listing a client shows, and
 * expansions, a typo and the constructs left as text.
 *
 *   bun scripts/agents-demo.ts
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentIndexSource, agentIndexUpdate } from "../packages/core/src/agents/agent-index.ts"
import { discoverAgents } from "../packages/core/src/agents/discover.ts"
import { checkAgentCall, effectiveApprovalMode, unknownToolNames } from "../packages/core/src/agents/restrictions.ts"
import { agentRecordOf, agentSettings, agentSource, agentSwitch, childAgent, findAgent, renderAgentSection, resolveStartAgent } from "../packages/core/src/agents/use.ts"
import { brand } from "../packages/core/src/brand.ts"
import { discoverCommands } from "../packages/core/src/commands/discover.ts"
import { expandCommand, listCommands, lookupCommand, parseSlash } from "../packages/core/src/commands/lookup.ts"
import { COMMANDS as TUI_COMMANDS } from "../packages/tui/src/commands.ts"

const base = realpathSync(mkdtempSync(join(tmpdir(), "lh-agents-demo-")))
try {
  await run()
} finally {
  rmSync(base, { recursive: true, force: true })
}

async function run() {
  const repo = join(base, "repo")
  const cwd = join(repo, "app")
  const configDir = join(base, "config")
  mkdirSync(join(repo, ".git"), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  // The examples as a project keeps them, in .claude/ at the repository root.
  cpSync(join(import.meta.dir, "../examples/agents"), join(repo, ".claude", "agents"), { recursive: true })
  cpSync(join(import.meta.dir, "../examples/commands"), join(repo, ".claude", "commands"), { recursive: true })
  // The user's own reviewer, shadowed by the project's; a broken agent; one asking for a looser approval mode.
  await Bun.write(join(configDir, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: The user's lenient reviewer.\n---\nBe kind.\n")
  await Bun.write(join(cwd, `.${brand.directory}`, "agents", "planner.md"), "---\nname: planner\ndescription: Plans.\neffects: read, think\n---\nPlan.\n")
  await Bun.write(join(cwd, ".agents", "agents", "yolo.md"), "---\nname: yolo\ndescription: Does anything without asking.\napproval: full\ntools: Read, Bash\n---\nGo fast.\n")
  // A user-level command shadowed by the project's, one a built-in hides, a broken one, one with unsupported constructs.
  await Bun.write(join(configDir, "commands", "release-notes.md"), "My own release notes for $1.\n")
  await Bun.write(join(repo, ".claude", "commands", "undo.md"), "Undo the last change by hand.\n")
  await Bun.write(join(repo, ".claude", "commands", "deploy.md"), "---\ndescription: Deploy\n")
  await Bun.write(
    join(repo, ".claude", "commands", "commit.md"),
    "---\ndescription: Commit the staged changes\nallowed-tools: Bash(git commit:*)\n---\nStaged changes:\n!`git diff --staged`\n\nFollow @docs/commit-style.md and write a one-line message. $ARGUMENTS\n",
  )

  const rule = (title: string) => console.log(`\n${"=".repeat(8)} ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`)
  const show = (text: string) => text.replaceAll(base, "<tmp>")
  const toolNames = ["background_output", "background_stop", "edit", "glob", "grep", "ls", "read", "report_check_failure", "shell", "skill", "subagent", "write"]

  rule("Agents: discovery (for the user)")
  const agents = discoverAgents({ cwd, configDir })
  for (const agent of agents.agents) console.log(`  ${agent.name.padEnd(16)} ${agent.root.scope.padEnd(7)} ${show(agent.path)}`)
  console.log("problems:")
  for (const problem of agents.problems) console.log(`  ${problem.severity.padEnd(8)} ${show(problem.path)}: ${show(problem.reason)}`)
  for (const agent of agents.agents) {
    const unknown = unknownToolNames(agent.restrictions, toolNames)
    if (unknown.length > 0) console.log(`  warning  agent "${agent.name}" names tools this session does not have: ${unknown.join(", ")}`)
  }

  rule("What the model is told: the agent index, appended at a step boundary")
  const index = agentIndexUpdate(undefined, agentIndexSource(agents.agents))!
  console.log(`(instruction.appended, source "agent-index", fingerprint ${index.fingerprint!.slice(0, 12)})\n${index.text}`)
  console.log(`next boundary, nothing changed: ${agentIndexUpdate(index.fingerprint, agentIndexSource(agents.agents)) === null ? "nothing appended" : "appended"}`)

  rule("(a) A new session started as the agent reviewer")
  const start = resolveStartAgent(agents, "reviewer", { default: null })
  if (!start.ok || start.agent === null) throw new Error("no reviewer")
  const reviewer = agentRecordOf(start.agent)
  console.log(`agent.switched { from: null, to: { name: "${reviewer.name}", definition: ${reviewer.definition.slice(0, 12)}…, scope: ${reviewer.scope} } }`)
  console.log(`settings: ${JSON.stringify(agentSettings(reviewer, { model: "gpt-6-luna", reasoningEffort: "low" }).settings)}`)
  console.log("the last section of the baseline:")
  console.log(show(renderAgentSection(agentSource(reviewer).value)))
  const missing = resolveStartAgent(agents, undefined, { default: "reveiwer" })
  console.log(`\na misspelt default agent fails the start: ${!missing.ok ? missing.message : "?"}`)

  rule("Restrictions: calls refused when made, the tool list untouched")
  for (const call of [
    { name: "read", effect: "read" },
    { name: "edit", effect: "write" },
    { name: "shell", effect: "exec" },
    { name: "background_stop", effect: "exec" },
    { name: "docs_search", effect: "read", origin: "mcp" },
    { name: "report_check_failure", effect: "read" },
  ] as const) {
    const verdict = checkAgentCall(reviewer, call, { exempt: ["report_check_failure"] })
    console.log(`> ${call.name} (${call.effect}${"origin" in call ? `, ${call.origin}` : ""}): ${verdict.kind === "pass" ? "pass: the approval layer decides as usual" : `refused\n  ${verdict.reason}`}`)
  }
  const yolo = agents.agents.find((agent) => agent.name === "yolo")!
  const mode = effectiveApprovalMode("ask", yolo)
  console.log(`\nthe project's agent "yolo" asks for approval "full" while the user chose "ask": mode ${mode.mode}\n  ${mode.ignored}`)

  rule("(b) A subagent run as an agent")
  const typo = findAgent(agents, "docs-writter")
  console.log(`subagent { agent: "docs-writter" } -> error result: ${typo.ok ? "?" : typo.message}`)
  const docs = findAgent(agents, "docs-writer")
  if (!docs.ok) throw new Error("no docs-writer")
  const child = childAgent(reviewer, docs.agent)!
  console.log(`a child of the reviewer session as "docs-writer": restrictions ${JSON.stringify(child.restrictions)}`)
  console.log(`  so its edit is refused too: ${(checkAgentCall(child, { name: "edit", effect: "write" }) as { reason?: string }).reason ?? "pass"}`)
  const general = childAgent(reviewer, null)!
  console.log(`a child without \`agent\` runs as the parent's agent: "${general.name}"`)

  rule("(c) The user switches the running session to release-captain")
  const captain = findAgent(agents, "release-captain")
  if (!captain.ok) throw new Error("no release-captain")
  const next = agentRecordOf(captain.agent)
  const change = agentSwitch(reviewer, next)!
  console.log(`agent.switched + instruction.appended { source: "agent", fingerprint: ${change.fingerprint!.slice(0, 12)}… }:\n${show(change.text)}`)
  const settings = agentSettings(next, { model: "gpt-6-luna", reasoningEffort: "low" })
  console.log(`\nsettings.changed at the same boundary: ${settings.changed} -> ${JSON.stringify(settings.settings)} (the cache is per settings: one uncached request)`)
  console.log(`switching to the same agent again appends: ${agentSwitch(next, next) === null ? "nothing" : "?"}`)
  console.log(`switching off: ${agentSwitch(next, null)!.text}`)

  rule("Commands: the listing a client shows (with the TUI's built-ins)")
  const commands = discoverCommands({ cwd, configDir })
  const listing = listCommands(commands, TUI_COMMANDS)
  for (const command of listing.commands)
    console.log(`  /${(command.name + (command.argumentHint === null ? "" : ` ${command.argumentHint}`)).padEnd(44)} ${command.hiddenBy === null ? command.description : `(hidden by the built-in /${command.hiddenBy})`}${command.agent === null ? "" : ` [agent: ${command.agent}]`}`)
  console.log("problems:")
  for (const problem of listing.problems) console.log(`  ${problem.severity.padEnd(8)} ${show(problem.path)}: ${show(problem.reason)}`)

  rule("Commands: typed entries")
  for (const entry of ["/release-notes 1.4 1.3", "/release-notes 1.4", '/review "error handling" and tests', "/frontend:test --watch", "/releese-notes 1.4", "/deploy", "/commit fix typo", "/undo", "//etc/hosts is odd", "/usr/bin/env is missing"]) {
    console.log(`\n> ${entry}`)
    const parsed = parseSlash(entry)
    if (parsed === null) {
      console.log("  an ordinary message, sent as it is")
      continue
    }
    if (parsed.kind === "text") {
      console.log(`  text, sent as: ${JSON.stringify(parsed.text)}`)
      continue
    }
    const found = lookupCommand(commands, parsed.name, TUI_COMMANDS)
    if (found.kind === "builtin") console.log(`  the client's built-in /${found.name}`)
    else if (found.kind !== "command") console.log(`  not sent: ${show(found.message)}`)
    else {
      const expansion = expandCommand(found.command, parsed.args)
      console.log(`  from ${show(found.command.path)}${found.command.agent === null ? "" : `, switching to the agent "${found.command.agent}" first`}; sent as:`)
      console.log(expansion.text.split("\n").map((line) => `  | ${line}`).join("\n"))
      if (expansion.missing.length > 0) console.log(`  note: argument ${expansion.missing.join(", ")} was not given (${found.command.argumentHint})`)
      for (const construct of expansion.unsupported) console.log(`  note: line ${construct.line}: ${construct.text} was left as text: ${construct.reason}`)
    }
  }
}
