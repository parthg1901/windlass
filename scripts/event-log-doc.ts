/**
 * Generates docs/event-log.md, the specification of a session's event log,
 * from the event schema itself (`packages/core/src/event/durable.ts`).
 *
 *   bun scripts/event-log-doc.ts           print the document
 *   bun scripts/event-log-doc.ts --write   rewrite docs/event-log.md
 *
 * A test (test/release/event-log-doc.test.ts) fails when the document is not
 * what this prints, so a change to the schema needs `--write` to go with it.
 *
 * What comes from where:
 * - The events, their versions and their order: `durableEvents`.
 * - The groups: the `// ---- <group> ----` comments in durable.ts.
 * - Each event's description: its doc comment in durable.ts, as written.
 * - The fields: the validators, walked at run time. They are closures and
 *   cannot be read, so each is called with probe values and the
 *   `DecodeError`s it throws say what it expected. An object validator is
 *   handed a Proxy that records which keys it looks up, in its own order; a
 *   key it skips when absent is optional; a value position that accepts
 *   `null` is nullable. A validator whose error this walk does not recognise
 *   (a hand-written one) stops the generator with its path, rather than
 *   being described wrongly.
 * - The shared shapes: every object or union validator exported by
 *   durable.ts or by a module it imports, matched by structure, named as
 *   exported, described by its doc comment.
 * - The preface and the example below are written here, by hand. The
 *   example's events are checked against the schema (`validateEvent`) each
 *   time the document is generated.
 */
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { validateEvent } from "../packages/core/src/event/decode.ts"
import { durableEvents } from "../packages/core/src/event/durable.ts"
import { SCHEMA_VERSION } from "../packages/core/src/store/schema.ts"
import { DecodeError, type Validator } from "../packages/core/src/validate.ts"

export const ROOT = join(import.meta.dir, "..")
export const EVENT_LOG_DOC = join(ROOT, "docs", "event-log.md")
const DURABLE = join(ROOT, "packages", "core", "src", "event", "durable.ts")

// ---- describing a validator by running it ----

export type Shape =
  | { readonly k: "string" | "non-empty string" | "boolean" | "json" }
  | { readonly k: "integer"; readonly min: number | null }
  | { readonly k: "enum"; readonly values: readonly (string | number | boolean)[] }
  | { readonly k: "array"; readonly item: Shape }
  | { readonly k: "nullable"; readonly inner: Shape }
  | { readonly k: "object"; readonly fields: readonly Field[] }
  | { readonly k: "variant"; readonly tag: string; readonly variants: Readonly<Record<string, Shape>> }

export interface Field {
  readonly name: string
  readonly optional: boolean
  readonly type: Shape
}

/** Runs the root validator on a whole value: the error, or `null` when it was accepted. */
type Probe = (value: unknown) => DecodeError | null

const PROBE = Symbol("probe")

/** Describes what `validator` accepts. Throws when it meets a validator it cannot read. */
export function describeValidator(validator: Validator<unknown>): Shape {
  const probe: Probe = (value) => {
    try {
      validator(value, "")
      return null
    } catch (error) {
      if (error instanceof DecodeError) return error
      throw error
    }
  }
  return describeAt(probe, "")
}

const joinPath = (path: string, key: string) => (path === "" ? key : `${path}.${key}`)
const isUnder = (path: string, base: string) => base === "" || path === base || path.startsWith(`${base}.`) || path.startsWith(`${base}[`)

/** What the validator wants at `path`, where `probe` puts a value there in an otherwise valid whole. */
function describeAt(probe: Probe, path: string): Shape {
  const refused = probe(PROBE)
  if (refused === null || refused.path !== path) throw new Error(`event-log-doc: ${path || "(root)"}: the validator did not refuse a probe value where expected`)
  const acceptsNull = () => {
    const error = probe(null)
    return error === null || !isUnder(error.path, path)
  }
  const shape = fromExpected(probe, path, refused.expected)
  return shape.k !== "json" && acceptsNull() ? { k: "nullable", inner: shape } : shape
}

const LITERALS = /^("(?:[^"\\]|\\.)*"|-?\d+|true|false)( \| ("(?:[^"\\]|\\.)*"|-?\d+|true|false))*$/

