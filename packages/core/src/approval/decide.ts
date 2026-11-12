/**
 * The decision for one tool call: run, run sandboxed, ask the user, or deny.
 *
 * It is made from the tool's effect class and origin, facts about its path
 * arguments that can be established without parsing anything (`pathFact`),
 * the explicit escalation argument of a shell call, whether a sandbox exists,
 * the session's taint, remembered grants and whether anyone is present. A
 * shell command's text is shown to the user and never interpreted.
 *
 * How: the mode and effect give a way to run the call and a list of needs
 * (what it requires beyond the mode). Taint adds needs to calls that could
 * send data out. Needs a valid grant covers are dropped. No needs left: run.
 * Otherwise ask about what is left, or, with no one present, deny.
 */
import { dirname } from "node:path"
import { brand } from "../brand.ts"
import type { ToolEffect } from "../tool/tool.ts"
import type { Escalation } from "./escalation.ts"
import { type Grant, type GrantScope, type GrantTemplate, type Need, isCovered, isOutbound, rememberableScopes, ruleFor } from "./grants.ts"
import { type PathFact, isWithin, protectedRoots } from "./paths.ts"
import type { ApprovalPolicy } from "./policy.ts"
import { CLEAN, type TaintState, describeTaint } from "./taint.ts"
import { deniedMessage, describeNeed, describeRemembered, listOf, unattendedMessage } from "./texts.ts"

export interface CallFacts {
  readonly tool: string
  readonly effect: ToolEffect
  /** `mcp`: provided by an MCP server, which runs outside the sandbox; its declared effect is not trusted. */
  readonly origin: "builtin" | "mcp"
  /** Classified path arguments (`Tool.touches`). A tool that defaults to the working directory passes it. */
  readonly paths: readonly PathFact[]
  /** A shell call's command, shown in the question. */
  readonly command: string | null
  /** A shell call's `sandbox` argument, classified. */
  readonly escalation: Escalation | null
  /** `records`: the call changes only the harness's own records, no file and nothing outside, and runs no command (`Tool.changes`). */
  readonly changes?: "records"
  /** Facts about this call the question shows besides its own (`Tool.cautions`), one per line. */
  readonly cautions?: readonly string[]
}

export type SandboxState = { readonly available: true } | { readonly available: false; readonly reason: string }

export interface DecisionInput {
  readonly policy: Pick<ApprovalPolicy, "mode" | "unattended" | "taint">
  readonly call: CallFacts
  readonly sandbox: SandboxState
  readonly taint: TaintState
  /** This session's grants and the project's. */
  readonly grants: readonly Grant[]
  /** A person can answer now (interactive client), as opposed to a script, an eval or a scheduled run. */
  readonly present: boolean
  /** Milliseconds since the epoch, for project grant expiry. */
  readonly now: number
  /** Real paths. */
  readonly workspace: string
  readonly home: string
}

export type RunDecision =
  | { readonly kind: "run" }
  /** Run under `defaultPolicy`, with the network on when `network`, and `writableRoots` added to the workspace. */
  | { readonly kind: "run_sandboxed"; readonly network: boolean; readonly writableRoots: readonly string[] }

export type Decision =
  | RunDecision
  /** Ask; on an approving choice, run as `then`. `needs` are what the question is about. */
  | { readonly kind: "ask"; readonly question: Question; readonly needs: readonly Need[]; readonly then: RunDecision }
  /** `message` is the tool result the model sees. `stop`: end the run too (unattended `stop`). */
  | { readonly kind: "deny"; readonly message: string; readonly stop: boolean }

export interface Question {
  /** One line, ending in a question mark. */
  readonly title: string
  /** The command, the path or the tool, shown verbatim. */
  readonly subject: string
  /** Facts the user needs to answer, one per line. */
  readonly details: readonly string[]
  readonly choices: readonly Choice[]
}

export interface Choice {
  readonly id: "once" | GrantScope | "deny"
  readonly label: string
  readonly approve: boolean
  /** What picking it remembers, in words; null for nothing. */
  readonly remembers: string | null
  /** What picking it stores (`stampGrants`). Exactly what `remembers` says. */
  readonly grants: readonly GrantTemplate[]
}

type Plan = { readonly run: RunDecision; readonly needs: readonly Need[] } | { readonly deny: string }

