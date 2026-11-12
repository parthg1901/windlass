/**
 * The tools of the scripted MCP test servers, shared by the stdio server
 * (`stdio-server.ts`) and the HTTP server (`http-server.ts`). Each tool
 * exercises one thing a client must handle.
 */
import { appendFileSync } from "node:fs"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type Obj = { [key: string]: JsonValue }

export interface FixtureOptions {
  /** Extra tools named `tool_000` ... for pagination. */
  readonly filler: number
  /** Tools per `tools/list` page. */
  readonly pageSize: number
  /** List tools in a different order every time. */
  readonly shuffle: boolean
  /** Also list tools a client must reject (no schema, a name with a space). */
  readonly badTools: boolean
  /** Only these tools (by name) are listed; `null` lists all. */
  readonly only: readonly string[] | null
  /** Appended to every tool description, so two servers can differ. */
  readonly tag: string
  /** Where events are logged for the test to read (`cancelled 7`, `call echo`). */
  readonly log: string | null
}

export function readOptions(flags: Map<string, string>): FixtureOptions {
  return {
    filler: Number(flags.get("filler") ?? 0),
    pageSize: Number(flags.get("page-size") ?? 100),
    shuffle: flags.has("shuffle"),
    badTools: flags.has("bad-tools"),
    only: flags.has("only") ? flags.get("only")!.split(",") : null,
    tag: flags.get("tag") ?? "",
    log: flags.get("log") ?? null,
  }
}

/** `--name value` and `--switch` pairs. */
export function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!.replace(/^--/, "")
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next)
      index += 1
    } else flags.set(key, "")
  }
  return flags
}

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg=="

export interface CallContext {
  readonly signal: AbortSignal
  readonly progress: (progress: number, total: number, message: string) => void
  readonly crash: () => never
  /** HTTP only: the request's headers, lowercased. */
  readonly headers: Readonly<Record<string, string>>
}

