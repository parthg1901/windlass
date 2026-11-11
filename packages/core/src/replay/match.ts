/**
 * The matcher: does a tool call the replayed model just made correspond to a
 * call on the tape, and where on the tape is the replay now?
 *
 * Rules
 * 1. Identity. A replayed call matches a recorded call when the tool name is
 *    equal and the canonical JSON of the parsed arguments is equal, so key
 *    order and whitespace between tokens never matter. Arguments that are not
 *    JSON match only byte for byte. Empty argument text reads as `{}`, as the
 *    tool runtime reads it.
 * 2. Order within a step does not matter. The calls of one step run in
 *    parallel, so a model that asks for `read b` before `read a` is making the
 *    same step. Calls are matched as a multiset: each recorded call answers at
 *    most one replayed call, an exact match is preferred over a normalised
 *    one, and among equals the earliest recorded call wins. A reordering is
 *    counted, not reported as a divergence.
 * 3. Normalisers. A per-tool hook may rewrite parsed arguments before they are
 *    compared, for values that legitimately vary: a path given as `a.ts` or
 *    `/repo/a.ts` (`normalise.paths`), a command with trailing whitespace
 *    (`normalise.trimEnd`). Both sides are normalised the same way, with the
 *    recorded session's working directory. A match that needed a normaliser is
 *    counted as such. Normalisers never change what the tool would receive.
 * 4. Strict mode uses no normalisers and requires the replay's step
 *    boundaries to equal the recording's (rule 5 is off).
 * 5. Step boundaries. Outside strict mode a recorded step may be split over
 *    several replayed steps, and several recorded steps may be merged into one
 *    replayed step, but only where moving the boundary cannot change a result
 *    the tape hands back: every call of each recorded step involved has no
 *    side effect (it started as `read`, or never started), each was a
 *    complete response, and no input (a user message, a harness note, a
 *    settings change) arrived between merged steps. A write followed by a read
 *    of the same file in the next step is therefore never merged: run in
 *    parallel, the read might not see the write, and the recorded result would
 *    be a lie. Splits and merges are counted.
 *
 * A step the user interrupted while the model was streaming was cut at a
 * point the replay cannot see. Its recorded calls must all be made again;
 * further calls the replayed model makes in that step are dropped as the
 * interrupt dropped them (settled `not_started`), and its text may differ.
 *
 * Divergence. The first replayed call that matches nothing, a step that ends
 * with text while the recorded step still has calls, or a step that ends with
 * recorded calls left over where no split is allowed, leaves the tape. The
 * matcher then stops matching; it never tries to resynchronise, because after
 * a divergence the conversation, and possibly the workspace, differ from the
 * recording.
 */
import { resolve } from "node:path"
import type { Json } from "../json.ts"
import { canonicalJson } from "../request/canonical.ts"
import { parseArguments } from "../tool/args.ts"
import type { Tape, TapeCall, TapeInput, TapeStep } from "./tape.ts"

/** Rewrites parsed arguments of one tool before comparison. Must be pure. */
export type Normaliser = (args: Json, context: { readonly cwd: string }) => Json

export interface MatchOptions {
  /** No normalisers and exact step boundaries. Defaults to `false`. */
  readonly strict?: boolean
  /** Per tool name. Ignored in strict mode. */
  readonly normalisers?: Readonly<Record<string, Normaliser>>
  /** `flexible` (default) allows the splits and merges of rule 5; `exact` does not. */
  readonly boundaries?: "exact" | "flexible"
}

/** Ready-made normalisers. */
export const normalise = {
  /** Resolves these string fields against the session's working directory. */
  paths:
    (...keys: string[]): Normaliser =>
    (args, context) =>
      mapFields(args, keys, (value) => (typeof value === "string" ? resolve(context.cwd, value) : value)),
  /** Removes trailing whitespace from these string fields. */
  trimEnd:
    (...keys: string[]): Normaliser =>
    (args) =>
      mapFields(args, keys, (value) => (typeof value === "string" ? value.trimEnd() : value)),
  /** Applies several normalisers in order. */
  all:
    (...normalisers: Normaliser[]): Normaliser =>
    (args, context) =>
      normalisers.reduce((value, normaliser) => normaliser(value, context), args),
}

