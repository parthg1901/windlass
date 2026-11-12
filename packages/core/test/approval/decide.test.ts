import { describe, expect, test } from "bun:test"
import { brand } from "../../src/brand.ts"
import {
  type ApprovalMode,
  CLEAN,
  type CallFacts,
  type Decision,
  type Grant,
  PROJECT_GRANT_TTL_MS,
  decide,
  escalationFacts,
} from "../../src/approval/index.ts"
import { HOME, NOW, TAINTED, WS, call, code, fact, input, sessionGrant } from "./fixtures.ts"

const CASES: Record<string, CallFacts> = {
  read: call({ tool: "read", effect: "read", paths: [fact(`${WS}/a.ts`, "workspace")] }),
  "write-in": call({ tool: "write", effect: "write", paths: [fact(`${WS}/a.ts`, "workspace")] }),
  "write-out": call({ tool: "write", effect: "write", paths: [fact("/o/x.txt", "outside")] }),
  exec: call({ tool: "shell", effect: "exec", command: "make test" }),
  "exec-net": call({ tool: "shell", effect: "exec", command: "npm install", escalation: { network: true, write: [] } }),
  net: call({ tool: "web_fetch", effect: "network" }),
  // A write that changes only the harness's own records (`Tool.changes`): no path, no sandbox, nothing outbound.
  records: call({ tool: "wake_cancel", effect: "write", changes: "records" }),
}

/** Every grant the cases could use, given at seq 5, before the taint at seq 10. */
const EARLY: Grant[] = [
  sessionGrant({ kind: "exec-sandboxed" }, 5),
  sessionGrant({ kind: "exec-unsandboxed" }, 5),
  sessionGrant({ kind: "sandbox-network" }, 5),
  sessionGrant({ kind: "write", root: WS }, 5),
  sessionGrant({ kind: "write", root: "/o" }, 5),
  sessionGrant({ kind: "tool", tool: "web_fetch" }, 5),
  sessionGrant({ kind: "records", tool: "wake_cancel" }, 5),
]

// case       sandbox taint  grants | ask: present absent | auto: present absent | full: present absent
const TABLE = `
read       yes clean none   | R R | R R | R R
read       yes clean early  | R R | R R | R R
read       yes taint none   | R R | R R | R R
read       yes taint early  | R R | R R | R R
read       no  clean none   | R R | R R | R R
read       no  clean early  | R R | R R | R R
read       no  taint none   | R R | R R | R R
read       no  taint early  | R R | R R | R R
write-in   yes clean none   | A D | R R | R R
write-in   yes clean early  | R R | R R | R R
write-in   yes taint none   | A D | R R | R R
write-in   yes taint early  | R R | R R | R R
write-in   no  clean none   | A D | R R | R R
write-in   no  clean early  | R R | R R | R R
write-in   no  taint none   | A D | R R | R R
write-in   no  taint early  | R R | R R | R R
write-out  yes clean none   | A D | A D | R R
write-out  yes clean early  | R R | R R | R R
write-out  yes taint none   | A D | A D | R R
write-out  yes taint early  | R R | R R | R R
write-out  no  clean none   | A D | A D | R R
write-out  no  clean early  | R R | R R | R R
write-out  no  taint none   | A D | A D | R R
write-out  no  taint early  | R R | R R | R R
exec       yes clean none   | A D | S S | R R
exec       yes clean early  | S S | S S | R R
exec       yes taint none   | A D | S S | S S
exec       yes taint early  | S S | S S | S S
exec       no  clean none   | A D | A D | R R
exec       no  clean early  | R R | R R | R R
exec       no  taint none   | A D | A D | A D
exec       no  taint early  | A D | A D | A D
exec-net   yes clean none   | A D | A D | R R
exec-net   yes clean early  | N N | N N | R R
exec-net   yes taint none   | A D | A D | A D
exec-net   yes taint early  | A D | A D | A D
exec-net   no  clean none   | A D | A D | R R
exec-net   no  clean early  | R R | R R | R R
exec-net   no  taint none   | A D | A D | A D
exec-net   no  taint early  | A D | A D | A D
net        yes clean none   | A D | A D | R R
net        yes clean early  | R R | R R | R R
net        yes taint none   | A D | A D | A D
net        yes taint early  | A D | A D | A D
net        no  clean none   | A D | A D | R R
net        no  clean early  | R R | R R | R R
net        no  taint none   | A D | A D | A D
net        no  taint early  | A D | A D | A D
records    yes clean none   | A D | R R | R R
records    yes clean early  | R R | R R | R R
records    yes taint none   | A D | R R | R R
records    yes taint early  | R R | R R | R R
records    no  clean none   | A D | R R | R R
records    no  clean early  | R R | R R | R R
records    no  taint none   | A D | R R | R R
records    no  taint early  | R R | R R | R R
`

