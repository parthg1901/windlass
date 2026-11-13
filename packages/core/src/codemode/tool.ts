/**
 * The `run_code` tool: the model writes a short JavaScript program that
 * calls tools as async functions, and only what the program prints and
 * returns comes back. Its spec is a constant: it names every function a
 * program may be given, whatever the session has, so that the frozen tool
 * list never depends on configuration or on which MCP servers exist.
 */
import { join } from "node:path"
import { callStopReasonOf } from "../interrupt.ts"
import type { Json } from "../json.ts"
import type { Tool, ToolContext, ToolResult } from "../tool/tool.ts"
import { type Confine, type ProgramHost, type ProgramLimits, type ProgramOutcome, PROGRAM_LIMITS, runProgram } from "./runner.ts"

export const CODE_TOOL_NAME = "run_code"

/**
 * The tools a program may call, in the order the description names them.
 * Not the others, by decision:
 * - `subagent`, `background_output`, `background_stop`: work that outlives
 *   or runs beside the program, and that the program could neither wait for
 *   nor stop when it ends;
 * - `wake_*`, `memory_*`: records that act later or in other sessions,
 *   which the user should see the model ask for one by one;
 * - `report_check_failure`: the model's own word that it cannot fix a check;
 * - `todo`, `skill`, `history_*`: what they return is for the model to read,
 *   not for a program to filter;
 * - `run_code` itself: one level of programs.
 */
export const PROGRAM_TOOLS = ["read", "write", "edit", "ls", "glob", "grep", "shell", "mcp_search", "mcp_call"] as const

export interface CodeInput {
  readonly code: string
}

const DESCRIPTION = [
  "Run a short JavaScript program that calls tools as async functions, so that many calls, loops and filtering happen in one step. Only what the program prints (console.log) and the value it returns come back to you: print what you need to see.",
  "The functions are read, write, edit, ls, glob, grep, shell and, where MCP servers are connected, mcp_search and mcp_call. Each takes the same arguments object as the tool and resolves with the tool's output text. A call that fails (a command that exits non-zero included) rejects with an error whose `output` is the tool's output; catch it to go on. Calls you do not await one by one run side by side (Promise.all). read resolves with the file's own text, without the line numbers the tool shows you (up to 2000 lines; a note at the end says when there is more).",
  "Each call is a real tool call: approved, recorded and stoppable like a direct one, and the shell's `background` is not available. The program itself can change nothing and reach no network: it has only these functions. The code is the body of an async function: use await and return; no import.",
  `Limits: ${PROGRAM_LIMITS.calls} calls, ${PROGRAM_LIMITS.ownTimeMs / 1000} s of the program's own time (waiting for calls is not counted), ${PROGRAM_LIMITS.memoryBytes / 1024 / 1024} MB of memory. An error says its line, and how many calls had run.`,
  "Use it when the calls follow mechanically from each other (many files, counts, search and replace); call tools directly when you must read a result before deciding.",
].join("\n\n")

/** The spec, as the frozen tool list carries it. */
export const CODE_TOOL_SPEC = {
  name: CODE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", minLength: 1, description: "The program: the body of an async JavaScript function." } },
    required: ["code"],
    additionalProperties: false,
  },
} as const satisfies { name: string; description: string; inputSchema: Json }

/** What the step loop gives a program for one call of `run_code`. */
export interface ProgramSetup {
  /** Carries out the program's calls as calls of the session. */
  readonly host: ProgramHost
  /** The functions the program is given: the tools of `PROGRAM_TOOLS` the session has. */
  readonly tools: readonly string[]
}

export interface CodeToolOptions {
  /** The program's calls for this tool call; `null` where there is no session to make them (the tool then refuses). */
  readonly setup: (context: ToolContext) => ProgramSetup | null
  /** How a program's process is confined, for a call the loop decided to sandbox (`context.sandbox` set). `null`: it cannot be, and such a call is refused. */
  readonly confine: (context: ToolContext) => Confine | null
  /** Where each run's directory is made, for this call: a place the confined process can be given as its own. */
  readonly runDir: (context: ToolContext) => string
  readonly limits?: Partial<ProgramLimits>
  readonly bun?: string
}