/** `canonicalJson` of the parsed argument text, or `null` when it is not JSON. */
export function argumentKey(text: string): string | null {
  const parsed = parseArguments(text)
  return parsed.ok ? canonicalJson(parsed.value) : null
}

/** A call as the matcher sees it. */
export interface CallShape {
  readonly name: string
  readonly argumentsText: string
}

/** What the recording did at the point of divergence. */
export type RecordedSide =
  | { readonly kind: "calls"; readonly calls: readonly CallShape[] }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "nothing"; readonly note: string }

/** What the replay did instead. */
export type ReplayedSide = { readonly kind: "call"; readonly call: CallShape } | { readonly kind: "text"; readonly text: string }

export type DivergenceKind =
  /** Same tool as a recorded call still due in this step, different arguments. */
  | "arguments_differ"
  /** A tool the recorded step did not call (or no longer had to call). */
  | "different_tool"
  /** The recorded step's calls were all made; the replay made one more. */
  | "extra_call"
  /** The recorded step answered with text; the replay called a tool. */
  | "call_instead_of_text"
  /** The recorded step called tools the replay did not call; the replay answered with text. */
  | "text_instead_of_call"
  /** The replay ended a step with recorded calls still due, where a split is not allowed. */
  | "missing_calls"
  /** The recording has no more steps; the replay kept going. */
  | "past_end"

export interface ArgumentChange {
  /** Dotted path into the arguments, `""` for the whole value. Array items as `[i]`. */
  readonly path: string
  /** Absent when the field is new in the replay. */
  readonly recorded?: Json
  /** Absent when the replay dropped the field. */
  readonly replayed?: Json
}

export interface Divergence {
  readonly kind: DivergenceKind
  /** 0-based index of the replayed step. */
  readonly replayStep: number
  /** 0-based index of the recorded step the replay was at, `null` past the end. */
  readonly recordedStep: number | null
  /** 0-based index of the call within the replayed step, `null` when the replay answered with text. */
  readonly callIndex: number | null
  readonly recorded: RecordedSide
  readonly replayed: ReplayedSide
  /** For `arguments_differ`: what changed, against the closest recorded call. */
  readonly argumentDiff: readonly ArgumentChange[] | null
}

export type CallMatch =
  | {
      readonly kind: "matched"
      readonly recorded: TapeCall
      readonly recordedStep: number
      /** `normalised` when only the normalised arguments were equal. */
      readonly via: "exact" | "normalised"
    }
  /** Made in a step the user interrupted, beyond the calls the recording kept. */
  | { readonly kind: "dropped"; readonly recordedStep: number }
  /** The call that left the tape. */
  | { readonly kind: "diverged"; readonly divergence: Divergence }
  /** Made after the tape was left. */
  | { readonly kind: "off_tape" }

export type StepVerdict =
  /** The step matched; go on. `interrupted` when the recorded step was cut by the user at this point. */
  | { readonly kind: "continue"; readonly recordedSteps: readonly number[]; readonly interrupted: boolean }
  /** The step matched and it was the recording's last. */
  | { readonly kind: "finished"; readonly recordedSteps: readonly number[]; readonly interrupted: boolean }
  | { readonly kind: "diverged"; readonly divergence: Divergence }
  /** The tape was left earlier. */
  | { readonly kind: "off_tape" }

export interface MatchStats {
  /** Recorded steps fully replayed. */
  readonly steps: number
  readonly calls: number
  readonly normalised: number
  /** Replayed steps whose calls came in another order than recorded. */
  readonly reordered: number
  readonly splits: number
  readonly merges: number
  readonly dropped: number
  /** Matched calls whose recorded outcome was `not_started`, answered as such. */
  readonly notStarted: number
  /** Matched calls whose recorded outcome was `effect_unknown`, answered as such. */
  readonly effectUnknown: number
}