const MODES: ApprovalMode[] = ["ask", "auto", "full"]

describe("decision table", () => {
  const rows = TABLE.trim().split("\n")
  test("covers every case, sandbox, taint and grant combination", () => {
    expect(rows.length).toBe(Object.keys(CASES).length * 2 * 2 * 2)
  })
  for (const row of rows) {
    const [head, ...columns] = row.split("|").map((part) => part.trim())
    const [name, sandbox, taint, grants] = head!.split(/\s+/) as [string, string, string, string]
    test(row, () => {
      const expected = columns.flatMap((column) => column.split(" "))
      const actual = MODES.flatMap((mode) =>
        [true, false].map((present) =>
          code(
            decide(
              input({
                policy: { mode, unattended: "deny", taint: "enforce" },
                call: CASES[name]!,
                sandbox: sandbox === "yes" ? { available: true } : { available: false, reason: "bwrap is not installed." },
                taint: taint === "taint" ? TAINTED : CLEAN,
                grants: grants === "early" ? EARLY : [],
                present,
              }),
            ),
          ),
        ),
      )
      expect(actual).toEqual(expected)
    })
  }
})

function ask(decision: Decision) {
  if (decision.kind !== "ask") throw new Error(`expected ask, got ${decision.kind}`)
  return decision
}