export function createBehaviour(options: FixtureOptions, onListChanged: () => void) {
  const dynamic = new Map<string, Obj>()
  const keys = new Map<string, number>()
  const shuffleKey = (name: string) => {
    if (!keys.has(name)) keys.set(name, Math.random())
    return keys.get(name)!
  }
  const log = (line: string) => {
    if (options.log !== null) appendFileSync(options.log, `${line}\n`)
  }

  const base = (): Obj[] => [
    tool("echo", "Echo the text back. Use it to test.", { text: { type: "string", description: "What to echo." } }, ["text"]),
    tool("add", "Add two numbers and return the sum, also as structured content.", { a: { type: "number" }, b: { type: "number" } }, ["a", "b"]),
    tool("image", "Return a 1x1 PNG image.", {}, []),
    tool("fail", "Always fails with isError.", {}, []),
    tool("hang", "Never returns until it is cancelled.", {}, []),
    tool("crash", "Makes the server process exit in the middle of the call.", {}, []),
    tool("slow", "Returns after `ms` milliseconds, reporting progress.", { ms: { type: "integer", minimum: 0 } }, ["ms"]),
    tool("big", "Returns `lines` lines of text.", { lines: { type: "integer", minimum: 1 } }, ["lines"]),
    tool("resources", "Returns a resource link, an embedded resource and audio.", {}, []),
    tool("add_tool", "Adds a tool with the given name to this server's list.", { name: { type: "string", minLength: 1 } }, ["name"]),
    tool("remove_tool", "Removes a tool added with add_tool.", { name: { type: "string", minLength: 1 } }, ["name"]),
    {
      name: "region",
      description: "Echo the region and the Mcp-Param-Region header the server received.",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": "Region" }, query: { type: "string" } },
        required: ["region"],
        additionalProperties: false,
      },
    },
    tool(
      "create_issue",
      "Create a new issue in a repository.\nThe second line of the description is not part of the catalogue.",
      {
        repo: { type: "string", pattern: "^[\\w.-]+/[\\w.-]+$", description: "owner/name" },
        title: { type: "string", minLength: 1 },
        labels: { type: "array", items: { type: "string" }, maxItems: 5 },
        priority: { enum: ["low", "high"] },
      },
      ["repo", "title"],
    ),
  ]

  const all = (): Obj[] => {
    const tools = [
      ...base().filter((entry) => options.only === null || options.only.includes(String(entry.name))),
      ...Array.from({ length: options.filler }, (_, index) => tool(`tool_${String(index).padStart(3, "0")}`, `Filler tool number ${index}.`, {}, [])),
      ...dynamic.values(),
      ...(options.badTools
        ? [{ name: "no schema", description: "A tool name with a space." }, { name: "noschema", description: "Has no inputSchema." }]
        : []),
    ].map((entry) => (options.tag === "" ? entry : { ...entry, description: `${entry.description} ${options.tag}` }))
    if (!options.shuffle) return tools
    // One random order per process, so the pages of one listing agree with each other.
    return tools
      .map((entry) => ({ entry, key: shuffleKey(String(entry.name)) }))
      .sort((a, b) => a.key - b.key)
      .map((item) => item.entry)
  }

  return {
    log,
    /** One page of `tools/list`. The cursor is the offset as a string. */
    list(cursor: JsonValue | undefined): { tools: Obj[]; nextCursor?: string } {
      const tools = all()
      const offset = typeof cursor === "string" ? Number(cursor) : 0
      const page = tools.slice(offset, offset + options.pageSize)
      const next = offset + options.pageSize
      return next < tools.length ? { tools: page, nextCursor: String(next) } : { tools: page }
    },
    async call(name: string, args: Obj, context: CallContext): Promise<Obj> {
      log(`call ${name}`)
      switch (name) {
        case "echo":
          return text(String(args.text))
        case "add": {
          const sum = Number(args.a) + Number(args.b)
          return { content: [{ type: "text", text: JSON.stringify({ sum }) }], structuredContent: { sum } }
        }
        case "image":
          return { content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }] }
        case "fail":
          return { content: [{ type: "text", text: "the widget is broken" }], isError: true }
        case "hang":
          await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }))
          return text("unreachable")
        case "crash":
          return context.crash()
        case "slow": {
          const ms = Number(args.ms)
          for (let step = 1; step <= 3; step += 1) {
            await Bun.sleep(ms / 3)
            context.progress(step, 3, `step ${step}`)
          }
          return text(`done after ${ms} ms`)
        }
        case "big":
          return text(Array.from({ length: Number(args.lines) }, (_, index) => `line ${index + 1} of the big output`).join("\n"))
        case "resources":
          return {
            content: [
              { type: "resource_link", uri: "file:///project/README.md", name: "README.md", mimeType: "text/markdown", description: "The readme." },
              { type: "resource", resource: { uri: "file:///project/notes.txt", mimeType: "text/plain", text: "embedded notes" } },
              { type: "audio", data: "AAAA", mimeType: "audio/wav" },
            ],
          }
        case "add_tool":
          dynamic.set(String(args.name), tool(String(args.name), `A tool added at run time: ${String(args.name)}.`, {}, []))
          onListChanged()
          return text(`added ${String(args.name)}`)
        case "remove_tool":
          dynamic.delete(String(args.name))
          onListChanged()
          return text(`removed ${String(args.name)}`)
        case "region":
          return text(`region=${String(args.region)} header=${context.headers["mcp-param-region"] ?? "(none)"}`)
        case "create_issue":
          return text(`created issue "${String(args.title)}" in ${String(args.repo)}`)
        default:
          if (dynamic.has(name) || name.startsWith("tool_")) return text(`${name} ran`)
          throw new UnknownTool(name)
      }
    },
  }
}

export class UnknownTool extends Error {}

function tool(name: string, description: string, properties: Obj, required: string[]): Obj {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } }
}

function text(value: string): Obj {
  return { content: [{ type: "text", text: value }] }
}