/**
 * The tape cursor. One instance follows one replay: `takeInputs` before each
 * step, `matchCalls` with the step's calls (all of them at once, after the
 * response finished), `endStep` when the step is over.
 */
export class TapeMatcher {
  private cursor = 0
  private inputsGiven = 0
  private replayStep = 0
  private readonly consumed = new Set<string>()
  private batch = { calls: 0, touched: new Set<number>() }
  private left: Divergence | null = null
  private matchedAtDivergence: MatchStats | null = null
  private readonly stats = {
    calls: 0,
    normalised: 0,
    reordered: 0,
    splits: 0,
    merges: 0,
    dropped: 0,
    notStarted: 0,
    effectUnknown: 0,
  }
  private readonly normalisers: Readonly<Record<string, Normaliser>>
  private readonly flexible: boolean

  constructor(
    readonly tape: Tape,
    options: MatchOptions = {},
  ) {
    const strict = options.strict ?? false
    this.normalisers = strict ? {} : (options.normalisers ?? {})
    this.flexible = !strict && (options.boundaries ?? "flexible") === "flexible"
  }

  /** The divergence that left the tape, if any. */
  get divergence(): Divergence | null {
    return this.left
  }

  /** Every recorded step has been replayed. */
  get done(): boolean {
    return this.cursor >= this.tape.steps.length
  }

  /** What had matched when the tape was left, or now if it never was. */
  get matched(): MatchStats {
    return this.matchedAtDivergence ?? { ...this.stats, steps: this.cursor }
  }

  /** The recorded inputs due before the next step, in log order. Each is returned once. */
  takeInputs(): TapeInput[] {
    const due: TapeInput[] = []
    if (this.left !== null) return due
    while (this.inputsGiven < this.tape.inputs.length && this.tape.inputs[this.inputsGiven]!.beforeStep <= this.cursor)
      due.push(this.tape.inputs[this.inputsGiven++]!)
    return due
  }

  /** Matches all calls of the replayed step in progress. Call once per step, with the calls in the order the model made them. */
  matchCalls(calls: readonly CallShape[]): CallMatch[] {
    this.batch.calls += calls.length
    if (this.left !== null) return calls.map(() => ({ kind: "off_tape" }))
    const results: (CallMatch | undefined)[] = calls.map(() => undefined)
    const keys = calls.map((call) => this.keyOf(call.name, call.argumentsText))
    let pending = calls.map((_, index) => index)
    let target = this.cursor
    while (pending.length > 0 && target < this.tape.steps.length) {
      const step = this.tape.steps[target]!
      const order: number[] = []
      pending = pending.filter((index) => {
        const found = this.take(step, keys[index]!)
        if (found === null) return true
        order.push(found.call.index)
        results[index] = { kind: "matched", recorded: found.call, recordedStep: target, via: found.via }
        return false
      })
      if (order.length > 0) {
        this.batch.touched.add(target)
        if (order.some((value, index) => index > 0 && value < order[index - 1]!)) this.stats.reordered += 1
      }
      if (step.response === "cut") {
        for (const index of pending) results[index] = { kind: "dropped", recordedStep: target }
        this.stats.dropped += pending.length
        if (pending.length > 0) this.batch.touched.add(target)
        pending = []
        break
      }
      if (pending.length === 0 || this.remaining(step).length > 0 || !this.canMerge(target, target + 1)) break
      target += 1
    }
    for (const result of results)
      if (result?.kind === "matched") {
        this.stats.calls += 1
        if (result.via === "normalised") this.stats.normalised += 1
        if (result.recorded.settlement.outcome === "not_started") this.stats.notStarted += 1
        if (result.recorded.settlement.outcome === "effect_unknown") this.stats.effectUnknown += 1
      }
    const first = pending[0]
    if (first !== undefined) {
      const divergence = this.classify(first, calls[first]!)
      this.leave(divergence)
      results[first] = { kind: "diverged", divergence }
      for (const index of pending.slice(1)) results[index] = { kind: "off_tape" }
    }
    return results.map((result) => result ?? { kind: "off_tape" })
  }