export function decide(input: DecisionInput): Decision {
  const taint = input.policy.taint === "enforce" ? input.taint : CLEAN
  const plan = planCall(input, taint.tainted)
  if ("deny" in plan) return { kind: "deny", message: deniedMessage(plan.deny), stop: false }
  const needs = plan.needs.filter((need) => !isCovered(need, input.grants, taint, input.now))
  if (needs.length === 0) return plan.run
  if (!input.present) return { kind: "deny", message: unattendedMessage(needs), stop: input.policy.unattended === "stop" }
  return { kind: "ask", question: question(input, needs, plan.run, taint), needs, then: plan.run }
}

const RUN: RunDecision = { kind: "run" }

function planCall(input: DecisionInput, tainted: boolean): Plan {
  const call = input.call
  const full = input.policy.mode === "full"
  if (call.origin === "mcp" || call.effect === "network") return { run: RUN, needs: full && !tainted ? [] : [{ kind: "tool", tool: call.tool }] }
  if (call.effect === "read") {
    if (full) return { run: RUN, needs: [] }
    return {
      run: RUN,
      needs: call.paths.flatMap((path): Need[] => (path.place === "hidden" ? [{ kind: "read-hidden", path: path.real ?? path.given }] : [])),
    }
  }
  // A call that changes only the harness's own records touches no file, runs nothing and sends nothing out: there
  // is no path to check and nothing the sandbox would contain, whether one exists on this machine or not. Only the
  // mode in which every change asks asks about it. (`callFacts` says which calls these are: a write to the records,
  // or a call of an `exec` tool that runs no command, such as a wake-up that is a timer or a webhook.)
  if (call.changes === "records") return { run: RUN, needs: input.policy.mode === "ask" ? [{ kind: "records", tool: call.tool }] : [] }
  if (call.effect === "write") return full ? { run: RUN, needs: [] } : planWrite(input)
  return planExec(input, tainted)
}

function planWrite(input: DecisionInput): Plan {
  const paths = input.call.paths
  const hidden = paths.find((path) => path.place === "hidden")
  if (hidden) return { deny: `${input.call.tool} may not write ${hidden.real ?? hidden.given}: it is a credential store or the harness's own data` }
  if (paths.length === 0) return { run: RUN, needs: [{ kind: "write", path: null, root: null, protectedRoot: null }] }
  const ask = input.policy.mode === "ask"
  return {
    run: RUN,
    needs: paths.flatMap((path): Need[] => {
      if (path.real === null) return [{ kind: "write", path: null, root: null, protectedRoot: null }]
      if (path.place === "workspace") return ask ? [{ kind: "write", path: path.real, root: input.workspace, protectedRoot: null }] : []
      if (path.place === "protected") {
        const protectedRoot = protectedRoots(input.workspace).find((root) => isWithin(root, path.real!)) ?? null
        return [{ kind: "write", path: path.real, root: dirname(path.real), protectedRoot }]
      }
      return [{ kind: "write", path: path.real, root: dirname(path.real), protectedRoot: null }]
    }),
  }
}

function planExec(input: DecisionInput, tainted: boolean): Plan {
  const mode = input.policy.mode
  if (mode === "full" && !tainted) return { run: RUN, needs: [] }
  if (!input.sandbox.available) return { run: RUN, needs: [{ kind: "exec-unsandboxed" }] }
  const escalation = input.call.escalation
  const bad = escalation?.write.map((path) => refusedRoot(path, input)).find((reason) => reason !== null)
  if (bad) return { deny: bad }
  const roots = (escalation?.write ?? []).filter((path) => path.place === "outside").map((path) => path.real!)
  const network = escalation?.network ?? false
  return {
    run: { kind: "run_sandboxed", network, writableRoots: roots },
    needs: [
      ...(mode === "ask" ? [{ kind: "exec-sandboxed" } as const] : []),
      ...(network ? [{ kind: "sandbox-network" } as const] : []),
      ...roots.map((path) => ({ kind: "sandbox-write", path }) as const),
    ],
  }
}

/** Why the sandbox will not be widened to this path, or null when it may be asked for. */
function refusedRoot(path: PathFact, input: DecisionInput): string | null {
  if (path.real === null) return `the sandbox cannot be widened to ${path.given}: the path could not be resolved`
  if (path.place === "hidden") return `the sandbox cannot be widened to ${path.real}: credential stores and the harness's own data stay hidden`
  if (path.place !== "outside") return null
  // A writable home directory (or anything above it) lets a command change what runs at the next login.
  if (path.real === "/" || isWithin(path.real, input.home))
    return `the sandbox cannot be widened to ${path.real}: it is the home directory or contains it; name a narrower directory`
  return null
}

