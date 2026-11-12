/**
 * `history_search` and `history_read` over a generated session held in
 * memory, for the strategies that build their context here. They use the
 * engine's own search without an index (`scanSearch`: what a store answers
 * with when SQLite has no full-text search) and its read and renderers, so a
 * tool result looks exactly as the product's does. The `engine` strategy
 * does not come through here: its tools are the real ones, on a real store.
 */
import { readHistory, readable, scanSearch } from "../../packages/core/src/context/history-search.ts"
import {
  HISTORY_READ,
  HISTORY_SEARCH,
  type HistoryReadInput,
  type HistoryReadOutput,
  type HistorySearchInput,
  type HistorySearchOutput,
  parseHistoryReadInput,
  parseHistorySearchInput,
  renderReadOutput,
  renderSearchOutput,
} from "../../packages/core/src/context/history-tools.ts"
import type { Message } from "../../packages/core/src/message/message.ts"

export class HistoryIndex {
  private readonly messages: readonly Message[]

  constructor(messages: readonly Message[]) {
    this.messages = messages.filter(readable)
  }

  search(input: HistorySearchInput): HistorySearchOutput {
    return scanSearch(this.messages, input)
  }

  read(input: HistoryReadInput): HistoryReadOutput | null {
    const index = this.messages.findIndex((candidate) => candidate.seq === input.seq)
    const message = this.messages[index]
    if (message === undefined) return null
    return readHistory(message, { previousSeq: this.messages[index - 1]?.seq ?? null, nextSeq: this.messages[index + 1]?.seq ?? null }, input)
  }

  /** Runs one tool call by name and argument text, returning the tool result text. */
  call(name: string, input: string): string {
    if (name === HISTORY_SEARCH) {
      const parsed = parseHistorySearchInput(input)
      return parsed.ok ? renderSearchOutput(this.search(parsed.value)) : `Error: ${parsed.problem}`
    }
    if (name === HISTORY_READ) {
      const parsed = parseHistoryReadInput(input)
      if (!parsed.ok) return `Error: ${parsed.problem}`
      const output = this.read(parsed.value)
      return output === null ? `Error: no message has seq ${parsed.value.seq}` : renderReadOutput(output)
    }
    return `Error: unknown tool ${name}`
  }
}