describe("questions", () => {
  test("auto asks about network for an escalated command, remembering only network for this session", () => {
    const decision = ask(decide(input({ call: CASES["exec-net"]! })))
    expect(decision.question.title).toBe("Allow network access for this command?")
    expect(decision.question.subject).toBe("npm install")
    expect(decision.then).toEqual({ kind: "run_sandboxed", network: true, writableRoots: [] })
    expect(decision.question.choices.map((choice) => choice.id)).toEqual(["once", "session", "deny"])
    const session = decision.question.choices[1]!
    expect(session.grants).toEqual([{ scope: "session", rule: { kind: "sandbox-network" } }])
    expect(session.remembers).toBe("network for sandboxed commands, for the rest of this session")
  })

  test("ask mode asks to run a command in the sandbox and says what the sandbox allows", () => {
    const decision = ask(decide(input({ policy: { mode: "ask", unattended: "deny", taint: "enforce" }, call: CASES.exec! })))
    expect(decision.question.title).toBe("Run this command in the sandbox?")
    expect(decision.question.details[0]).toContain(`write only inside ${WS}`)
    expect(decision.question.details[0]).toContain("has no network")
    expect(decision.then).toEqual({ kind: "run_sandboxed", network: false, writableRoots: [] })
  })

  test("without a sandbox the question gives the reason and runs unsandboxed on approval", () => {
    const decision = ask(decide(input({ call: CASES.exec!, sandbox: { available: false, reason: "bwrap is not installed." } })))
    expect(decision.question.title).toBe("Run this command without the sandbox?")
    expect(decision.question.details.join("\n")).toContain("bwrap is not installed.")
    expect(decision.then).toEqual({ kind: "run" })
    expect(decision.question.choices.map((choice) => choice.id)).toEqual(["once", "session", "deny"])
  })

  test("under taint the question names the source and says earlier approvals do not apply", () => {
    const decision = ask(decide(input({ call: CASES.net!, taint: TAINTED, grants: EARLY })))
    expect(decision.question.title).toBe("Allow web_fetch to use the network?")
    expect(decision.question.details).toContain("Content from the network tool web_fetch is in this conversation and may contain instructions aimed at the model.")
    expect(decision.question.details).toContain("Approvals for this given before that content arrived do not apply.")
  })

  test("a write outside the workspace remembers its directory, at session or project scope", () => {
    const decision = ask(decide(input({ call: CASES["write-out"]! })))
    expect(decision.question.title).toBe("Allow write: writing /o/x.txt?")
    expect(decision.question.choices.map((choice) => [choice.id, choice.grants])).toEqual([
      ["once", []],
      ["session", [{ scope: "session", rule: { kind: "write", root: "/o" } }]],
      ["project", [{ scope: "project", rule: { kind: "write", root: "/o" } }]],
      ["deny", []],
    ])
    expect(decision.question.choices[2]!.remembers).toBe("writes by file tools under /o, in this project for 30 days")
  })

  test("in ask mode a workspace edit can be remembered for the whole workspace", () => {
    const decision = ask(decide(input({ policy: { mode: "ask", unattended: "deny", taint: "enforce" }, call: CASES["write-in"]! })))
    expect(decision.question.choices[1]!.grants).toEqual([{ scope: "session", rule: { kind: "write", root: WS } }])
  })
})

