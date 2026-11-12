/**
 * A session as OpenTelemetry spans, derived after the fact from what the
 * session stored: its event log and its request ledger. A pure function: no
 * clock, no I/O, no store. The same input gives the same spans, IDs included.
 *
 * The shape (README.md has the reasons):
 *
 *   trace per execution (a turn: from `execution.started` to its terminal event)
 *     invoke_agent <brand>                 the execution, INTERNAL
 *       chat <model>                       one per ledger row (a model call; each attempt its own), CLIENT
 *       execute_tool <tool>                one per `tool.called`, INTERNAL
 *         subagent | background_command    `spawn.started` .. `spawn.ended`, INTERNAL
 *           invoke_agent <brand>           the child session's executions, when the tree is exported (tree.ts)
 *       compaction                         `compaction.started` .. its end, INTERNAL
 *         chat <model>                     its summary calls
 *       checks                             `checks.started` .. its end, INTERNAL
 *
 * Event types the mapping has no rule for are counted in `unknownEvents`,
 * never an error: the schema keeps growing, and an exporter must not stop
 * working when a new event appears. Nothing here depends on which tools exist.
 *
 * Message text, tool arguments and tool output are left out unless
 * `content` is set; then they are redacted (`content.ts`) and bounded.
 */
import type { RequestRecord } from "../store/store.ts"
import { type ConventionMessage, DEFAULT_MAX_CONTENT_CHARS, type MessagePart, boundedText, messagesJson } from "./content.ts"
import { type Attributes, type Span, type SpanContext, type SpanEvent, type SpanKind, type SpanLink, type SpanStatus, attr, spanIdOf, traceIdOf } from "./span.ts"
import { brand } from "../brand.ts"

/** A stored event, read loosely: the mapping must keep working for event types and fields it does not know. */
export interface LogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

export interface SessionInput {
  readonly sessionId: string
  readonly events: readonly LogEvent[]
  readonly requests: readonly RequestRecord[]
}

export interface MapOptions {
  /** Export message text, tool arguments and tool output (redacted and bounded). Default `false`. */
  readonly content?: boolean
  /** Values to redact wherever they occur in exported content, besides the well-known token formats. */
  readonly secrets?: readonly string[]
  /** Characters per content attribute or message part. Default `DEFAULT_MAX_CONTENT_CHARS`. */
  readonly maxContentChars?: number
  /** `gen_ai.provider.name`. Default `openai`: the one provider. */
  readonly providerName?: string
  /**
   * Where an execution's span goes when it is not the root of a trace of its
   * own: a subagent's execution under the spawn span of its parent (tree.ts).
   * `null` or absent: a trace of its own.
   */
  readonly placement?: (execution: { readonly seq: number; readonly timeMs: number }) => SpanContext | null
}

/** A subagent or background command the session spawned, with the span that stands for it. */
export interface SpawnRef {
  readonly spawnId: string
  readonly kind: "subagent" | "command"
  /** The child session, for a subagent. */
  readonly childSessionId: string | null
  readonly context: SpanContext
  readonly startMs: number
}

export interface MapResult {
  readonly sessionId: string
  readonly spans: readonly Span[]
  /** Event types the mapping has no rule for, with counts. */
  readonly unknownEvents: Readonly<Record<string, number>>
  readonly spawns: readonly SpawnRef[]
  /** For a subagent: the parent session and the spawned work that started it. */
  readonly spawnedBy: { readonly parentSessionId: string; readonly spawnId: string } | null
  /** `step.started` events no ledger row answers (a process that died before the call was recorded). */
  readonly stepsWithoutLedger: number
}

/** Event types the log has that carry nothing a span needs. Listed, so that an event type nobody thought about is counted. */
const IGNORED = new Set([
  "session.renamed",
  "session.archived",
  "session.unarchived",
  "baseline.set",
  "instruction.appended",
  "agent.switched",
  "command.expanded",
  "hook.ran",
  "inbox.delivery_changed",
  "inbox.cancelled",
  "synthetic.appended",
  "taint.noticed",
  "taint.cleared",
  "snapshot.taken",
  "snapshot.unavailable",
  "snapshot.coverage",
  "revert.started",
  "history.reverted",
  "revert.undo_started",
  "history.restored",
  "revert.failed",
  "replay.call",
  "replay.diverged",
  "replay.ended",
])

