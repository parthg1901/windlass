/**
 * What runs in the program's own process before the program: the tool
 * functions as stubs that send each call to the harness, `console` and the
 * standard streams turned into messages, and the program loaded as a module
 * so that an error names its line. The text is written to the run's
 * directory as `prelude.mjs` and run by Bun.
 *
 * The protocol is one JSON message per line. The program's process writes
 * them to its standard output, each line starting with the run's nonce, so
 * that anything else that reaches the stream (a process the program
 * started, which inherits it) is told apart and kept as printed text. The
 * harness answers calls on the process's standard input, one line each.
 *
 * From the program to the harness:
 *   { type: "call", id, name, input }      a tool call; `input` is the arguments as JSON text
 *   { type: "print", text }                what the program printed
 *   { type: "return", value }              it finished; `value` is its return value as text, or null
 *   { type: "error", error }               it threw, or did not parse
 * From the harness to the program:
 *   { id, status, output }                 the result of call `id`
 */

/** Line 1 of the module is the wrapper's: a line of the program is its line in the module minus this. */
export const PROGRAM_LINE_OFFSET = 1

/** The module the program is written as: its text is the body of an async function, so `await` and `return` work. */
export function programModule(source: string): string {
  return `export default async function program() {\n${source}\n}\n`
}

export const PRELUDE = String.raw`
const [nonce, programPath, namesText] = process.argv.slice(2)
const names = JSON.parse(namesText)
const OFFSET = ${PROGRAM_LINE_OFFSET}
const rawWrite = process.stdout.write.bind(process.stdout)
const send = (message) => rawWrite(nonce + " " + JSON.stringify(message) + "\n")
const decoder = new TextDecoder()
const show = (value) => (typeof value === "string" ? value : Bun.inspect(value, { depth: 6 }))
const print = (...values) => send({ type: "print", text: values.map(show).join(" ") + "\n" })
for (const level of ["log", "info", "warn", "error", "debug", "trace"]) console[level] = print
const asText = (chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk))
process.stdout.write = (chunk, ...rest) => {
  send({ type: "print", text: asText(chunk) })
  const done = rest.find((item) => typeof item === "function")
  if (done) done()
  return true
}
process.stderr.write = process.stdout.write

class ToolError extends Error {
  constructor(tool, status, output, site) {
    super(output)
    this.name = "ToolError"
    this.tool = tool
    this.status = status
    this.output = output
    this.site = site
  }
}
globalThis.ToolError = ToolError

let next = 0
const waiting = new Map()
const call = (name, input) => {
  const site = new Error().stack
  if (input === undefined) input = {}
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return Promise.reject(Object.assign(new TypeError(name + " takes one object of arguments, as the tool does"), { site }))
  let text
  try {
    text = JSON.stringify(input)
  } catch (error) {
    return Promise.reject(Object.assign(new TypeError("the arguments of " + name + " cannot be sent: " + error.message), { site }))
  }
  const id = ++next
  return new Promise((resolve, reject) => {
    waiting.set(id, { name, site, resolve, reject })
    send({ type: "call", id, name, input: text })
  })
}
// read's text has every line numbered, for the model. A program is given the file's own lines: the numbers are
// taken off (the call's recorded result keeps them), and the note that says there is more stays at the end.
const NOTE = /\n\n(\[Showing lines \d+-\d+ of \d+\. Call read with offset \d+ to continue\.\])$/
const unnumbered = (output) => {
  const note = NOTE.exec(output)
  const body = note === null ? output : output.slice(0, note.index)
  const lines = body.split("\n")
  if (!lines.every((line) => /^ *\d+\t/.test(line))) return output
  return lines.map((line) => line.replace(/^ *\d+\t/, "")).join("\n") + (note === null ? "" : "\n\n" + note[1])
}
const tools = {}
for (const name of names) {
  const fn = name === "read" ? (input) => call(name, input).then(unnumbered) : (input) => call(name, input)
  Object.defineProperty(fn, "name", { value: name })
  tools[name] = fn
  globalThis[name] = fn
}
globalThis.tools = tools

let pending = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  pending += chunk
  for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
    const line = pending.slice(0, end)
    pending = pending.slice(end + 1)
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const entry = waiting.get(message.id)
    if (entry === undefined) continue
    waiting.delete(message.id)
    if (message.status === "success") entry.resolve(message.output)
    else entry.reject(new ToolError(entry.name, message.status, message.output, entry.site))
  }
})

/** The first frame of a stack that is in the program, as the program's line and column. */
const placeOf = (stack) => {
  if (typeof stack !== "string") return null
  for (const frame of stack.split("\n")) {
    const at = frame.lastIndexOf(programPath)
    if (at === -1) continue
    const match = /^:(\d+)(?::(\d+))?/.exec(frame.slice(at + programPath.length))
    if (match) return { line: Number(match[1]) - OFFSET, column: match[2] === undefined ? null : Number(match[2]) }
  }
  return null
}
const describe = (error) => {
  if (error !== null && typeof error === "object" && error.position && typeof error.position.line === "number" && String(error.name) === "BuildMessage")
    return { kind: "syntax", name: "SyntaxError", message: String(error.message), line: error.position.line - OFFSET, column: error.position.column ?? null }
  if (error instanceof Error) {
    const place = placeOf(error.site) ?? placeOf(error.stack)
    return { kind: error instanceof ToolError ? "tool" : "runtime", name: error.name, message: error.message, tool: error.tool ?? null, status: error.status ?? null, line: place?.line ?? null, column: place?.column ?? null }
  }
  return { kind: "runtime", name: "Error", message: "the program threw " + show(error), line: null, column: null }
}
let over = false
const finish = (message) => {
  if (over) return
  over = true
  send(message)
  setTimeout(() => process.exit(0), 200)
}
process.on("unhandledRejection", (reason) => finish({ type: "error", error: describe(reason) }))
process.on("uncaughtException", (error) => finish({ type: "error", error: describe(error) }))

const render = (value) => {
  if (value === undefined) return null
  if (typeof value === "string") return value
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? show(value) : text
  } catch {
    return show(value)
  }
}
try {
  const module = await import(programPath)
  const value = await module.default()
  finish({ type: "return", value: render(value) })
} catch (error) {
  finish({ type: "error", error: describe(error) })
}
`