describe("paths", () => {
  const protectedPath = fact(`${WS}/.git/hooks/pre-commit`, "protected")
  const writeHook = call({ tool: "write", effect: "write", paths: [protectedPath] })

  test("writes to .git and the project directory ask in auto; a workspace grant does not cover them", () => {
    expect(code(decide(input({ call: writeHook })))).toBe("A")
    expect(code(decide(input({ call: writeHook, grants: [sessionGrant({ kind: "write", root: WS }, 1)] })))).toBe("A")
    expect(code(decide(input({ call: writeHook, grants: [sessionGrant({ kind: "write", root: `${WS}/.git/hooks` }, 1)] })))).toBe("R")
    const config = call({ tool: "write", effect: "write", paths: [fact(`${WS}/.${brand.directory}/config.json`, "protected")] })
    expect(ask(decide(input({ call: config }))).question.details[0]).toContain(`${WS}/.${brand.directory}`)
    expect(code(decide(input({ call: config, policy: { mode: "full", unattended: "deny", taint: "enforce" } })))).toBe("R")
  })

  test("reading a hidden path asks once only, except in full", () => {
    const secret = call({ tool: "read", effect: "read", paths: [fact(`${HOME}/.ssh/id_ed25519`, "hidden")] })
    const decision = ask(decide(input({ call: secret })))
    expect(decision.question.choices.map((choice) => choice.id)).toEqual(["once", "deny"])
    expect(decision.question.details[0]).toContain("credential store")
    expect(code(decide(input({ call: secret, policy: { mode: "full", unattended: "deny", taint: "enforce" } })))).toBe("R")
  })

  test("writing a hidden path is denied with a reason, in ask and auto", () => {
    const secret = call({ tool: "write", effect: "write", paths: [fact(`${HOME}/.ssh/authorized_keys`, "hidden")] })
    for (const mode of ["ask", "auto"] as const) {
      const decision = decide(input({ call: secret, policy: { mode, unattended: "deny", taint: "enforce" } }))
      expect(decision).toEqual({
        kind: "deny",
        message: `Not run: write may not write ${HOME}/.ssh/authorized_keys: it is a credential store or the harness's own data.`,
        stop: false,
      })
    }
  })

  test("a tool that changes only the harness's own records is asked about as that, in ask mode only, and can be remembered by name", () => {
    const records = call({ tool: "memory_save", effect: "write", changes: "records" })
    const ASK = { mode: "ask", unattended: "deny", taint: "enforce" } as const
    expect(decide(input({ call: records })).kind).toBe("run")
    expect(decide(input({ call: records, present: false, sandbox: { available: false, reason: "no bwrap" } })).kind).toBe("run")
    const asked = ask(decide(input({ policy: ASK, call: records })))
    expect(asked.needs).toEqual([{ kind: "records", tool: "memory_save" }])
    expect(asked.question.title).toBe(`Allow memory_save: changing ${brand.name}'s own records?`)
    expect(asked.question.details).toEqual([`It changes only what ${brand.name} keeps for itself (wake-ups, notes): no file of the workspace, and nothing is sent anywhere.`])
    expect(asked.question.choices.map((choice) => [choice.id, choice.grants])).toEqual([
      ["once", []],
      ["session", [{ scope: "session", rule: { kind: "records", tool: "memory_save" } }]],
      ["project", [{ scope: "project", rule: { kind: "records", tool: "memory_save" } }]],
      ["deny", []],
    ])
    // The approval is for that tool: another one asks again.
    const remembered = [sessionGrant({ kind: "records", tool: "memory_save" }, 5)]
    expect(decide(input({ policy: ASK, call: records, grants: remembered })).kind).toBe("run")
    expect(decide(input({ policy: ASK, call: call({ tool: "wake_cancel", effect: "write", changes: "records" }), grants: remembered })).kind).toBe("ask")
    // An MCP server's tool is asked about by name whatever it declares.
    expect(ask(decide(input({ call: { ...records, origin: "mcp" } }))).needs).toEqual([{ kind: "tool", tool: "memory_save" }])
  })

  test("a write tool that names no path, or a path that cannot be resolved, asks once only", () => {
    const nameless = ask(decide(input({ call: call({ tool: "patch", effect: "write" }) })))
    expect(nameless.question.choices.map((choice) => choice.id)).toEqual(["once", "deny"])
    const loop = ask(decide(input({ call: call({ tool: "write", effect: "write", paths: [{ given: "loop/x", real: null, place: "outside", relative: null }] }) })))
    expect(loop.question.choices.map((choice) => choice.id)).toEqual(["once", "deny"])
  })
})

describe("escalation to write", () => {
  const context = {
    cwd: WS,
    workspace: WS,
    home: HOME,
    hiddenPaths: [`${HOME}/.ssh`],
    readlink: () => null,
  }
  const shell = (write: string[]) =>
    call({ tool: "shell", effect: "exec", command: "pip install .", escalation: escalationFacts({ network: false, write }, context) })

  test("asks with the real path and can remember it for the project", () => {
    const decision = ask(decide(input({ call: shell(["/opt/cache/pip"]) })))
    expect(decision.question.title).toBe("Allow writing to /opt/cache/pip for this command?")
    expect(decision.then).toEqual({ kind: "run_sandboxed", network: false, writableRoots: ["/opt/cache/pip"] })
    expect(decision.question.choices[2]!.grants).toEqual([{ scope: "project", rule: { kind: "sandbox-write", root: "/opt/cache/pip" } }])
  })

  test("a grant covers paths under its root and nothing beside it", () => {
    const grants = [{ scope: "project", rule: { kind: "sandbox-write", root: "/opt/cache" }, at: null, grantedAt: NOW } as const]
    expect(decide(input({ call: shell(["/opt/cache/pip/wheels"]), grants }))).toEqual({ kind: "run_sandboxed", network: false, writableRoots: ["/opt/cache/pip/wheels"] })
    expect(code(decide(input({ call: shell(["/opt/cache2"]), grants })))).toBe("A")
  })

  test("project grants expire", () => {
    const grants = [{ scope: "project", rule: { kind: "sandbox-write", root: "/opt/cache" }, at: null, grantedAt: NOW - PROJECT_GRANT_TTL_MS } as const]
    expect(code(decide(input({ call: shell(["/opt/cache"]), grants })))).toBe("A")
  })

  test("paths inside the workspace need nothing; the home directory, the root and hidden paths are refused", () => {
    expect(decide(input({ call: shell(["build"]) }))).toEqual({ kind: "run_sandboxed", network: false, writableRoots: [] })
    expect(decide(input({ call: shell(["~"]) }))).toMatchObject({ kind: "deny", message: expect.stringContaining("home directory") })
    expect(decide(input({ call: shell(["/"]) }))).toMatchObject({ kind: "deny" })
    expect(decide(input({ call: shell(["/"]), policy: { mode: "full", unattended: "deny", taint: "enforce" } }))).toEqual({ kind: "run" })
    expect(decide(input({ call: shell(["~/.ssh"]) }))).toMatchObject({ kind: "deny", message: expect.stringContaining("stay hidden") })
  })
})