interface Builder {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string
  kind: SpanKind
  startMs: number
  endMs: number | null
  attributes: Attributes
  events: SpanEvent[]
  links: SpanLink[]
  status: SpanStatus
}

interface Execution {
  readonly span: Builder
  readonly inputs: ConventionMessage[]
  steps: number
  toolCalls: number
  retries: number
  /** Ledger rows under it, and what they measured. */
  calls: number
  input: number
  output: number
  cached: number
  measured: boolean
}

interface Retry {
  readonly attempt: number
  readonly delayMs: number
  readonly error: Record<string, unknown>
}

/** What the log says about one model call (one `step.started`), to enrich its ledger row. */
interface StepFacts {
  readonly seq: number
  readonly effort: string | null
  finish: string | null
  error: Record<string, unknown> | null
  endMs: number | null
}

/** Maps one session. `input.events` must be the session's whole log, oldest first. */
export function mapSession(input: SessionInput, options: MapOptions = {}): MapResult {
  const sessionId = input.sessionId
  const content = options.content === true
  const secrets = options.secrets ?? []
  const maxChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS
  const provider = options.providerName ?? "openai"
  const text = (value: string) => boundedText(value, secrets, maxChars)

  const builders: Builder[] = []
  const unknownEvents: Record<string, number> = {}
  const spawns: SpawnRef[] = []
  let spawnedBy: MapResult["spawnedBy"] = null
  let settings = { model: "", effort: null as string | null }
  let current: Execution | null = null
  const executions: Execution[] = []
  /** The span a message's model calls belong under: its execution, or for a summary its compaction. */
  const owner = new Map<string, { readonly span: Builder; readonly execution: Execution | null }>()
  const steps = new Map<string, StepFacts>()
  const retries = new Map<string, Retry[]>()
  const tools = new Map<string, Builder>()
  const spawnSpans = new Map<string, Builder>()
  const compactions = new Map<string, Builder>()
  let checks: Builder | null = null
  const enqueued = new Map<string, unknown>()
  const assistant = new Map<string, MessagePart[]>()
  const lastOutput = new Map<string, number>()
  const lastTime = input.events.at(-1)?.time ?? 0

  const open = (span: Omit<Builder, "events" | "links" | "status" | "endMs"> & Partial<Pick<Builder, "status">>): Builder => {
    const made: Builder = { events: [], links: [], status: { code: "unset" }, endMs: null, ...span }
    builders.push(made)
    return made
  }
  const child = (parent: Builder, spanId: string, name: string, kind: SpanKind, startMs: number, attributes: Attributes): Builder =>
    open({ traceId: parent.traceId, spanId, parentSpanId: parent.spanId, name, kind, startMs, attributes })
  /** A span with no execution to belong to (an event outside any turn): a trace of its own. */
  const orphan = (key: string, name: string, kind: SpanKind, startMs: number, attributes: Attributes): Builder =>
    open({ traceId: traceIdOf(sessionId, "orphan", key), spanId: spanIdOf(sessionId, "orphan", key), parentSpanId: null, name, kind, startMs, attributes })
  const under = (key: string, spanId: string, name: string, kind: SpanKind, time: number, attributes: Attributes) =>
    current === null ? orphan(key, name, kind, time, attributes) : child(current.span, spanId, name, kind, time, attributes)

  for (const event of input.events) {
    const data = (event.data ?? {}) as Record<string, unknown>
    const str = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : null)
    const call = () => `${str("messageId")}/${str("callId")}`
    switch (event.type) {
      case "session.created": {
        const created = data.settings as { model?: string; reasoningEffort?: string | null } | undefined
        settings = { model: created?.model ?? "", effort: created?.reasoningEffort ?? null }
        const lineage = data.lineage as { kind?: string; parentSessionId?: string; spawnId?: string } | null | undefined
        if (lineage?.kind === "spawn" && lineage.parentSessionId !== undefined && lineage.spawnId !== undefined)
          spawnedBy = { parentSessionId: lineage.parentSessionId, spawnId: lineage.spawnId }
        break
      }
      case "settings.changed":
        settings = { model: str("model") ?? settings.model, effort: (data.reasoningEffort as string | null | undefined) ?? null }
        break
      case "execution.started": {
        const placed = options.placement?.({ seq: event.seq, timeMs: event.time }) ?? null
        const attributes: Attributes = {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": brand.name,
          "gen_ai.conversation.id": sessionId,
          "gen_ai.provider.name": provider,
          ...(settings.model === "" ? {} : { "gen_ai.request.model": settings.model }),
          ...(settings.effort === null ? {} : { "gen_ai.request.reasoning.level": settings.effort }),
          [attr("execution.id")]: str("executionId") ?? "",
          [attr("log.seq")]: event.seq,
          ...(spawnedBy === null ? {} : { [attr("parent.session_id")]: spawnedBy.parentSessionId, [attr("spawn.id")]: spawnedBy.spawnId }),
        }
        const span = open({
          traceId: placed?.traceId ?? traceIdOf(sessionId, event.seq),
          spanId: spanIdOf(sessionId, "execution", event.seq),
          parentSpanId: placed?.spanId ?? null,
          name: `invoke_agent ${brand.name}`,
          kind: "internal",
          startMs: event.time,
          attributes,
        })
        current = { span, inputs: [], steps: 0, toolCalls: 0, retries: 0, calls: 0, input: 0, output: 0, cached: 0, measured: false }
        executions.push(current)
        break
      }
      case "execution.resumed":
      case "execution.interrupt_requested":
        current?.span.events.push({ name: event.type, timeMs: event.time, attributes: str("reason") === null ? {} : { [attr("interrupt.reason")]: str("reason")! } })
        break
      case "turn.ended":
        current?.span.events.push({ name: "turn.ended", timeMs: event.time, attributes: { [attr("verification.status")]: verificationStatus(data.verification) } })
        break
      case "execution.succeeded":
      case "execution.failed":
      case "execution.interrupted": {
        if (current === null) break
        const span = current.span
        span.endMs = event.time
        const outcome = event.type.slice("execution.".length)
        span.attributes[attr("execution.outcome")] = outcome
        if (event.type === "execution.succeeded") {
          span.attributes[attr("verification.status")] = verificationStatus(data.verification)
          span.status = { code: "ok" }
        } else if (event.type === "execution.failed") {
          span.attributes["error.type"] = str("cause") ?? "failed"
          span.status = { code: "error", message: text(str("message") ?? "") }
        } else {
          span.attributes[attr("interrupt.reason")] = str("reason") ?? ""
        }
        current = null
        break
      }
      case "inbox.enqueued":
        enqueued.set(str("messageId") ?? "", data.content)
        break
      case "inbox.delivered":
        if (current === null) break
        current.span.attributes[attr("execution.inputs")] = ((current.span.attributes[attr("execution.inputs")] as number | undefined) ?? 0) + 1
        if (content) current.inputs.push({ role: "user", parts: partsOf(enqueued.get(str("messageId") ?? "")) })
        break
      case "step.started": {
        const messageId = str("messageId") ?? ""
        steps.set(`${messageId}#${String(data.attempt)}`, { seq: event.seq, effort: settings.effort, finish: null, error: null, endMs: null })
        if (current !== null) {
          owner.set(messageId, { span: current.span, execution: current })
          if (data.attempt === 1) current.steps += 1
        }
        break
      }
      case "step.ended":
      case "step.failed":
      case "step.refused": {
        const messageId = str("messageId") ?? ""
        const facts = latestStep(steps, messageId)
        if (facts === null) break
        facts.endMs = event.time
        if (event.type === "step.ended") facts.finish = str("finish")
        else if (event.type === "step.refused") facts.error = { kind: "refused" }
        else {
          const error = data.error as Record<string, unknown> | undefined
          facts.error = error?.kind === "provider" ? (error.error as Record<string, unknown>) : (error ?? null)
        }
        break
      }
      case "retry.scheduled": {
        const messageId = str("messageId") ?? ""
        const list = retries.get(messageId) ?? []
        list.push({ attempt: Number(data.attempt), delayMs: Number(data.delayMs ?? 0), error: (data.error ?? {}) as Record<string, unknown> })
        retries.set(messageId, list)
        // A retry of a step still open (nothing durable came of the failed attempt) and of a summary call runs
        // under the same message without a `step.started` of its own: the next attempt starts here. A retry after a
        // failed step runs under a new message, whose `step.started` says so.
        const previous = latestStep(steps, messageId)
        if (compactions.has(messageId) || (previous !== null && previous.endMs === null))
          steps.set(`${messageId}#${String(data.attempt)}`, { seq: event.seq, effort: previous?.effort ?? settings.effort, finish: null, error: null, endMs: null })
        const execution = owner.get(messageId)?.execution ?? current
        if (execution !== null) execution.retries += 1
        break
      }
      case "text.ended":
      case "reasoning.ended": {
        const messageId = str("messageId") ?? ""
        lastOutput.set(messageId, event.time)
        if (content && event.type === "text.ended") assistant.set(messageId, [...(assistant.get(messageId) ?? []), { type: "text", content: str("text") ?? "" }])
        break
      }
      case "tool.called": {
        const messageId = str("messageId") ?? ""
        const name = str("name") ?? "unknown"
        lastOutput.set(messageId, event.time)
        const parent = owner.get(messageId)?.span ?? current?.span ?? null
        const attributes: Attributes = {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": name,
          "gen_ai.tool.call.id": str("callId") ?? "",
          "gen_ai.conversation.id": sessionId,
          [attr("log.seq")]: event.seq,
          [attr("approval.asked")]: false,
          ...(content ? { "gen_ai.tool.call.arguments": text(str("input") ?? "") } : {}),
        }
        const spanId = spanIdOf(sessionId, "tool", event.seq)
        const span = parent === null ? orphan(`tool-${event.seq}`, `execute_tool ${name}`, "internal", event.time, attributes) : child(parent, spanId, `execute_tool ${name}`, "internal", event.time, attributes)
        tools.set(call(), span)
        if (content) assistant.set(messageId, [...(assistant.get(messageId) ?? []), { type: "tool_call", id: str("callId") ?? "", name, arguments: str("input") ?? "" }])
        if (current !== null) current.toolCalls += 1
        break
      }
      case "tool.started": {
        const span = tools.get(call())
        if (span === undefined) break
        span.attributes[attr("tool.effect")] = str("effect") ?? ""
        span.attributes[attr("tool.wait_ms")] = event.time - span.startMs
        span.events.push({ name: "tool.started", timeMs: event.time, attributes: {} })
        const run = data.run as { mode?: string; origin?: string; sandbox?: { network?: boolean; writableRoots?: unknown[] } | null } | undefined
        if (run !== undefined) {
          span.attributes[attr("approval.mode")] = run.mode ?? ""
          span.attributes[attr("tool.origin")] = run.origin ?? ""
          span.attributes["gen_ai.tool.type"] = run.origin === "mcp" ? "extension" : "function"
          span.attributes[attr("tool.sandboxed")] = run.sandbox !== null && run.sandbox !== undefined
          if (run.sandbox) {
            span.attributes[attr("sandbox.network")] = run.sandbox.network === true
            span.attributes[attr("sandbox.extra_writable_roots")] = run.sandbox.writableRoots?.length ?? 0
          }
        }
        break
      }
      case "approval.requested": {
        const span = tools.get(call())
        if (span === undefined) break
        span.attributes[attr("approval.asked")] = true
        span.attributes[attr("approval.mode")] = str("mode") ?? ""
        span.events.push({ name: "approval.requested", timeMs: event.time, attributes: {} })
        break
      }
      case "approval.answered": {
        const span = tools.get(call())
        if (span === undefined) break
        span.attributes[attr("approval.choice")] = str("choice") ?? ""
        span.attributes[attr("approval.approved")] = data.approve === true
        span.events.push({ name: "approval.answered", timeMs: event.time, attributes: { [attr("approval.choice")]: str("choice") ?? "", [attr("approval.approved")]: data.approve === true } })
        break
      }
      case "approval.denied": {
        const span = tools.get(call())
        if (span === undefined) break
        span.attributes[attr("approval.approved")] = false
        span.attributes[attr("approval.denied_by")] = str("reason") ?? ""
        span.attributes[attr("approval.mode")] = str("mode") ?? ""
        span.events.push({ name: "approval.denied", timeMs: event.time, attributes: { [attr("approval.denied_by")]: str("reason") ?? "", [attr("approval.stops_run")]: data.stop === true } })
        break
      }
      case "tool.settled": {
        const span = tools.get(call())
        if (span === undefined) break
        const outcome = str("outcome") ?? ""
        span.endMs = event.time
        span.attributes[attr("tool.outcome")] = outcome
        span.attributes[attr("tool.truncated")] = data.truncation !== null && data.truncation !== undefined
        if (outcome === "success") span.status = { code: "ok" }
        else {
          span.attributes["error.type"] = outcome
          span.status = { code: "error" }
        }
        if (content) span.attributes["gen_ai.tool.call.result"] = text(str("output") ?? "")
        break
      }
      case "spawn.started": {
        const spawnId = str("spawnId") ?? ""
        const work = (data.work ?? {}) as { kind?: string; sessionId?: string; command?: string }
        const kind = work.kind === "subagent" ? "subagent" : "command"
        const parent = tools.get(call()) ?? current?.span ?? null
        const attributes: Attributes = {
          [attr("spawn.id")]: spawnId,
          [attr("spawn.kind")]: kind,
          [attr("spawn.background")]: data.background === true,
          ...(kind === "subagent" && work.sessionId !== undefined ? { "gen_ai.agent.id": work.sessionId, [attr("child.session_id")]: work.sessionId } : {}),
          ...(content && kind === "command" && work.command !== undefined ? { [attr("spawn.command")]: text(work.command) } : {}),
        }
        // The ID depends on the spawn's own ID, so a child session can name its parent span without reading the parent's log.
        const spanId = spanIdOf(sessionId, "spawn", spawnId)
        const name = kind === "subagent" ? "subagent" : "background_command"
        const span = parent === null ? orphan(`spawn-${spawnId}`, name, "internal", event.time, attributes) : child(parent, spanId, name, "internal", event.time, attributes)
        spawnSpans.set(spawnId, span)
        spawns.push({ spawnId, kind, childSessionId: kind === "subagent" ? (work.sessionId ?? null) : null, context: { traceId: span.traceId, spanId: span.spanId }, startMs: event.time })
        break
      }
      case "spawn.ended": {
        const span = spawnSpans.get(str("spawnId") ?? "")
        if (span === undefined) break
        const outcome = str("outcome") ?? ""
        span.endMs = event.time
        span.attributes[attr("spawn.outcome")] = outcome
        if (typeof data.exitCode === "number") span.attributes[attr("spawn.exit_code")] = data.exitCode
        span.attributes[attr("spawn.tainted")] = data.tainted === true
        Object.assign(span.attributes, usageAttributes(data.usage))
        const merge = data.merge as { status?: string; conflicts?: unknown[] } | null | undefined
        if (merge) {
          span.attributes[attr("worktree.merge")] = merge.status ?? ""
          span.attributes[attr("worktree.conflicts")] = merge.conflicts?.length ?? 0
        }
        span.status = outcome === "completed" ? { code: "ok" } : outcome === "stopped" ? { code: "unset" } : { code: "error" }
        if (outcome !== "completed" && outcome !== "stopped") span.attributes["error.type"] = outcome
        break
      }
      case "compaction.started": {
        const messageId = str("messageId") ?? ""
        const span = under(`compaction-${event.seq}`, spanIdOf(sessionId, "compaction", event.seq), "compaction", "internal", event.time, {
          [attr("compaction.trigger")]: str("trigger") ?? "",
          [attr("compaction.mode")]: str("mode") ?? "",
          [attr("compaction.tokens_before")]: Number(data.tokensBefore ?? 0),
          "gen_ai.conversation.id": sessionId,
          [attr("log.seq")]: event.seq,
        })
        compactions.set(messageId, span)
        owner.set(messageId, { span, execution: current })
        steps.set(`${messageId}#1`, { seq: event.seq, effort: settings.effort, finish: null, error: null, endMs: null })
        break
      }
      case "compaction.repair_requested": {
        const messageId = str("messageId") ?? ""
        compactions.get(messageId)?.events.push({ name: "compaction.repair_requested", timeMs: event.time, attributes: {} })
        steps.set(`${messageId}#${String(data.attempt)}`, { seq: event.seq, effort: settings.effort, finish: null, error: null, endMs: null })
        break
      }
      case "compaction.ended":
      case "compaction.failed": {
        const span = compactions.get(str("messageId") ?? "")
        if (span === undefined) break
        span.endMs = event.time
        if (event.type === "compaction.ended") {
          span.attributes[attr("compaction.source")] = str("source") ?? ""
          span.attributes[attr("compaction.tokens_after")] = Number(data.tokensAfter ?? 0)
          span.status = { code: "ok" }
        } else {
          span.attributes["error.type"] = errorType(data.error)
          span.status = { code: "error" }
        }
        break
      }
      case "checks.started": {
        const names = Array.isArray(data.checks) ? data.checks.filter((name): name is string => typeof name === "string") : []
        checks = under(`checks-${event.seq}`, spanIdOf(sessionId, "checks", event.seq), "checks", "internal", event.time, {
          [attr("checks.run")]: Number(data.run ?? 0),
          [attr("checks.names")]: names,
          [attr("log.seq")]: event.seq,
        })
        break
      }
      case "checks.finished":
      case "checks.failed": {
        if (checks === null) break
        checks.endMs = event.time
        if (event.type === "checks.failed") {
          checks.attributes[attr("checks.verdict")] = "error"
          checks.attributes["error.type"] = errorType(data.error)
          checks.status = { code: "error" }
        } else {
          const evidence = (data.evidence ?? {}) as { checks?: { name?: string; status?: string; reusedFromSeq?: number | null }[]; changedFiles?: unknown[] }
          const list = evidence.checks ?? []
          const failing = list.filter((check) => check.status !== "passed").map((check) => check.name ?? "")
          checks.attributes[attr("checks.verdict")] = failing.length === 0 ? "passed" : "failed"
          checks.attributes[attr("checks.failing")] = failing
          checks.attributes[attr("checks.reused")] = list.filter((check) => typeof check.reusedFromSeq === "number").length
          checks.attributes[attr("checks.changed_files")] = evidence.changedFiles?.length ?? 0
          checks.status = failing.length === 0 ? { code: "ok" } : { code: "error" }
          if (failing.length > 0) checks.attributes["error.type"] = "checks_failed"
        }
        checks = null
        break
      }
      default:
        if (!IGNORED.has(event.type)) unknownEvents[event.type] = (unknownEvents[event.type] ?? 0) + 1
    }
  }

  // One span per ledger row: every model call, each attempt its own, at the times the ledger stored.
  const answered = new Set<string>()
  for (const row of input.requests) {
    const key = `${row.messageId}#${row.attempt}`
    answered.add(key)
    const facts = steps.get(key) ?? null
    const retry = retries.get(row.messageId)?.find((entry) => entry.attempt === row.attempt + 1) ?? null
    const error = retry?.error ?? (row.outcome === "error" ? facts?.error : null) ?? null
    const belongs = owner.get(row.messageId) ?? null
    const execution = belongs?.execution ?? executions.find((candidate) => candidate.span.startMs <= row.startedAt && (candidate.span.endMs ?? Infinity) >= row.startedAt) ?? null
    const parent = belongs?.span ?? execution?.span ?? null
    if (execution !== null) {
      execution.calls += 1
      execution.input += row.usage?.inputTokens ?? 0
      execution.output += row.usage?.outputTokens ?? 0
      execution.cached += row.usage?.cachedInputTokens ?? 0
      execution.measured ||= row.usage !== null
    }
    const attributes: Attributes = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": provider,
      "gen_ai.request.model": row.model,
      "gen_ai.conversation.id": sessionId,
      ...(facts?.effort ? { "gen_ai.request.reasoning.level": facts.effort } : {}),
      ...(row.responseModel ? { "gen_ai.response.model": row.responseModel } : {}),
      ...usageAttributes(row.usage),
      ...(facts?.finish && row.outcome === "ok" ? { "gen_ai.response.finish_reasons": [facts.finish] } : {}),
      [attr("request.id")]: row.id,
      [attr("request.purpose")]: row.purpose,
      [attr("request.attempt")]: row.attempt,
      [attr("request.outcome")]: row.outcome ?? "in_flight",
      [attr("request.retried")]: retry !== null,
      [attr("request.blocks")]: row.blocks.length,
      ...(retry === null ? {} : { [attr("retry.delay_ms")]: retry.delayMs }),
      // The provider's own ID of the request, as the ledger kept it: of a call that finished and of one that failed.
      ...(row.providerRequestId ? { [attr("provider.request_id")]: row.providerRequestId } : {}),
      ...errorAttributes(error, row.errorKind),
    }
    const name = `chat ${row.model}`
    const spanId = spanIdOf(sessionId, "call", row.ordinal)
    const span = parent === null ? orphan(`call-${row.ordinal}`, name, "client", row.startedAt, attributes) : child(parent, spanId, name, "client", row.startedAt, attributes)
    span.endMs = row.finishedAt ?? facts?.endMs ?? lastOutput.get(row.messageId) ?? null
    span.status = row.outcome === "error" ? { code: "error", ...(typeof error?.message === "string" ? { message: text(error.message) } : {}) } : row.outcome === "ok" ? { code: "ok" } : { code: "unset" }
    if (content && row.purpose === "step" && row.outcome === "ok") {
      const parts = assistant.get(row.messageId)
      if (parts !== undefined) span.attributes["gen_ai.output.messages"] = messagesJson([{ role: "assistant", parts, ...(facts?.finish ? { finish_reason: facts.finish } : {}) }], secrets, maxChars)
    }
  }
  const stepsWithoutLedger = [...steps.keys()].filter((key) => !answered.has(key)).length

  // The execution's totals: what its model calls cost, summed from the ledger, and what it did.
  for (const execution of executions) {
    if (execution.measured) {
      execution.span.attributes["gen_ai.usage.input_tokens"] = execution.input
      execution.span.attributes["gen_ai.usage.output_tokens"] = execution.output
      execution.span.attributes["gen_ai.usage.cache_read.input_tokens"] = execution.cached
    }
    execution.span.attributes[attr("execution.steps")] = execution.steps
    execution.span.attributes[attr("execution.model_calls")] = execution.calls
    execution.span.attributes[attr("execution.tool_calls")] = execution.toolCalls
    execution.span.attributes[attr("execution.retries")] = execution.retries
    if (content && execution.inputs.length > 0) execution.span.attributes["gen_ai.input.messages"] = messagesJson(execution.inputs, secrets, maxChars)
  }

  // In start order (the order of the log), so a reader of the file sees the turn as it happened.
  const spans = builders.toSorted((a, b) => a.startMs - b.startMs).map((made): Span => {
    const isOpen = made.endMs === null
    return {
      traceId: made.traceId,
      spanId: made.spanId,
      parentSpanId: made.parentSpanId,
      name: made.name,
      kind: made.kind,
      startMs: made.startMs,
      endMs: Math.max(made.startMs, made.endMs ?? lastTime),
      open: isOpen,
      sessionId,
      attributes: isOpen ? { ...made.attributes, [attr("span.open")]: true } : made.attributes,
      events: made.events,
      links: made.links,
      status: made.status,
    }
  })
  return { sessionId, spans, unknownEvents, spawns, spawnedBy, stepsWithoutLedger }
}

