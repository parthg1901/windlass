/**
 * Memory, as the step loop offers it (`memory/` has the module). Behind a
 * flag: `memory.enabled`, off unless a configuration file turns it on.
 *
 * - With the flag off when a session's first baseline is set, nothing of
 *   this exists for the session, then or later: no tool in its list, no
 *   message, no record. Its requests are byte for byte what they are in an
 *   engine built without memory.
 * - With it on at that moment, for a session a person started (a subagent is
 *   not offered memory: its task is not the user's words): `memory_save`,
 *   `memory_retract` and `memory_search` are in the frozen tool list, with
 *   constant specs; the notes reach the model as an appended message under
 *   source `memory` at a step boundary (the block first, a short update when
 *   this session changes what it holds), never in the baseline; and how each
 *   turn ended is recorded in memory's usage log, which is what the A/B
 *   comparison and the per-note statistics read.
 * - Turned off later, the tools stay in the list (it is frozen) and answer
 *   that memory is off; nothing more is delivered.
 */
import type { StoredEvent } from "../event/durable.ts"
import type { AppendedSource } from "../instructions/state.ts"
import { type MemoryConfig, resolveMemoryConfig } from "../memory/config.ts"
import { MEMORY_KEY, planMemoryDelivery } from "../memory/deliver.ts"
import { findQuote } from "../memory/screen.ts"
import { type MemoryStore, describeProblem, memoryPaths, openMemoryStore } from "../memory/store.ts"
import { type MemoryToolOptions, memoryTools } from "../memory/tools.ts"
import { type DeliveredRecord, type Outcome, outcomeOfVerification } from "../memory/usage.ts"
import type { Projection } from "../message/message.ts"
import type { AnyTool, ToolContext, ToolResult } from "../tool/tool.ts"
import type { ConfigFiles } from "./skills.ts"

/** How an engine is told to offer memory. */
export interface MemorySetup {
  /** IDs of new notes, instead of the module's random ones (tests). */
  readonly newId?: () => string
}

/** A session's memory settings, from its two configuration files. */
export function sessionMemoryConfig(files: ConfigFiles | null): MemoryConfig {
  return resolveMemoryConfig(files?.user?.memory, files?.project?.memory)
}

/** The notes of a session: the user's, and those of the project it works in. */
export function openSessionMemory(input: { readonly dataDir: string; readonly projectDir: string; readonly config: MemoryConfig; readonly now: () => Date; readonly newId?: () => string }): MemoryStore {
  return openMemoryStore({
    paths: memoryPaths({ dataDir: input.dataDir, projectDir: input.projectDir, inRepository: input.config.inRepository }),
    now: input.now,
    ...(input.newId === undefined ? {} : { newId: input.newId }),
  })
}

export interface MemoryToolHost {
  /** The calling session's notes, or `null` when memory is off for it now (or the session is not open here). */
  readonly storeOf: (context: ToolContext) => MemoryStore | null
  readonly untrusted: MemoryToolOptions["sessionUntrusted"]
  /** The calling session's state, to look the user's words up in. */
  readonly projectionOf: (context: ToolContext) => Projection | null
  readonly now: () => Date
}

/**
 * The memory tools of an engine. One set for every session: the specs are
 * the module's constants, and each call works on the calling session's notes.
 */
export function engineMemoryTools(host: MemoryToolHost): AnyTool[] {
  const tools = memoryTools({
    store: (context) => {
      const store = host.storeOf(context)
      if (store === null) throw new MemoryOff()
      return store
    },
    sessionUntrusted: host.untrusted,
    // A quote the model attributes to the user must be in a message of the user's that is still part of the conversation.
    findUserWords: (context, words) => {
      const projection = host.projectionOf(context)
      if (projection === null) return null
      const said = projection.messages.flatMap((message) =>
        message.kind === "user" && message.excluded === null
          ? [{ seq: message.seq, messageId: message.id as string, text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") }]
          : [],
      )
      const found = findQuote(words, said)
      return found === null ? null : { seq: found.seq, messageId: found.messageId }
    },
    now: host.now,
  })
  const off: ToolResult = { status: "error", output: "Memory is turned off in the configuration that applies here. Nothing was read or saved.", truncation: null, attachments: [], display: { memory: { outcome: "off" } } }
  return tools.map((tool) => {
    const execute = tool.execute as (input: unknown, context: ToolContext) => Promise<ToolResult>
    return {
      ...tool,
      // Checked before the tool runs, so a call that finds memory off is an answer and not a crash.
      execute: async (input: unknown, context: ToolContext) => (host.storeOf(context) === null ? off : execute(input, context)),
    } as unknown as AnyTool
  })
}

class MemoryOff extends Error {
  constructor() {
    super("memory is off for this session")
  }
}

/**
 * Memory as a source the loop appends when what the model holds is no longer
 * current. The delivery is recorded in the usage log first, then returned to
 * be appended: if the process dies in between, the record names a
 * fingerprint no message carries, and the next boundary delivers again.
 */
export function memorySource(input: { readonly session: string; readonly store: MemoryStore; readonly config: MemoryConfig; readonly now: Date; readonly problem: (message: string) => void }): AppendedSource {
  return {
    key: MEMORY_KEY,
    update: (known) => {
      const loaded = input.store.load()
      // A note file that cannot be read is the user's to fix: said to them, never delivered.
      for (const problem of loaded.problems) input.problem(`A memory note is not valid and is not used: ${describeProblem(problem)}`)
      const usage = input.store.usage(input.session)
      const plan = planMemoryDelivery({
        session: input.session,
        known,
        records: usage.records.filter((record): record is DeliveredRecord => record.type === "delivered"),
        entries: loaded.entries,
        now: input.now,
        limits: input.config.limits,
      })
      if (plan === null) return null
      input.store.recordUsage(plan.record)
      // The notes the message makes the model hold, as fields: their IDs and the hash of the line each was shown as.
      return { text: plan.text, fingerprint: plan.fingerprint, detail: { kind: "memory", notes: plan.record.held.map((note) => ({ id: note.id, hash: note.hash })) } }
    },
  }
}

/** How a turn ended, as memory's usage log records it, for the events that end one; `null` for every other event. */
export function memoryOutcome(item: StoredEvent): Outcome | null {
  switch (item.type) {
    case "execution.succeeded":
    case "turn.ended":
      return outcomeOfVerification(item.data.verification.status)
    case "execution.interrupted":
      return item.data.reason === "user" ? "interrupted" : null
    case "history.reverted":
      return "reverted"
    default:
      return null
  }
}