function question(input: DecisionInput, needs: readonly Need[], then: RunDecision, taint: TaintState): Question {
  const call = input.call
  const has = (kind: Need["kind"]) => needs.some((need) => need.kind === kind)
  const choices = [
    { id: "once", label: "Allow once", approve: true, remembers: null, grants: [] } as Choice,
    ...(["session", "project"] as const).flatMap((scope): Choice[] => {
      if (!needs.every((need) => rememberableScopes(need).includes(scope))) return []
      return [
        {
          id: scope,
          label: scope === "session" ? "Allow for this session" : "Always allow in this project",
          approve: true,
          remembers: `${listOf(needs.map(describeRemembered))}, ${scope === "session" ? "for the rest of this session" : "in this project for 30 days"}`,
          grants: needs.map((need) => ({ scope, rule: ruleFor(need)! })),
        },
      ]
    }),
    { id: "deny", label: "Don't allow", approve: false, remembers: null, grants: [] } as Choice,
  ]
  const details = [
    ...(call.cautions ?? []),
    ...detailsFor(input, needs, then),
    ...(taint.tainted && needs.some(isOutbound) ? [describeTaint(taint), "Approvals for this given before that content arrived do not apply."] : []),
  ]
  return { title: titleFor(input, needs, has), subject: subjectFor(call), details, choices }
}

function titleFor(input: DecisionInput, needs: readonly Need[], has: (kind: Need["kind"]) => boolean): string {
  const call = input.call
  if (call.origin === "mcp") return `Allow the MCP tool ${call.tool}?`
  if (call.effect === "network") return `Allow ${call.tool} to use the network?`
  if (has("exec-unsandboxed")) return "Run this command without the sandbox?"
  if (call.effect === "exec" && call.changes !== "records") {
    const writes = needs.flatMap((need) => (need.kind === "sandbox-write" ? [need.path] : []))
    const extra = [...(has("sandbox-network") ? ["network access"] : []), ...(writes.length > 0 ? [`writing to ${listOf(writes)}`] : [])]
    if (has("exec-sandboxed")) return extra.length === 0 ? "Run this command in the sandbox?" : `Run this command in the sandbox with ${listOf(extra)}?`
    return `Allow ${listOf(extra)} for this command?`
  }
  return `Allow ${call.tool}: ${listOf(needs.map(describeNeed))}?`
}

function subjectFor(call: CallFacts): string {
  if (call.command !== null) return call.command
  if (call.paths.length > 0) return call.paths.map((path) => path.real ?? path.given).join("\n")
  return call.tool
}

function detailsFor(input: DecisionInput, needs: readonly Need[], then: RunDecision): string[] {
  return needs.flatMap((need): string[] => {
    if (need.kind === "exec-unsandboxed")
      return [
        input.sandbox.available
          ? "Mode full runs commands without the sandbox, but untrusted content is in the conversation."
          : `The sandbox is unavailable on this machine: ${input.sandbox.reason}`,
        "The command would run with your full permissions, including the network and your credentials.",
      ]
    if (need.kind === "exec-sandboxed")
      return [
        `In the sandbox it can write only inside ${input.workspace} and the temp directory, cannot read credential stores, and ${then.kind === "run_sandboxed" && then.network ? "has network access" : "has no network"}.`,
      ]
    if (need.kind === "sandbox-network") return ["With network access the command can send anything it can read to any host."]
    if (need.kind === "sandbox-write") return [`Programs outside the sandbox may later run or load what it writes under ${need.path}.`]
    if (need.kind === "write") {
      if (need.path === null) return ["The tool did not name a path that could be checked."]
      if (need.protectedRoot !== null)
        return [`${need.path} is inside ${need.protectedRoot}: changes there can run later outside the sandbox (git hooks) or change ${brand.name}'s project settings.`]
      return need.root === input.workspace ? [] : [`${need.path} is outside the workspace.`]
    }
    if (need.kind === "read-hidden") return [`${need.path} is in a credential store; what it reads is sent to the model provider.`]
    if (need.kind === "records") return [`It changes only what ${brand.name} keeps for itself (wake-ups, notes): no file of the workspace, and nothing is sent anywhere.`]
    return input.call.origin === "mcp"
      ? ["MCP tools run outside the sandbox with your permissions; what it receives can leave this machine."]
      : ["It can send data from this conversation to the network."]
  })
}