function latestStep(steps: Map<string, StepFacts>, messageId: string): StepFacts | null {
  let found: StepFacts | null = null
  for (const [key, facts] of steps) if (key.startsWith(`${messageId}#`) && (found === null || facts.seq > found.seq)) found = facts
  return found
}

function usageAttributes(value: unknown): Attributes {
  if (typeof value !== "object" || value === null) return {}
  const usage = value as { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number }
  return {
    "gen_ai.usage.input_tokens": usage.inputTokens ?? 0,
    "gen_ai.usage.output_tokens": usage.outputTokens ?? 0,
    "gen_ai.usage.cache_read.input_tokens": usage.cachedInputTokens ?? 0,
    ...(usage.reasoningTokens ? { "gen_ai.usage.reasoning.output_tokens": usage.reasoningTokens } : {}),
  }
}

/** A provider error's facts; never its message, which goes in the status (bounded and redacted). */
function errorAttributes(error: Record<string, unknown> | null, kind: string | null): Attributes {
  if (error === null && kind === null) return {}
  const out: Attributes = { "error.type": (typeof error?.kind === "string" ? error.kind : null) ?? kind ?? "error" }
  if (typeof error?.requestId === "string") out[attr("provider.request_id")] = error.requestId
  if (typeof error?.status === "number") out[attr("provider.http_status")] = error.status
  if (typeof error?.code === "string") out[attr("provider.error_code")] = error.code
  if (typeof error?.reason === "string") out[attr("provider.transport_reason")] = error.reason
  if (typeof error?.retryable === "boolean") out[attr("provider.retryable")] = error.retryable
  return out
}

function errorType(error: unknown): string {
  const value = error as { kind?: string; error?: { kind?: string } } | undefined
  return value?.kind === "provider" ? (value.error?.kind ?? "provider") : (value?.kind ?? "error")
}

function verificationStatus(value: unknown): string {
  return typeof (value as { status?: unknown } | undefined)?.status === "string" ? (value as { status: string }).status : "unknown"
}

function partsOf(value: unknown): MessagePart[] {
  if (!Array.isArray(value)) return []
  return value.map((part: { type?: string; text?: string; mediaType?: string }): MessagePart =>
    part.type === "text" ? { type: "text", content: part.text ?? "" } : { type: "blob", mime_type: part.mediaType ?? "application/octet-stream" },
  )
}
