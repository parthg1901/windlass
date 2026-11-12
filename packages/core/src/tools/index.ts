/** The standard tool set. */
import { sortTools, type AnyTool } from "../tool/tool.ts"
import type { ToolOptions } from "./common.ts"
import { editTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { type GrepOptions, grepTool } from "./grep.ts"
import { lsTool } from "./ls.ts"
import { readTool } from "./read.ts"
import { type ShellOptions, shellTool } from "./shell.ts"
import { todoTool } from "./todo.ts"
import { writeTool } from "./write.ts"

export interface StandardToolOptions extends ToolOptions {
  readonly grep?: GrepOptions
  readonly shell?: Omit<ShellOptions, "spillDir">
}

/**
 * The standard tools, sorted by name. Their names, descriptions and schemas do
 * not depend on the options or the machine, so the frozen tool list hashes the
 * same everywhere.
 */
export function createStandardTools(options: StandardToolOptions): AnyTool[] {
  return sortTools<AnyTool>([
    editTool(),
    globTool(),
    grepTool(options.grep),
    lsTool(),
    readTool(),
    shellTool({ ...options.shell, spillDir: options.spillDir }),
    todoTool(),
    writeTool(),
  ])
}

export { editTool, globTool, grepTool, lsTool, readTool, shellTool, todoTool, writeTool }
export { TODO_TOOL_NAME, currentTodos, renderTodos } from "./todo.ts"
export type { TodoInput, TodoItem, TodoList, TodoStatus } from "./todo.ts"
export type { EditInput } from "./edit.ts"
export type { GlobInput } from "./glob.ts"
export type { GrepInput, GrepOptions } from "./grep.ts"
export type { LsInput } from "./ls.ts"
export type { ReadInput } from "./read.ts"
export type { ShellInput, ShellOptions } from "./shell.ts"
export type { WriteInput } from "./write.ts"
export type { ToolOptions } from "./common.ts"
