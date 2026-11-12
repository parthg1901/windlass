/**
 * Comparing a replay with its recording on what it did to the workspace,
 * not on how it looked around.
 *
 * The strict matcher (`match.ts`) leaves the tape at the first call that is
 * not on it. A model that explores differently every time (another file
 * read first, `ls` instead of `glob`) leaves almost every recording that
 * way with nothing changed, so "it diverged" is noise. This module runs
 * after a replay is over, on the two sessions' tapes, and answers three
 * narrower questions:
 *
 * - **Effects** (`compareEffects`): did the replay make the same calls with
 *   side effects (writes, edits, commands that may change something), in the
 *   same order, whatever it read in between?
 * - **Lenient matching** (`lenientWalk`): how far would a matcher get that
 *   lets a read-only call off the recording pass, and answers it from the
 *   recording only where that is sound? This is the rule set a live matcher
 *   mode would use; here it is applied to the calls a finished replay made.
 * - **Outcome** (`finalSnapshot`): is the workspace the replay ended with
 *   the one the recording ended with? Snapshot IDs are git tree hashes, so
 *   equal IDs mean equal files.
 *
 * Rules
 * E1. Classes. A call is a `look` when it started with effect `read`, or it
 *     is a `shell` call (not in the background, no `sandbox` escalation)
 *     whose command `readOnlyCommand` accepts. It is `none` when it never
 *     started, or when it is a `write` / `edit` that settled `error`: those
 *     two tools check everything before they write, so an error means the
 *     file was not touched. Everything else is an `act`, including a call
 *     settled `effect_unknown` and any tool this module does not know.
 * E2. `readOnlyCommand` is an allowlist, not a guess: every command of a
 *     pipeline or list must be a known reader (`cat`, `ls`, `grep`, `sed -n
 *     Np`, `git status`, ...) with no option that writes, and the line may
 *     not redirect into a file, substitute a command, start a heredoc or run
 *     anything in the background. Anything it does not know is an `act`.
 *     This list is the soundness boundary of the whole module: a command it
 *     wrongly calls read-only would be ignored as a side effect, and under
 *     lenient matching a later answer served from the recording could be
 *     a lie about the workspace. Test runners, build tools and interpreters
 *     are acts, because they can write.
 * E3. Identity of an act is its tool name and its normalised arguments
 *     (paths resolved against the recording's directory, as the matcher's
 *     normalisers do); a `shell` act is identified by its trimmed command
 *     alone, so a different `timeout` is the same command.
 * E4. Order. Acts of one step ran in parallel, so they may be matched in any
 *     order against the acts of one step on the other side; across steps the
 *     order must be the same. The first act that has no partner is where the
 *     effects differ: `act_differs` (both sides still had acts), `extra_act`
 *     (only the replay did), `missing_act` (only the recording did).
 * L1. Lenient matching ignores looks for the purpose of divergence, but a
 *     look must still be answered. It may be answered from the recording only
 *     by an identical recorded call (exact or normalised, as rule 1 and 3 of
 *     `match.ts`) whose result describes the workspace the replay is in now:
 *     - the replay has not left the recording on an act, and has made all of
 *       the acts of the recorded steps before the recorded look, and none
 *       after it: no recorded act lies between the two points in either
 *       direction, and the replay is not halfway through a recorded step's
 *       parallel acts;
 *     - the recorded look's own step made no act (parallel to the look, it
 *       may have run before or after it);
 *     - both points are in the same turn (no user message between them: the
 *       user may have changed files by hand between turns);
 *     - the recorded call started and settled `success` or `error`, in a step
 *       whose response was complete.
 *     The looks of a replayed step are judged before that step's acts.
 * L2. Every other look must be run for real, in a copy of the workspace at
 *     the recorded state at that point. Under `stop`, which has no copy, the
 *     first such look is where a lenient replay would end.
 */