export function codeTool(options: CodeToolOptions): Tool<CodeInput> {
  let runs = 0
  return {
    ...CODE_TOOL_SPEC,
    effect: "exec",
    nests: true,
    execute: async (input, context) => {
      const setup = options.setup(context)
      if (setup === null) return result("error", "Programs cannot run here: there is no session to make their calls.", null)
      const sandboxed = context.sandbox !== undefined && context.sandbox !== null
      const confine = sandboxed ? options.confine(context) : null
      if (sandboxed && confine === null) return result("error", "The program was not run: it must run in the sandbox, and this build has none.", null)
      runs += 1
      const outcome = await runProgram({
        source: input.code,
        tools: setup.tools,
        host: setup.host,
        signal: context.signal,
        dir: join(options.runDir(context), `run-${process.pid}-${Date.now().toString(36)}-${runs}`),
        confine,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.bun === undefined ? {} : { bun: options.bun }),
      })
      return renderOutcome(outcome, { ...PROGRAM_LIMITS, ...options.limits }, callStopReasonOf(context.signal))
    },
  }
}

/** The display a client shows a program's result with. */
export interface CodeDisplay {
  readonly code: {
    readonly end: ProgramOutcome["end"]["kind"]
    readonly calls: number
    readonly refusedCalls: number
    readonly durationMs: number
    readonly line: number | null
  }
}

/** The text the model is shown for a program's outcome, and whether it is an error. Rendered once, when the call ends. */
export function renderOutcome(outcome: ProgramOutcome, limits: ProgramLimits, stoppedBy: ReturnType<typeof callStopReasonOf>): ToolResult {
  const end = outcome.end
  const printed = outcome.printed + (outcome.droppedBytes > 0 ? `${outcome.printed.endsWith("\n") || outcome.printed === "" ? "" : "\n"}[${outcome.droppedBytes} more bytes were printed and dropped]\n` : "")
  const after = (text: string) => (printed === "" ? text : `${printed}${printed.endsWith("\n") ? "" : "\n"}${text}`)
  const ran = outcome.calls === 0 ? "No tool call had run." : `${outcome.calls} tool call${outcome.calls === 1 ? " had" : "s had"} run before that; what they did stays.`
  const display = (line: number | null): Json => ({ code: { end: end.kind, calls: outcome.calls, refusedCalls: outcome.refusedCalls, durationMs: outcome.durationMs, line } })
  switch (end.kind) {
    case "returned": {
      const text = end.value === null ? printed : after(end.value)
      return result("success", text === "" ? "The program finished; it printed nothing and returned nothing." : text, display(null))
    }
    case "threw": {
      const error = end.error
      const where = error.line === null ? "" : ` (line ${error.line}${error.column === null ? "" : `, column ${error.column}`})`
      if (error.kind === "syntax") return result("error", `The program did not run: SyntaxError${where}: ${error.message}`, display(error.line))
      const head = error.kind === "tool" ? `The program stopped: the ${error.tool ?? "tool"} call${where} failed and was not caught. Its output:\n${error.message}` : `The program stopped: it threw ${error.name}${where}: ${error.message}`
      return result("error", after(`${head}\n${ran}`), display(error.line))
    }
    case "limit": {
      const why = end.limit === "time" ? `it ran for more than ${limits.ownTimeMs / 1000} s of its own time (time waiting for calls not counted)` : `its memory went over ${Math.round(limits.memoryBytes / 1024 / 1024)} MB`
      return result("error", after(`The program was ended: ${why}.\n${ran}`), display(null))
    }
    case "stopped": {
      const who = stoppedBy === "call" ? "[Stopped by the user." : stoppedBy === "shutdown" ? "[Interrupted: the harness shut down." : "[Interrupted by the user."
      return result("error", after(`${who} The program was ended. ${ran}]`), display(null))
    }
    case "failed":
      return result("error", after(`The program could not run: ${end.reason}\n${ran}`), display(null))
  }
}

function result(status: "success" | "error", output: string, display: Json | null): ToolResult {
  return { status, output, truncation: null, attachments: [], display }
}