describe("taint and grants", () => {
  test("a grant given after the taint began applies; one given before does not", () => {
    const net = CASES["exec-net"]!
    expect(code(decide(input({ call: net, taint: TAINTED, grants: [sessionGrant({ kind: "sandbox-network" }, 9)] })))).toBe("A")
    expect(code(decide(input({ call: net, taint: TAINTED, grants: [sessionGrant({ kind: "sandbox-network" }, 11)] })))).toBe("N")
  })

  test("project grants for outbound calls never apply while tainted", () => {
    const grants: Grant[] = [{ scope: "project", rule: { kind: "tool", tool: "web_fetch" }, at: null, grantedAt: NOW }]
    expect(code(decide(input({ call: CASES.net!, grants })))).toBe("R")
    expect(code(decide(input({ call: CASES.net!, grants, taint: TAINTED })))).toBe("A")
  })

  test("taint off ignores the taint state", () => {
    const policy = { mode: "full", unattended: "deny", taint: "off" } as const
    expect(code(decide(input({ policy, call: CASES.exec!, taint: TAINTED })))).toBe("R")
    expect(code(decide(input({ policy, call: CASES.net!, taint: TAINTED })))).toBe("R")
  })

  test("MCP tools ask in ask and auto whatever effect they declare, run in full until tainted", () => {
    const mcp = call({ tool: "docs__search", effect: "read", origin: "mcp" })
    expect(code(decide(input({ call: mcp })))).toBe("A")
    expect(ask(decide(input({ call: mcp }))).question.title).toBe("Allow the MCP tool docs__search?")
    expect(code(decide(input({ call: mcp, policy: { mode: "full", unattended: "deny", taint: "enforce" } })))).toBe("R")
    expect(code(decide(input({ call: mcp, policy: { mode: "full", unattended: "deny", taint: "enforce" }, taint: TAINTED })))).toBe("A")
  })
})

describe("unattended", () => {
  test("deny tells the model what approval was needed; stop also ends the run", () => {
    expect(decide(input({ call: CASES.net!, present: false }))).toEqual({
      kind: "deny",
      message: "Not run: this call needs the user's approval for using web_fetch, and this run has no one to approve it.",
      stop: false,
    })
    expect(decide(input({ call: CASES.net!, present: false, policy: { mode: "auto", unattended: "stop", taint: "enforce" } }))).toMatchObject({
      kind: "deny",
      stop: true,
    })
  })

  test("a policy denial does not stop the run", () => {
    const secret = call({ tool: "write", effect: "write", paths: [fact(`${HOME}/.ssh/x`, "hidden")] })
    expect(decide(input({ call: secret, present: false, policy: { mode: "auto", unattended: "stop", taint: "enforce" } }))).toMatchObject({ stop: false })
  })
})