import type { Json } from "../json.ts"
import { canonicalJson } from "../request/canonical.ts"
import { parseArguments } from "../tool/args.ts"
import type { Normaliser } from "./match.ts"
import type { ReplayReport } from "./report.ts"
import { type Tape, type TapeCall, type TapeStep, tapeFromEvents } from "./tape.ts"

export type CallClass = "look" | "act" | "none"

/** Tools that validate before they write: an `error` from them means nothing was written. */
const FAILS_CLEAN = new Set(["write", "edit"])

/** E1: what a recorded call was, for the comparison. */
export function classifyCall(call: TapeCall): CallClass {
  if (call.started === null) return "none"
  if (call.started.effect === "read") return "look"
  if (FAILS_CLEAN.has(call.name) && call.settlement.outcome === "error") return "none"
  if (call.name === "shell" && readOnlyShellCall(call.input)) return "look"
  return "act"
}

function readOnlyShellCall(argumentsText: string): boolean {
  const parsed = parseArguments(argumentsText)
  if (!parsed.ok || !isRecord(parsed.value)) return false
  const { command, background, sandbox } = parsed.value
  if (typeof command !== "string" || background === true || (sandbox !== undefined && sandbox !== null)) return false
  return readOnlyCommand(command).readOnly
}

export type CommandVerdict = { readonly readOnly: true } | { readonly readOnly: false; readonly why: string }

/** Redirections that cannot write a file. Everything else that contains `>` is refused. */
const HARMLESS_REDIRECTS = /\s*(?:[12]?>\s*\/dev\/null|2>&1|1>&2|>&2)(?=\s|$|[|;&])/g

/** Readers: commands that, with the options below refused, only print. */
const READERS = new Set([
  "cat", "head", "tail", "ls", "pwd", "wc", "grep", "egrep", "fgrep", "rg", "nl", "stat", "file", "tree", "du",
  "echo", "printf", "which", "true", "cut", "tr", "diff", "cmp", "basename", "dirname", "realpath", "readlink",
  "jq", "column", "od", "xxd", "hexdump", "md5sum", "sha1sum", "sha256sum", "test", "[",
])
const GIT_READERS = new Set(["status", "log", "diff", "show", "ls-files", "grep", "rev-parse", "blame", "describe", "shortlog"])
/** Options that make an otherwise reading command write or run something. */
const WRITING_OPTIONS: Readonly<Record<string, RegExp>> = {
  find: /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  sort: /^(?:-o|--output)/,
  rg: /^--pre(?:=|$)/,
  git: /^--output(?:=|$)/,
  xxd: /^-r$/,
}

/**
 * E2: whether a command line only reads. Conservative: anything not on the
 * allowlist, or not understood, is not read-only.
 */