function fromExpected(probe: Probe, path: string, expected: string): Shape {
  if (expected === "string" || expected === "non-empty string" || expected === "boolean") return { k: expected }
  if (expected === "JSON value") return { k: "json" }
  if (expected === "integer") return { k: "integer", min: null }
  const min = /^integer >= (-?\d+)$/.exec(expected)
  if (min !== null) return { k: "integer", min: Number(min[1]) }
  if (expected === "array") return { k: "array", item: describeAt((value) => probe([value]), `${path}[0]`) }
  if (expected === "object") return describeObject(probe, path, null)
  if (LITERALS.test(expected)) return { k: "enum", values: JSON.parse(`[${expected.split(" | ").join(",")}]`) as (string | number | boolean)[] }
  throw new Error(`event-log-doc: ${path || "(root)"}: a validator this generator cannot describe (its error says it expects ${expected}); teach scripts/event-log-doc.ts its message`)
}

/**
 * An object or a union of objects at `path`. The value handed in is a Proxy
 * over a plain object: `object` validators list its keys and then look each
 * of theirs up in order, `variant` validators read their tag first.
 */
function describeObject(probe: Probe, path: string, tag: { readonly key: string; readonly value: string } | null): Shape {
  const lookedUp: string[] = []
  type FirstLook = { readonly how: "keys" } | { readonly how: "get"; readonly key: string }
  // Set inside the traps; read through a function so that it is not narrowed to its initial `null`.
  let first: FirstLook | null = null
  const firstLook = (): FirstLook | null => first
  const proxy = (values: Record<string, unknown>) =>
    new Proxy(
      { ...values },
      {
        ownKeys(target) {
          first ??= { how: "keys" }
          return Reflect.ownKeys(target)
        },
        getOwnPropertyDescriptor(target, key) {
          if (typeof key === "string") lookedUp.push(key)
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
        get(target, key, receiver) {
          if (first === null && typeof key === "string") first = { how: "get", key }
          return Reflect.get(target, key, receiver)
        },
      },
    )

  const start: Record<string, unknown> = tag === null ? {} : { [tag.key]: tag.value }
  const opening = probe(proxy(start))
  const reading = firstLook()
  if (tag === null && reading !== null && reading.how === "get") {
    if (opening === null || !LITERALS.test(opening.expected)) throw new Error(`event-log-doc: ${path || "(root)"}: a union whose tag values could not be read`)
    const names = JSON.parse(`[${opening.expected.split(" | ").join(",")}]`) as string[]
    return { k: "variant", tag: reading.key, variants: Object.fromEntries(names.map((name) => [name, describeObject(probe, path, { key: reading.key, value: name })])) }
  }

  const values: Record<string, unknown> = { ...start }
  const fields: Field[] = []
  const known = new Set<string>()
  for (;;) {
    lookedUp.length = 0
    const error = probe(proxy(values))
    let found = false
    for (const key of new Set(lookedUp)) {
      if (known.has(key)) continue
      known.add(key)
      found = true
      const at = joinPath(path, key)
      if (tag !== null && key === tag.key) {
        fields.push({ name: key, optional: false, type: { k: "enum", values: [tag.value] } })
        continue
      }
      const required = error !== null && error.path === at && error.expected === "a value"
      const type = describeAt((value) => probe(proxy({ ...values, [key]: value })), at)
      fields.push({ name: key, optional: !required, type })
      if (required) {
        values[key] = example(type)
        break
      }
    }
    if (!found) break
  }
  return { k: "object", fields }
}

/** A value `shape` accepts, the smallest one. */
function example(shape: Shape): unknown {
  switch (shape.k) {
    case "string":
    case "non-empty string":
      return "x"
    case "boolean":
      return false
    case "json":
    case "nullable":
      return null
    case "integer":
      return shape.min ?? 0
    case "enum":
      return shape.values[0]
    case "array":
      return []
    case "object":
      return Object.fromEntries(shape.fields.filter((field) => !field.optional).map((field) => [field.name, example(field.type)]))
    case "variant":
      return example(Object.values(shape.variants)[0]!)
  }
}

// ---- reading durable.ts and the modules it imports ----

/** The doc comment right before `marker` (a regex source matching the start of the declaration). */
function docComments(source: string, marker: RegExp): Map<string, string> {
  const found = new Map<string, string>()
  const pattern = new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*${marker.source}`, "g")
  for (const match of source.matchAll(pattern)) found.set(match[2]!, commentText(match[1]!))
  return found
}

/** A doc comment's text as Markdown: the leading `*` gone, paragraphs and `-` lists kept. */
function commentText(raw: string): string {
  const lines = raw.split("\n").map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
  while (lines[0] === "") lines.shift()
  while (lines.at(-1) === "") lines.pop()
  const out: string[] = []
  for (const line of lines) {
    const previous = out.at(-1)
    if (line === "") out.push("")
    else if (previous === undefined || previous === "" || /^\s*- /.test(line)) out.push(line.trim().startsWith("- ") ? line.trim() : line.trim())
    else out[out.length - 1] = `${previous} ${line.trim()}`
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n")
}

interface EventEntry {
  readonly type: string
  readonly v: number
  readonly group: string
  readonly description: string
  readonly shape: Shape
}

function readEvents(): EventEntry[] {
  const source = readFileSync(DURABLE, "utf8")
  const body = source.slice(source.indexOf("export const durableEvents"))
  const descriptions = docComments(body, /"([a-z_]+\.[a-z_]+)":\s*define\(/)
  const groups = new Map<string, string>()
  let group = "events"
  for (const line of body.split("\n")) {
    const heading = /^\s*\/\/ ---- (.+?) ----\s*$/.exec(line)
    if (heading !== null) group = heading[1]!
    const declared = /^\s*"([a-z_]+\.[a-z_]+)":\s*define\(/.exec(line)
    if (declared !== null) groups.set(declared[1]!, group)
  }
  return Object.entries(durableEvents).map(([type, definition]) => {
    const description = descriptions.get(type)
    const eventGroup = groups.get(type)
    if (description === undefined) throw new Error(`event-log-doc: ${type} has no doc comment in durable.ts`)
    if (eventGroup === undefined) throw new Error(`event-log-doc: ${type} is not declared on a line of its own in durable.ts`)
    return { type, v: definition.v, group: eventGroup, description, shape: describeValidator(definition.data as Validator<unknown>) }
  })
}

interface Named {
  readonly name: string
  readonly module: string
  readonly description: string | null
  readonly shape: Shape
}

/** The object and union validators exported by durable.ts and the modules it imports, by structure. */
async function readNamedShapes(): Promise<Map<string, Named>> {
  const source = readFileSync(DURABLE, "utf8")
  const modules = [DURABLE, ...[...source.matchAll(/^import [^;]*? from "(\.[^"]+)"/gm)].map((match) => resolve(dirname(DURABLE), match[1]!))]
  const named = new Map<string, Named>()
  for (const file of modules) {
    if (file.endsWith("validate.ts")) continue
    const exports = (await import(file)) as Record<string, unknown>
    const text = readFileSync(file, "utf8")
    const comments = docComments(text, /export const ([A-Za-z0-9_]+)\s*=/)
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value !== "function" || value.length !== 2) continue
      let shape: Shape
      try {
        shape = describeValidator(value as Validator<unknown>)
      } catch {
        continue
      }
      const core = shape.k === "nullable" ? shape.inner : shape
      if (core.k !== "object" && core.k !== "variant" && !(core.k === "array" && (core.item.k === "object" || core.item.k === "variant"))) continue
      if (core.k === "object" && core.fields.length < 2) continue
      const key = JSON.stringify(shape)
      if (!named.has(key)) named.set(key, { name, module: file.slice(ROOT.length + 1), description: comments.get(name) ?? null, shape })
    }
  }
  return named
}

// ---- rendering ----

const code = (text: string) => `\`${text}\``
const anchor = (name: string) => `#${name.toLowerCase()}`

function scalar(shape: Shape): string | null {
  switch (shape.k) {
    case "string":
      return "string"
    case "non-empty string":
      return "string, not empty"
    case "boolean":
      return "boolean"
    case "json":
      return "any JSON (`null` included)"
    case "integer":
      return shape.min === null ? "integer" : `integer ≥ ${shape.min}`
    case "enum":
      return shape.values.length === 1 ? code(JSON.stringify(shape.values[0])) : `one of ${shape.values.map((value) => code(JSON.stringify(value))).join(", ")}`
    default:
      return null
  }
}

class Renderer {
  readonly used = new Set<string>()
  constructor(private readonly named: Map<string, Named>) {}

  private nameOf(shape: Shape): Named | null {
    return this.named.get(JSON.stringify(shape)) ?? null
  }

  private link(named: Named): string {
    this.used.add(named.name)
    return `[${named.name}](${anchor(named.name)})`
  }

  /** The type column for `shape`, or `null` when it is an anonymous object or union whose fields follow as rows. */
  private typeOf(shape: Shape): string | null {
    const named = this.nameOf(shape)
    if (named !== null) return this.link(named)
    if (shape.k === "nullable") {
      const inner = this.typeOf(shape.inner)
      return inner === null ? null : `${inner}, or \`null\``
    }
    if (shape.k === "array") {
      const item = this.typeOf(shape.item)
      return item === null ? null : `list of ${item}`
    }
    return scalar(shape)
  }

  /** Table rows for the fields of an object, nested anonymous objects and unions flattened with dotted paths. */
  rows(shape: Shape & { readonly k: "object" }, prefix = "", condition = ""): string[] {
    const out: string[] = []
    for (const field of shape.fields) {
      const path = `${prefix}${field.name}`
      const required = field.optional ? "may be absent" : "yes"
      const type = this.typeOf(field.type)
      if (type !== null) {
        out.push(`| ${code(path)} | ${condition}${type} | ${required} |`)
        continue
      }
      let inner = field.type
      let nullable = false
      if (inner.k === "nullable") {
        nullable = true
        inner = inner.inner
      }
      let list = false
      if (inner.k === "array") {
        list = true
        inner = inner.item
      }
      const or = nullable ? ", or `null`" : ""
      const at = list ? `${path}[]` : path
      if (inner.k === "object") {
        out.push(`| ${code(path)} | ${condition}${list ? "list of objects" : "object"}${or} | ${required} |`)
        out.push(...this.rows(inner, `${at}.`, condition))
      } else if (inner.k === "variant") {
        out.push(`| ${code(path)} | ${condition}${list ? "list of objects" : "object"}${or}, one of the shapes below by ${code(inner.tag)} | ${required} |`)
        for (const [name, variant] of Object.entries(inner.variants))
          if (variant.k === "object") out.push(...this.rows({ k: "object", fields: variant.fields.filter((item) => item.name !== inner.tag) }, `${at}.`, `when ${code(`${inner.tag}: ${JSON.stringify(name)}`)}: `))
      } else throw new Error(`event-log-doc: ${path}: nothing to render for ${JSON.stringify(field.type)}`)
    }
    return out
  }

  table(shape: Shape & { readonly k: "object" }): string {
    if (shape.fields.length === 0) return "No fields: `data` is `{}`."
    return ["| Field | Type | Required |", "| --- | --- | --- |", ...this.rows(shape)].join("\n")
  }

  /** The body of a shared shape's section. */
  shared(shape: Shape): string {
    if (shape.k === "nullable") return `${this.shared(shape.inner)}\n\nMay be \`null\`.`
    if (shape.k === "object") return this.table(shape)
    if (shape.k === "array") {
      const item = this.typeOf(shape.item)
      if (item !== null) return `A list of ${item}.`
      return this.shared(shape.item).replace(/^/, "A list, each item:\n\n")
    }
    if (shape.k === "variant")
      return [
        `One of these, told apart by ${code(shape.tag)}:`,
        ...Object.entries(shape.variants).map(([name, variant]) => `\n${code(`${shape.tag}: ${JSON.stringify(name)}`)}\n\n${variant.k === "object" ? this.table(variant) : this.typeOf(variant)}`),
      ].join("\n")
    return this.typeOf(shape) ?? ""
  }
}

// ---- the hand-written parts ----

const DATA = `~/.local/share/${brand.directory}`
const SESSIONS = `${DATA}/sessions`

function preface(): string {
  return `# The event log

<!-- Generated by \`bun scripts/event-log-doc.ts --write\` from packages/core/src/event/durable.ts. Do not edit by hand: test/release/event-log-doc.test.ts fails when this file differs from what the generator prints. -->

Every session is an append-only log of events. Everything else (the conversation, what the agent is doing, the
request sent to the model) is computed from it. This page is the log's specification: the rules every log follows,
how to read one, and every event with its fields. The fields and descriptions below are generated from the schema
the program itself decodes with, so they are what this build writes and reads.

## Where a log is

Each session is one SQLite database, \`${SESSIONS}/<session id>.db\` (\`$XDG_DATA_HOME/${brand.directory}/sessions/\`
when that is set), in WAL mode, so \`-wal\` and \`-shm\` files sit beside it, with \`-lock\` and \`-holder\` files that
say which process works in it. The log is the table \`event\`:

| Column | What |
| --- | --- |
| \`session_id\` | the session's ID |
| \`seq\` | the event's position in the session's log |
| \`type\` | the event type, such as \`tool.called\` |
| \`v\` | the version of that type's data |
| \`time\` | milliseconds since the Unix epoch, from the writer's clock: for display, never for ordering |
| \`data\` | the event's data as canonical JSON (sorted keys, no spaces), so equal data is equal bytes |

The other tables (\`session\`, \`message\`, \`inbox\`) are projections: they are rewritten from the events in the
same transaction as each append, and rebuilding them from the log gives the same rows. \`request\` is the ledger of
model calls, kept beside the log. The database's \`PRAGMA user_version\` is the schema version, ${SCHEMA_VERSION} in this build;
a build refuses a file of another version rather than misread it.

## The rules

- **Append-only.** Events are only ever added. The database has triggers that refuse an \`UPDATE\` or a \`DELETE\` on
  \`event\` (\`the event log is append-only\`). Nothing is deleted: an undo, a compaction and a refused response
  are later events that name a range of \`seq\`; the earlier events stay.
- **Dense \`seq\`.** A session's events are numbered 1, 2, 3, ... with no gaps, and \`seq\` is the only order. A
  fork's own events start after its fork point (below).
- **One writer.** One process at a time holds a session (its \`-lock\` file); every append goes through the program's
  reducer, which rejects an event that is illegal in the state the log is in (a tool result for a call that was
  never made, a second terminal event for a step).
- **Strict decoding.** Each event type has one validator. An object has exactly the fields listed below: an unknown
  field is an error, and a field is absent only where the table says it may be (fields added to a shape after it
  was first written); otherwise an absent value is an explicit \`null\`. An event of an unknown type, or of a version
  the build does not read, is an error too: a reader must stop there rather than skip it, because a log folded with
  a hole in it gives a wrong state.
- **Versions.** Every event type has a version, \`v\`. Nothing has been released, so every type is at version 1 and
  shapes were still changed in place. From the first release on, a change to an event's data is a new version, and
  the program keeps a decoder for the old one. A new event type, or a new value of an enumeration, needs no new
  version.
- **Frozen text.** Text the model saw (a tool's output, an appended instruction, a checkpoint) is stored in the event
  as it was sent and is never rendered again, so a request can be rebuilt from the log byte for byte.

## Sessions that come from other sessions

- **A fork** (\`lineage.kind: "fork"\` in its \`session.created\`) shares its parent's history up to the fork point,
  \`throughSeq\`. Its own file holds only its own events, from \`throughSeq + 1\` on (its \`session.created\` is at that
  \`seq\`); its first \`throughSeq\` events are the parent's, read from the parent's file (the \`session\` table has
  \`parent_id\` and \`parent_seq\`). The parent may still be working: only events up to the fork point are read, and
  those never change. A fork whose parent's file is gone still opens and runs, but its inherited events can no
  longer be read.
- **A subagent** (\`lineage.kind: "spawn"\`) is a session of its own with a fresh log from \`seq\` 1. The parent's
  log records only that it started and ended (\`spawn.started\`, \`spawn.ended\`) and the tool call that started it;
  the child's events are in the child's file.
- **A replay** (\`lineage.kind: "replay"\`) has a log of its own from \`seq\` 1 that names the recorded session it
  replays (\`sourceSessionId\`) and how far (\`throughSeq\`).

## Reading a log safely

Open the database read-only and never write to it. A read-only connection takes no lock, so it works while the
session is open in another process; WAL mode lets it read beside the writer, and it sees only committed events. Do
not copy a live database file without its \`-wal\` file: the newest events may be there. With Bun:

\`\`\`ts
import { Database } from "bun:sqlite"

const db = new Database(\`\${process.env.HOME}/.local/share/${brand.directory}/sessions/ses_1f0c3a9e.db\`, { readonly: true })
for (const row of db.query("SELECT seq, type, v, time, data FROM event ORDER BY seq").all() as { seq: number; type: string; v: number; time: number; data: string }[]) {
  const data = JSON.parse(row.data)
  console.log(row.seq, row.type, data)
}
db.close()
\`\`\`

To check events against the schema as the program does, decode each row with \`decodeEvent\` from
\`packages/core/src/event/decode.ts\`; it throws on an unknown type, an unknown version or invalid data. Two other ways
to see events: \`${brand.binary} --json "<prompt>"\` prints every event of a run as one JSON line as it is written (each
with its \`seq\`), and \`bun scripts/export-trace.ts <session id> -o <file>\` exports a session's requests.`
}

/**
 * A one-turn session: the user asks what a file says, the model reads it and
 * answers. Taken from a run of the real program with the scripted model
 * (`${brand.binary.toUpperCase()}_ACP_SCRIPT`), then shortened: IDs, paths, the system prompt and the
 * tool list are cut down; every event is checked against the schema.
 */
const EXAMPLE: readonly { readonly seq: number; readonly type: string; readonly data: Record<string, unknown> }[] = [
  { seq: 1, type: "session.created", data: { cwd: "/home/me/proj", lineage: null, settings: { model: "gpt-6-luna", reasoningEffort: "low" }, title: null } },
  { seq: 2, type: "inbox.enqueued", data: { content: [{ text: "what does notes.txt say?", type: "text" }], delivery: "steer", messageId: "msg_u1", origin: null } },
  { seq: 3, type: "execution.started", data: { executionId: "exe_1" } },
  { seq: 4, type: "snapshot.taken", data: { id: "b550fc71d49e", messageId: null, point: "delivery" } },
  {
    seq: 5,
    type: "baseline.set",
    data: {
      instructions: "You are a coding agent. You work in a terminal on the user's machine and act only through the tools you are given: …",
      sources: [{ fingerprint: "9c1e…", source: "environment" }],
      tools: [{ description: "Read a file …", inputSchema: { type: "object" }, name: "read" }],
    },
  },
  { seq: 6, type: "inbox.delivered", data: { messageId: "msg_u1" } },
  { seq: 7, type: "step.started", data: { attempt: 1, messageId: "msg_a1", model: "gpt-6-luna" } },
  { seq: 8, type: "tool.called", data: { callId: "c1", input: '{"path":"notes.txt"}', messageId: "msg_a1", name: "read", providerData: null } },
  {
    seq: 9,
    type: "tool.started",
    data: {
      callId: "c1",
      effect: "read",
      messageId: "msg_a1",
      run: { mode: "auto", origin: "builtin", paths: [{ given: "notes.txt", place: "workspace", real: "/home/me/proj/notes.txt", relative: "notes.txt" }], sandbox: null },
    },
  },
  {
    seq: 10,
    type: "tool.settled",
    data: { attachments: [], callId: "c1", display: { lines: 1, offset: 1, path: "notes.txt", totalLines: 1 }, messageId: "msg_a1", outcome: "success", output: "1\thello", truncation: null },
  },
  { seq: 11, type: "step.ended", data: { finish: "tool_calls", messageId: "msg_a1", usage: { cachedInputTokens: 0, inputTokens: 5000, outputTokens: 20, reasoningTokens: 0 } } },
  { seq: 12, type: "step.started", data: { attempt: 1, messageId: "msg_a2", model: "gpt-6-luna" } },
  { seq: 13, type: "text.ended", data: { messageId: "msg_a2", providerData: null, text: "notes.txt says hello." } },
  { seq: 14, type: "step.ended", data: { finish: "stop", messageId: "msg_a2", usage: { cachedInputTokens: 4992, inputTokens: 5100, outputTokens: 8, reasoningTokens: 0 } } },
  { seq: 15, type: "execution.succeeded", data: { executionId: "exe_1", verification: { status: "not_configured" } } },
]

function exampleSection(): string {
  for (const event of EXAMPLE) validateEvent({ type: event.type, v: durableEvents[event.type as keyof typeof durableEvents].v, data: event.data })
  const lines = EXAMPLE.map((event) => JSON.stringify({ seq: event.seq, type: event.type, v: durableEvents[event.type as keyof typeof durableEvents].v, data: event.data }))
  return `## An example: one turn

The events of a session in which the user asked \`what does notes.txt say?\` and the model read the file and answered.
They come from a run of the program with a scripted model, shortened: IDs, paths, the system prompt and the tool
list are cut down. Each line is one row: \`seq\`, \`type\`, \`v\` and the \`data\` column (\`time\` is left out).

\`\`\`json
${lines.join("\n")}
\`\`\`

Read in order:

- 1: the session exists, in \`/home/me/proj\`, with its model settings.
- 2 to 6: the user's message is admitted to the inbox (\`steer\`: deliver at the next step boundary), the process
  claims the session (\`execution.started\`), records the workspace before the input (\`snapshot.taken\` at
  \`delivery\`, what an undo of this turn goes back to), freezes the system prompt and tool list (\`baseline.set\`,
  only before the first step and after a compaction), and delivers the message.
- 7 to 11: one model call (a step). The model asks for a tool call, written before anything runs
  (\`tool.called\`); the approval layer lets it run and records under what (\`tool.started\`); its one result is
  stored as the model will see it (\`tool.settled\`); the step ends with the provider's usage.
- 12 to 14: a second step; the model answers with text and stops.
- 15: nothing is left to do; the claim is released, and \`verification\` says what "done" rests on (here: no
  checks are configured).

A file edit would add \`snapshot.taken\` at \`step_start\` and \`step_end\` around the step's tools; a question would
add \`approval.requested\` and \`approval.answered\` between \`tool.called\` and \`tool.started\`.`
}

// ---- the document ----

export async function renderEventLog(): Promise<string> {
  const events = readEvents()
  const named = await readNamedShapes()
  const renderer = new Renderer(named)
  const groups = [...new Set(events.map((event) => event.group))]
  const sections = groups.map((group) => {
    const members = events.filter((event) => event.group === group)
    return [
      `## ${group[0]!.toUpperCase()}${group.slice(1)}`,
      ...members.map((event) => {
        if (event.shape.k !== "object") throw new Error(`event-log-doc: ${event.type}: its data is not an object`)
        return `### \`${event.type}\`\n\nVersion ${event.v}.\n\n${event.description}\n\n${renderer.table(event.shape)}`
      }),
    ].join("\n\n")
  })
  const index = [
    "## The events",
    "",
    `${events.length} event types, in ${groups.length} groups. In the tables, "Required: may be absent" marks a field that can be left out of \`data\`; every other field is always present (inside an object that is itself present), and a type that ends in "or \`null\`" may be \`null\`. A field inside an object or a list is written with dots (\`work.command\`, \`paths[].real\`); "when \`kind: ...\`" marks the fields of one shape of a union. Shapes used in several places are under [Shared shapes](#shared-shapes).`,
    "",
    "| Group | Events |",
    "| --- | --- |",
    ...groups.map((group) => `| ${group} | ${events.filter((event) => event.group === group).map((event) => `[${code(event.type)}](${anchor(event.type.replace(/\./g, ""))})`).join(", ")} |`),
  ].join("\n")

  // Shared shapes: the ones the events use, then the ones those use, until nothing new is linked.
  const shared: string[] = []
  const done = new Set<string>()
  for (;;) {
    const next = [...renderer.used].filter((name) => !done.has(name)).sort()
    if (next.length === 0) break
    for (const name of next) {
      done.add(name)
      const entry = [...named.values()].find((item) => item.name === name)!
      shared.push(`### \`${name}\`\n\n${entry.description === null ? "" : `${entry.description}\n\n`}${renderer.shared(entry.shape)}\n\nDeclared in \`${entry.module}\`.`)
    }
  }
  const sharedSection = ["## Shared shapes", ...shared.sort((a, b) => a.localeCompare(b))].join("\n\n")
  return `${[preface(), exampleSection(), index, ...sections, sharedSection].join("\n\n")}\n`
}

if (import.meta.main) {
  const document = await renderEventLog()
  if (process.argv.includes("--write")) {
    await Bun.write(EVENT_LOG_DOC, document)
    console.log(`rewrote ${EVENT_LOG_DOC.slice(ROOT.length + 1)}`)
  } else process.stdout.write(document)
}