  /** Ends the replayed step. `calls` is how many calls it made (all passed to `matchCalls`), `text` its text. */
  endStep(observed: { readonly calls: number; readonly text: string }): StepVerdict {
    if (observed.calls !== this.batch.calls)
      throw new Error(`the step made ${observed.calls} call(s) but ${this.batch.calls} were matched; pass every call to matchCalls`)
    const touched = [...this.batch.touched].sort((a, b) => a - b)
    this.batch = { calls: 0, touched: new Set() }
    const replayStep = this.replayStep++
    if (this.left !== null) return { kind: "off_tape" }
    const step = this.tape.steps[this.cursor]
    if (step === undefined) {
      const divergence: Divergence = {
        kind: "past_end",
        replayStep,
        recordedStep: null,
        callIndex: null,
        recorded: { kind: "nothing", note: "the recording ends here" },
        replayed: { kind: "text", text: observed.text },
        argumentDiff: null,
      }
      this.leave(divergence)
      return { kind: "diverged", divergence }
    }
    const due = this.remaining(step)
    if (observed.calls === 0 && due.length > 0)
      return this.diverge({
        kind: "text_instead_of_call",
        replayStep,
        recordedStep: step.index,
        callIndex: null,
        recorded: { kind: "calls", calls: due.map(shape) },
        replayed: { kind: "text", text: observed.text },
        argumentDiff: null,
      })
    const recordedSteps = observed.calls === 0 ? [this.cursor] : touched
    const interrupted = recordedSteps.some((index) => this.tape.steps[index]!.response === "cut")
    const last = recordedSteps.at(-1) ?? this.cursor
    while (this.cursor <= last && this.cursor < this.tape.steps.length && this.remaining(this.tape.steps[this.cursor]!).length === 0)
      this.cursor += 1
    this.stats.merges += Math.max(0, recordedSteps.length - 1)
    const open = this.tape.steps[this.cursor]
    if (open !== undefined && this.cursor <= last) {
      if (open.response === "complete" && this.flexible && open.calls.every(sideEffectFree)) this.stats.splits += 1
      else
        return this.diverge({
          kind: "missing_calls",
          replayStep,
          recordedStep: open.index,
          callIndex: null,
          recorded: { kind: "calls", calls: this.remaining(open).map(shape) },
          replayed: { kind: "text", text: observed.text },
          argumentDiff: null,
        })
    }
    return { kind: this.done ? "finished" : "continue", recordedSteps, interrupted }
  }

  private diverge(divergence: Divergence): StepVerdict {
    this.leave(divergence)
    return { kind: "diverged", divergence }
  }

  private leave(divergence: Divergence) {
    this.matchedAtDivergence = { ...this.stats, steps: this.cursor }
    this.left = divergence
  }

  private keyOf(name: string, text: string): { exact: string; normal: string } {
    const exact = `${name}\u0000${argumentKey(text) ?? `raw:${text}`}`
    const normaliser = this.normalisers[name]
    const parsed = parseArguments(text)
    if (normaliser === undefined || !parsed.ok) return { exact, normal: exact }
    return { exact, normal: `${name}\u0000${canonicalJson(normaliser(parsed.value, { cwd: this.tape.cwd }))}` }
  }

  private take(step: TapeStep, key: { exact: string; normal: string }) {
    const due = this.remaining(step).map((call) => ({ call, key: this.keyOf(call.name, call.input) }))
    const exact = due.find((candidate) => candidate.key.exact === key.exact)
    const found = exact ?? due.find((candidate) => candidate.key.normal === key.normal)
    if (found === undefined) return null
    this.consumed.add(`${step.index}:${found.call.index}`)
    return { call: found.call, via: exact === undefined ? ("normalised" as const) : ("exact" as const) }
  }