export function readOnlyCommand(command: string): CommandVerdict {
  const line = command.replace(HARMLESS_REDIRECTS, " ").trim()
  if (line === "") return { readOnly: false, why: "an empty command" }
  if (/[`\n\r]|\$\(|<\(|>\(|<<|[<>]/.test(line)) return { readOnly: false, why: "it redirects, substitutes a command or spans lines" }
  const segments = splitList(line)
  if (segments === null) return { readOnly: false, why: "its quoting is not understood" }
  for (const words of segments) {
    if (words.length === 0) return { readOnly: false, why: "an empty command in a list, or a background job" }
    const verdict = readerVerdict(words)
    if (!verdict.readOnly) return verdict
  }
  return { readOnly: true }
}

function readerVerdict(words: readonly string[]): CommandVerdict {
  // Variable assignments in front of a command (`LC_ALL=C grep`) change only its environment.
  const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  if (start === -1) return { readOnly: false, why: "only variable assignments" }
  const [name, ...args] = words.slice(start) as [string, ...string[]]
  if (name === "cd") return args.length <= 1 ? { readOnly: true } : { readOnly: false, why: "cd with more than one argument" }
  const writing = WRITING_OPTIONS[name]
  if (writing !== undefined && args.some((arg) => writing.test(arg))) return { readOnly: false, why: `${name} with an option that writes or runs something` }
  if (name === "find") return { readOnly: true }
  if (name === "sort") return { readOnly: true }
  if (name === "sed") {
    // Only `sed -n '<lines>p' [files]`: the form models use to print a range. Any other script may write (`w`, `-i`).
    const [flag, script, ...files] = args
    const printOnly = flag === "-n" && script !== undefined && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(script)
    return printOnly && files.every((file) => !file.startsWith("-")) ? { readOnly: true } : { readOnly: false, why: "a sed script other than printing a range" }
  }
  if (name === "git") {
    const sub = args.find((arg) => !arg.startsWith("-"))
    if (args.some((arg) => arg === "-c" || arg.startsWith("--git-dir") || arg.startsWith("--work-tree"))) return { readOnly: false, why: "git with configuration overrides" }
    if (sub === "branch") return args.slice(args.indexOf(sub) + 1).every((arg) => arg.startsWith("-") && !/^-(?:d|D|m|M|c|C|f)$|^--(?:delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(arg)) ? { readOnly: true } : { readOnly: false, why: "git branch that may change branches" }
    return sub !== undefined && GIT_READERS.has(sub) ? { readOnly: true } : { readOnly: false, why: `git ${sub ?? ""}`.trimEnd() + " is not a reading git command" }
  }
  if (name === "uniq") return args.filter((arg) => !arg.startsWith("-")).length <= 1 ? { readOnly: true } : { readOnly: false, why: "uniq with an output file" }
  return READERS.has(name) ? { readOnly: true } : { readOnly: false, why: `${name} is not a known reader` }
}

/** Splits a command line on `;`, `&&`, `||`, `|` and `&` outside quotes into words. `null` when a quote is not closed. */
function splitList(line: string): string[][] | null {
  const segments: string[][] = [[]]
  let word: string | null = null
  let quote: "'" | '"' | null = null
  const push = () => {
    if (word !== null) segments.at(-1)!.push(word)
    word = null
  }
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === "\\" && quote === '"' && index + 1 < line.length) word = (word ?? "") + line[++index]!
      else word = (word ?? "") + char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      word = word ?? ""
    } else if (char === "\\" && index + 1 < line.length) word = (word ?? "") + line[++index]!
    else if (/\s/.test(char)) push()
    else if (char === ";" || char === "|" || char === "&") {
      push()
      // `&&`, `||`: one separator. A lone `&` runs the command before it in the background: an empty segment refuses it.
      const double = line[index + 1] === char
      if (double) index += 1
      segments.push([])
      if (char === "&" && !double) segments.push([])
    } else word = (word ?? "") + char
  }
  if (quote !== null) return null
  push()
  // A trailing `;` leaves an empty last segment, which is harmless.
  if (segments.length > 1 && segments.at(-1)!.length === 0 && /;\s*$/.test(line)) segments.pop()
  return segments
}

/** An act or a look, where it was made. */
export interface ClassifiedCall {
  /** 0-based step of its own session. */
  readonly step: number
  readonly call: number
  readonly name: string
  readonly argumentsText: string
  readonly class: CallClass
  /** E3: what identifies it. */
  readonly key: string
}

export interface EffectOptions {
  /** Per tool, as the matcher's normalisers. Default none. */
  readonly normalisers?: Readonly<Record<string, Normaliser>>
  /** The directory relative paths are resolved against, for both sides. Default the recording's. */
  readonly cwd?: string
}

/** Every call of a tape that started, with its class and key, in order. */
export function classifyTape(tape: Tape, options: EffectOptions = {}): ClassifiedCall[] {
  const cwd = options.cwd ?? tape.cwd
  return tape.steps.flatMap((step) =>
    step.calls.map((call) => ({ step: step.index, call: call.index, name: call.name, argumentsText: call.input, class: classifyCall(call), key: effectKey(call.name, call.input, cwd, options.normalisers) })),
  )
}

/** E3. */
export function effectKey(name: string, argumentsText: string, cwd: string, normalisers: Readonly<Record<string, Normaliser>> = {}): string {
  const parsed = parseArguments(argumentsText)
  if (!parsed.ok) return `${name}\u0000raw:${argumentsText}`
  if (name === "shell" && isRecord(parsed.value) && typeof parsed.value.command === "string")
    return `shell\u0000${parsed.value.command.trim()}${parsed.value.background === true ? "\u0000background" : ""}`
  const normaliser = normalisers[name]
  return `${name}\u0000${canonicalJson(normaliser === undefined ? parsed.value : normaliser(parsed.value, { cwd }))}`
}

export type EffectDifferenceKind = "act_differs" | "extra_act" | "missing_act"

export interface EffectDifference {
  readonly kind: EffectDifferenceKind
  /** The first recorded act left unmatched, if any. */
  readonly recorded: ClassifiedCall | null
  /** The first replayed act left unmatched, if any. */
  readonly replayed: ClassifiedCall | null
}

export interface EffectComparison {
  /** Both made the same acts, in an order rule E4 allows. */
  readonly same: boolean
  /** Acts matched before the first difference (all of them when `same`). */
  readonly matched: number
  readonly recorded: { readonly acts: number; readonly looks: number }
  readonly replayed: { readonly acts: number; readonly looks: number }
  readonly first: EffectDifference | null
}

/** E4: the acts of two sessions, compared. */
export function compareEffects(recorded: Tape, replayed: Tape, options: EffectOptions = {}): EffectComparison {
  const cwd = options.cwd ?? recorded.cwd
  const a = classifyTape(recorded, { ...options, cwd })
  const b = classifyTape(replayed, { ...options, cwd })
  const walk = new EffectFrontier(a.filter((call) => call.class === "act"))
  for (const step of groupBySteps(b.filter((call) => call.class === "act"))) if (!walk.offer(step)) break
  const first = walk.difference()
  return {
    same: first === null,
    matched: walk.matched,
    recorded: { acts: a.filter((call) => call.class === "act").length, looks: a.filter((call) => call.class === "look").length },
    replayed: { acts: b.filter((call) => call.class === "act").length, looks: b.filter((call) => call.class === "look").length },
    first,
  }
}

/** The recorded acts, consumed group by group (one group per recorded step), against replayed acts offered one replayed step at a time. */
class EffectFrontier {
  private readonly groups: ClassifiedCall[][]
  private group = 0
  private remaining: ClassifiedCall[]
  private leftover: ClassifiedCall[] = []
  matched = 0

  constructor(acts: readonly ClassifiedCall[]) {
    this.groups = groupBySteps(acts)
    this.remaining = [...(this.groups[0] ?? [])]
  }

  /** Whether the recorded steps up to (not including) the current group are all consumed and the current one is untouched. */
  get atBoundary(): boolean {
    return this.leftover.length === 0 && this.remaining.length === (this.groups[this.group]?.length ?? 0)
  }

  /** The recorded step of the last group consumed whole, -1 before any. */
  get lastConsumedStep(): number {
    return this.group === 0 ? -1 : this.groups[this.group - 1]![0]!.step
  }

  /** The recorded step of the group in progress, `Infinity` when all are consumed. */
  get currentStep(): number {
    return this.groups[this.group]?.[0]?.step ?? Number.POSITIVE_INFINITY
  }

  get diverged(): boolean {
    return this.leftover.length > 0
  }

  /** Matches one replayed step's acts. Returns `false` at the first act without a partner. */
  offer(acts: readonly ClassifiedCall[]): boolean {
    if (this.diverged) return false
    let pending = [...acts]
    while (pending.length > 0) {
      if (this.remaining.length === 0) {
        this.leftover = pending
        return false
      }
      pending = pending.filter((act) => {
        const at = this.remaining.findIndex((candidate) => candidate.key === act.key)
        if (at === -1) return true
        this.remaining.splice(at, 1)
        this.matched += 1
        return false
      })
      if (this.remaining.length === 0) this.advance()
      else if (pending.length > 0) {
        // The recorded step still has acts due, and this replayed step made one that is not among them.
        this.leftover = pending
        return false
      }
    }
    return true
  }

  private advance() {
    this.group += 1
    this.remaining = [...(this.groups[this.group] ?? [])]
  }

  difference(): EffectDifference | null {
    const recorded = this.remaining[0] ?? null
    const replayed = this.leftover[0] ?? null
    if (recorded === null && replayed === null) return null
    return { kind: recorded !== null && replayed !== null ? "act_differs" : replayed !== null ? "extra_act" : "missing_act", recorded, replayed }
  }
}

function groupBySteps(calls: readonly ClassifiedCall[]): ClassifiedCall[][] {
  const groups: ClassifiedCall[][] = []
  for (const call of calls) {
    const last = groups.at(-1)
    if (last !== undefined && last[0]!.step === call.step) last.push(call)
    else groups.push([call])
  }
  return groups
}

/** How a lenient matcher would have answered one replayed look. */
export type LookAnswer = "served" | "must_run"

export interface LenientWalk {
  /** The effect comparison, which is where a lenient replay with a copy (`execute`) leaves the recording. */
  readonly effects: EffectComparison
  readonly looks: { readonly total: number; readonly served: number; readonly mustRun: number }
  /** The first replayed look no recorded result can soundly answer: where a lenient replay without a copy (`stop`) would end. `null` when there is none before the effects differ. */
  readonly firstMustRun: (ClassifiedCall & { readonly why: string }) | null
  /** Per replayed look, in order. */
  readonly answers: readonly { readonly look: ClassifiedCall; readonly answer: LookAnswer; readonly why: string }[]
}

/**
 * L1, L2: walks the calls a replay made and says, for each look, whether a
 * lenient matcher could have answered it from the recording, and where the
 * replay leaves the recording on its acts.
 */
export function lenientWalk(recorded: Tape, replayed: Tape, options: EffectOptions = {}): LenientWalk {
  const cwd = options.cwd ?? recorded.cwd
  const recordedCalls = classifyTape(recorded, { ...options, cwd })
  const replayedCalls = classifyTape(replayed, { ...options, cwd })
  const frontier = new EffectFrontier(recordedCalls.filter((call) => call.class === "act"))
  const recordedTurn = turnsOf(recorded)
  const replayedTurn = turnsOf(replayed)
  const servable = recordedCalls.filter((call) => call.class === "look" && soundRecordedLook(recorded.steps[call.step]!, call.call))
  const stepHasAct = new Set(recordedCalls.filter((call) => call.class === "act").map((call) => call.step))
  const answers: { look: ClassifiedCall; answer: LookAnswer; why: string }[] = []
  let firstMustRun: LenientWalk["firstMustRun"] = null

  for (const step of replayed.steps) {
    const mine = replayedCalls.filter((call) => call.step === step.index)
    for (const look of mine.filter((call) => call.class === "look")) {
      const why = ((): string | null => {
        if (frontier.diverged) return "the replay already made an act the recording did not"
        if (!frontier.atBoundary) return "the replay is halfway through a recorded step's parallel acts"
        const candidates = servable.filter((call) => call.key === look.key)
        if (candidates.length === 0) return "no identical call on the recording"
        const fits = candidates.find(
          (call) => call.step > frontier.lastConsumedStep && call.step < frontier.currentStep && !stepHasAct.has(call.step) && recordedTurn(call.step) === replayedTurn(step.index),
        )
        if (fits !== undefined) return null
        if (candidates.every((call) => recordedTurn(call.step) !== replayedTurn(step.index))) return "the identical recorded call is in another turn"
        return "a recorded act lies between the identical recorded call and this point"
      })()
      answers.push({ look, answer: why === null ? "served" : "must_run", why: why ?? "an identical recorded call saw this workspace" })
      if (why !== null && firstMustRun === null && !frontier.diverged) firstMustRun = { ...look, why }
    }
    const acts = mine.filter((call) => call.class === "act")
    if (acts.length > 0) frontier.offer(acts)
  }

  // The effects as `compareEffects` sees them: the same frontier, fed the same steps.
  const first = frontier.difference()
  const effects: EffectComparison = {
    same: first === null,
    matched: frontier.matched,
    recorded: { acts: recordedCalls.filter((call) => call.class === "act").length, looks: recordedCalls.filter((call) => call.class === "look").length },
    replayed: { acts: replayedCalls.filter((call) => call.class === "act").length, looks: replayedCalls.filter((call) => call.class === "look").length },
    first,
  }
  return {
    effects,
    looks: { total: answers.length, served: answers.filter((entry) => entry.answer === "served").length, mustRun: answers.filter((entry) => entry.answer === "must_run").length },
    firstMustRun,
    answers,
  }
}

/** L1, last condition: the recorded result is one a tool produced, in a response the model finished. */
function soundRecordedLook(step: TapeStep, callIndex: number): boolean {
  const call = step.calls[callIndex]!
  return step.response === "complete" && call.started !== null && (call.settlement.outcome === "success" || call.settlement.outcome === "error")
}

/** The turn of each step: how many user messages arrived before it. */
function turnsOf(tape: Tape): (step: number) => number {
  const users = tape.inputs.filter((input) => input.kind === "message" && input.from === "user").map((input) => input.beforeStep)
  return (step) => users.filter((before) => before <= step).length
}

/** The snapshot of the workspace a session ended with: the last `snapshot.taken`, or `null` when it took none. */
export function lastSnapshot(events: readonly { readonly type: string; readonly data?: unknown }[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!
    if (item.type === "snapshot.taken") return (item.data as { readonly id: string }).id
  }
  return null
}

/**
 * The workspace a replay ended with, as a snapshot ID: the last snapshot its
 * copy took after `replay.diverged`, else the snapshot the copy was restored
 * from. Only as good as the log: the step in which a replay leaves the
 * recording is not bracketed by snapshots (see `compareReplay`). `recorded` when it never left the recording (it made the recorded
 * calls, so it ends where the recording did). `null` when it left without a
 * copy (`stop`) or no snapshot was taken.
 */
export function finalSnapshot(replayEvents: readonly { readonly type: string; readonly data?: unknown }[], recordedFinal: string | null): string | null {
  const diverged = replayEvents.findIndex((item) => item.type === "replay.diverged")
  if (diverged === -1) {
    const ended = replayEvents.find((item) => item.type === "replay.ended")
    return (ended?.data as { readonly outcome?: string } | undefined)?.outcome === "identical" ? recordedFinal : null
  }
  return lastSnapshot(replayEvents.slice(diverged + 1)) ?? ((replayEvents[diverged]!.data as { readonly snapshot: string | null }).snapshot ?? null)
}

function isRecord(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** What `compareReplay` says about one finished replay. */
export interface ReplayComparison {
  /** The acts compared (rule E4). `null` when the replay did not reach an answer of its own, so there is nothing whole to compare. */
  readonly effects: { readonly same: boolean; readonly matched: number; readonly recordedActs: number; readonly replayedActs: number; readonly first: string | null } | null
  /** Where a lenient matcher without a copy would have ended (L1, L2), `null` when it would not have; with how many looks it could serve. `null` as `effects`. */
  readonly lenient: { readonly served: number; readonly mustRun: number; readonly left: string | null } | null
  /** Whether it ended with the recording's files (equal snapshot IDs); `null` when not known (it left without a copy, or no snapshot was taken). */
  readonly sameWorkspace: boolean | null
}

type AnyEvent = Parameters<typeof tapeFromEvents>[0][number]

/**
 * The comparison on side effects, lenient matching and outcome of a replay
 * session with its recording, from both logs. `replayFinal` is the snapshot
 * of the copy the replay ended in, taken after it ended; give it whenever
 * the copy is still there: the replay's log does not bracket the step in
 * which it left the recording with snapshots, so `finalSnapshot` of the log
 * misses that step's changes when no later step took one.
 */
export function compareReplay(recordedEvents: readonly AnyEvent[], replayEvents: readonly AnyEvent[], report: Pick<ReplayReport, "status" | "comparison">, options: EffectOptions & { readonly replayFinal?: string | null } = {}): ReplayComparison {
  const recordedFinal = lastSnapshot(recordedEvents)
  const final = options.replayFinal !== undefined ? options.replayFinal : finalSnapshot(replayEvents, recordedFinal)
  let sameWorkspace = final === null || recordedFinal === null ? null : final === recordedFinal
  // Only a replay that reached an answer of its own made everything it was going to make.
  const whole = (report.status === "identical" || report.status === "diverged") && report.comparison.finalAnswer.replayed !== null
  if (!whole) return { effects: null, lenient: null, sameWorkspace }
  const walk = lenientWalk(tapeFromEvents(recordedEvents), tapeFromEvents(replayEvents), options)
  const effects = walk.effects
  const look = walk.firstMustRun
  // It answered before leaving on a call: nothing ran for real, every recorded act was made and answered from the
  // recording, and none is left, so its files are the recording's at the end.
  const onlyFromTape = !replayEvents.some((item) => item.type === "replay.diverged")
  if (sameWorkspace === null && onlyFromTape && effects.same && recordedFinal !== null) sameWorkspace = true
  return {
    effects: { same: effects.same, matched: effects.matched, recordedActs: effects.recorded.acts, replayedActs: effects.replayed.acts, first: effectPlace(effects) },
    lenient: { served: walk.looks.served, mustRun: walk.looks.mustRun, left: look !== null ? `step ${look.step + 1} ${callLabel(look)} (a look not on the recording)` : effectPlace(effects) },
    sameWorkspace,
  }
}

/** A call in a few words: its tool and its command, path or pattern. */
export function callLabel(call: { readonly name: string; readonly argumentsText: string }): string {
  const parsed = parseArguments(call.argumentsText)
  const args = parsed.ok && isRecord(parsed.value) ? parsed.value : {}
  const value = call.name === "shell" ? args.command : (args.path ?? args.pattern)
  return typeof value === "string" ? `${call.name} ${JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value)}` : call.name
}

/** Where the acts first differ, in a few words; `null` when they do not. */
export function effectPlace(effects: EffectComparison): string | null {
  const first = effects.first
  if (first === null) return null
  const call = first.replayed ?? first.recorded!
  return `act ${effects.matched + 1}: ${first.replayed === null ? "recorded " : ""}${callLabel(call)} (${first.kind.replaceAll("_", " ")})`
}

/** The comparison as text, for the end of a replay report. */
export function renderComparison(comparison: ReplayComparison): string {
  const lines = ["compared on what it did (reads ignored)"]
  lines.push(
    comparison.effects === null
      ? "  side effects   not compared: the replay stopped before an answer of its own (use --policy execute)"
      : comparison.effects.same
        ? `  side effects   the same ${comparison.effects.recordedActs} act${comparison.effects.recordedActs === 1 ? "" : "s"} as the recording`
        : `  side effects   differ at ${comparison.effects.first} (recorded ${comparison.effects.recordedActs}, replayed ${comparison.effects.replayedActs})`,
  )
  if (comparison.lenient !== null)
    lines.push(`  lenient        ${comparison.lenient.left === null ? "would have stayed on the recording" : `would have left at ${comparison.lenient.left}`} (${comparison.lenient.served} reads answerable from the recording, ${comparison.lenient.mustRun} not)`)
  lines.push(`  files          ${comparison.sameWorkspace === null ? "not known (no copy, or no snapshot)" : comparison.sameWorkspace ? "the same as the recording's at its end" : "differ from the recording's at its end"}`)
  return lines.join("\n")
}
