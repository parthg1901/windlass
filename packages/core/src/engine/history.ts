/**
 * The history tools as the engine offers them: `history_search` and
 * `history_read` over the stored messages of the session that calls them,
 * also the ones a compaction took out of the model's view (those are the
 * point). Their shapes and texts are `context/history-tools.ts`; the search
 * is the store's (`Store.searchMessages`).
 *
 * - Both are `read` tools: they change nothing and can always be repeated.
 * - Excluded messages (reverted, refused) are never returned, and a
 *   checkpoint is not searched: it is derived text.
 * - Their output goes through the tool runtime's one cap like every other
 *   tool's (they return `truncation: null`).
 * - A tool sees no store. The engine hands this module a way to find the
 *   store of the session a call belongs to.
 *
 * They are in every session's tool list from its first baseline, not added
 * at the first compaction: the list then never changes (the frozen prefix
 * stays one prefix for the whole session, and the request after a compaction
 * shares the tools with the ones before it), and a long session can look up
 * an early tool result without reading the file again even before anything
 * was compacted. The price is two tool descriptions (about 330 tokens) in
 * every request, which are cached with the rest of the prefix.
 */
import { readHistory } from "../context/history-search.ts"
import {
  type HistoryReadInput,
  type HistorySearchInput,
  historyReadTool,
  historySearchTool,
  parseHistoryReadInput,
  parseHistorySearchInput,
  renderReadOutput,
  renderSearchOutput,
} from "../context/history-tools.ts"
import type { SessionId } from "../id.ts"
import type { Store } from "../store/store.ts"
import type { AnyTool, Tool, ToolResult } from "../tool/tool.ts"

export type HistoryStore = Pick<Store, "searchMessages" | "readMessageAt">

const result = (status: ToolResult["status"], output: string, display: ToolResult["display"] = null): ToolResult => ({ status, output, truncation: null, attachments: [], display })

/** The two tools. `storeOf` gives the store of an open session, or `null` when the session is not open here. */
export function historyTools(storeOf: (sessionId: SessionId) => HistoryStore | null): AnyTool[] {
  const closed = (sessionId: SessionId) => result("error", `The history of session ${sessionId} is not available right now.`)
  const search: Tool<HistorySearchInput> = {
    ...historySearchTool,
    effect: "read",
    execute: async (input, context) => {
      const store = storeOf(context.sessionId)
      if (store === null) return closed(context.sessionId)
      // The runtime checked the schema; this applies the bounds and the defaults the schema only describes.
      const parsed = parseHistorySearchInput(JSON.stringify(input))
      if (!parsed.ok) return result("error", `Invalid arguments for ${historySearchTool.name}: ${parsed.problem}.`)
      const output = store.searchMessages(context.sessionId, parsed.value)
      return result("success", renderSearchOutput(output), { query: output.query, matched: output.matched, hits: output.hits.map((hit) => hit.seq) })
    },
  }
  const read: Tool<HistoryReadInput> = {
    ...historyReadTool,
    effect: "read",
    execute: async (input, context) => {
      const store = storeOf(context.sessionId)
      if (store === null) return closed(context.sessionId)
      const parsed = parseHistoryReadInput(JSON.stringify(input))
      if (!parsed.ok) return result("error", `Invalid arguments for ${historyReadTool.name}: ${parsed.problem}.`)
      const found = store.readMessageAt(context.sessionId, parsed.value.seq)
      if (found.message === null) {
        const near = [found.previousSeq, found.nextSeq].filter((seq) => seq !== null)
        return result(
          "error",
          `No message can be read at seq ${parsed.value.seq}.${near.length === 0 ? "" : ` The nearest ${near.length === 1 ? "message is" : "messages are"} seq ${near.join(" and seq ")}.`} Use ${historySearchTool.name} to find a message.`,
        )
      }
      const output = readHistory(found.message, found, parsed.value)
      return result("success", renderReadOutput(output), { seq: output.seq, offset: output.offset, totalChars: output.totalChars })
    },
  }
  return [read as unknown as AnyTool, search as unknown as AnyTool]
}