  private remaining(step: TapeStep): TapeCall[] {
    return step.calls.filter((call) => !this.consumed.has(`${step.index}:${call.index}`))
  }

  /** Whether the replay may move on from recorded step `from` to `next` within one replayed step (rule 5). */
  private canMerge(from: number, next: number): boolean {
    const a = this.tape.steps[from]
    const b = this.tape.steps[next]
    if (!this.flexible || a === undefined || b === undefined) return false
    const elastic = (step: TapeStep) => step.response === "complete" && step.calls.length > 0 && step.calls.every(sideEffectFree)
    return elastic(a) && elastic(b) && !this.tape.inputs.some((input) => input.beforeStep === next)
  }

  private classify(callIndex: number, call: CallShape): Divergence {
    const base = { replayStep: this.replayStep, callIndex, replayed: { kind: "call" as const, call } }
    const step = this.tape.steps[this.cursor]
    if (step === undefined)
      return { ...base, kind: "past_end", recordedStep: null, recorded: { kind: "nothing", note: "the recording ends here" }, argumentDiff: null }
    if (step.calls.length === 0)
      return { ...base, kind: "call_instead_of_text", recordedStep: step.index, recorded: { kind: "text", text: step.text }, argumentDiff: null }
    const due = this.remaining(step)
    if (due.length === 0)
      return {
        ...base,
        kind: "extra_call",
        recordedStep: step.index,
        recorded: { kind: "nothing", note: `the recording made no further call in step ${step.index + 1}` },
        argumentDiff: null,
      }
    const sameTool = due.filter((candidate) => candidate.name === call.name)
    if (sameTool.length === 0)
      return { ...base, kind: "different_tool", recordedStep: step.index, recorded: { kind: "calls", calls: due.map(shape) }, argumentDiff: null }
    const closest = sameTool
      .map((candidate) => ({ candidate, diff: diffArguments(candidate.input, call.argumentsText) }))
      .reduce((best, next) => (next.diff.length < best.diff.length ? next : best))
    return {
      ...base,
      kind: "arguments_differ",
      recordedStep: step.index,
      recorded: { kind: "calls", calls: [shape(closest.candidate)] },
      argumentDiff: closest.diff,
    }
  }
}

/** A call that cannot have changed anything: it started as `read`, or never started. */
export function sideEffectFree(call: TapeCall): boolean {
  return call.started === null || call.started.effect === "read"
}

/** The fields that differ between two argument texts. Text that is not JSON is compared whole. */
export function diffArguments(recorded: string, replayed: string): ArgumentChange[] {
  const a = parseArguments(recorded)
  const b = parseArguments(replayed)
  if (!a.ok || !b.ok) return recorded === replayed ? [] : [{ path: "", recorded, replayed }]
  return diffValues(a.value, b.value, "")
}

function diffValues(recorded: Json | undefined, replayed: Json | undefined, path: string): ArgumentChange[] {
  if (recorded !== undefined && replayed !== undefined && canonicalJson(recorded) === canonicalJson(replayed)) return []
  if (isRecord(recorded) && isRecord(replayed)) {
    const keys = [...new Set([...Object.keys(recorded), ...Object.keys(replayed)])].sort()
    return keys.flatMap((key) => diffValues(recorded[key], replayed[key], path === "" ? key : `${path}.${key}`))
  }
  if (Array.isArray(recorded) && Array.isArray(replayed) && recorded.length === replayed.length)
    return recorded.flatMap((item, index) => diffValues(item, replayed[index], `${path}[${index}]`))
  return [{ path, ...(recorded === undefined ? {} : { recorded }), ...(replayed === undefined ? {} : { replayed }) }]
}

function isRecord(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function shape(call: TapeCall): CallShape {
  return { name: call.name, argumentsText: call.input }
}

function mapFields(args: Json, keys: readonly string[], map: (value: Json) => Json): Json {
  if (!isRecord(args)) return args
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, keys.includes(key) ? map(value) : value]))
}
