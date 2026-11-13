/**
 * Code mode as the step loop offers it (`codemode/` has the module).
 *
 * - `run_code` is in a session's frozen tool list from its first baseline,
 *   with a constant spec, whether or not an MCP server exists: the functions
 *   a program is given are the tools of `PROGRAM_TOOLS` the session's list
 *   has, decided when a program starts, never by changing the list.
 * - The program's call needs no question (`Tool.nests`): the approval layer
 *   only says how it runs, confined wherever there is a sandbox.
 * - Every call the program makes is a call of the step, nested under the
 *   program's (`tool.called.parent`), made by the session that runs the
 *   step (`StepTools.program`): decided, recorded, scheduled and stopped as
 *   any call, its result redacted and capped once like any.
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../brand.ts"
import { type Confine, type ProgramLimits, type ProgramSetup, codeTool } from "../codemode/index.ts"
import type { CommandSandbox } from "../sandbox/command.ts"
import type { AnyTool, ToolContext } from "../tool/tool.ts"

/** How an engine is told to offer code mode. Everything has a default; tests pass their own. */
export interface CodeModeSetup {
  readonly limits?: Partial<ProgramLimits>
  /** The Bun a program runs with. Default: the harness's own. */
  readonly bun?: string
}

export function engineCodeTool(options: {
  readonly setup: CodeModeSetup
  /** The calls of a program, made by the session that runs the step, or `null` when none does. */
  readonly program: (context: ToolContext) => ProgramSetup | null
  /** The sandbox commands of the session run in; `null` without the approval layer. */
  readonly sandbox: () => CommandSandbox | null
  /** The session's own temp directory, when it has one. */
  readonly temp: (context: ToolContext) => string | null
}): AnyTool {
  return codeTool({
    setup: options.program,
    confine: () => {
      const sandbox = options.sandbox()
      const confined = sandbox?.confined
      if (sandbox === null || confined === undefined || !sandbox.state.available) return null
      const confine: Confine = (input) => {
        const plan = confined({ cwd: input.root, root: input.root, argv: input.argv, env: input.env })
        return plan.kind === "ready" ? { argv: plan.argv, env: plan.env, cwd: plan.cwd } : { refused: `it must run in the sandbox, which is unavailable: ${plan.reason}` }
      }
      return confine
    },
    // A directory of the session's own temp directory, which nothing else of the machine is in; without one, a
    // directory of this user's under the machine's temp directory.
    runDir: (context) => join(options.temp(context) ?? join(tmpdir(), `${brand.directory}-${process.getuid?.() ?? 0}`), ".programs"),
    ...(options.setup.limits === undefined ? {} : { limits: options.setup.limits }),
    ...(options.setup.bun === undefined ? {} : { bun: options.setup.bun }),
  }) as unknown as AnyTool
}
