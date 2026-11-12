/**
 * Generates long synthetic coding-agent sessions with planted, checkable facts.
 *
 * A session is a fictional TypeScript billing service ("ledgerline") being
 * worked on: user requests, tool calls (read, grep, shell, edit) with their
 * results, and assistant text. Filler turns are generated from templates and
 * contain plenty of look-alikes on purpose (other paths, other commands and
 * exit codes, other errors), so recall is not a keyword lottery. At planned
 * positions, fact turns plant one detail each:
 *
 * - `decision`: a choice between two options and its reason;
 * - `path_line`: the exact file and line where a bug was found (only in a tool result and one sentence);
 * - `command_exit`: an exact command and its exit code (the code only in the tool result);
 * - `error_message`: an exact error message inside a noisy tool output;
 * - `preserved_value`: a value the user asked to keep exactly;
 * - `correction`: an instruction, then the user's correction of it later (the latest wins);
 * - `distractor`: a fact next to a near-identical decoy that means something else.
 *
 * Everything is deterministic from the seed. Templates and pools are written
 * by hand; nothing comes from real sessions.
 */
import { estimateMessage } from "../../packages/core/src/context/estimate.ts"
import type { Message } from "../../packages/core/src/message/message.ts"
import { type Call, SessionBuilder, edit, grep, read, shell } from "./session.ts"

export type FactType = "decision" | "path_line" | "command_exit" | "error_message" | "preserved_value" | "correction" | "distractor"
export const FACT_TYPES: readonly FactType[] = ["decision", "path_line", "command_exit", "error_message", "preserved_value", "correction", "distractor"]

export type Position = "early" | "middle" | "late"

/** A string that must appear in the answer, or a number that must appear on its own. */
export type Needle = string | { readonly number: number }

export type GradingRule =
  /**
   * Every needle appears in the answer. Checked without a model, unless the
   * answer also names a look-alike from `ambiguousIf` (as a whole token): then
   * a model judge decides with `rubric` whether it named the right one.
   */
  | {
      readonly kind: "contains"
      readonly all: readonly Needle[]
      readonly ambiguousIf?: readonly Needle[]
      readonly rubric?: string
    }
  /** `mustContain` is checked first without a model; then a model judge decides with `rubric`. */
  | { readonly kind: "judge"; readonly mustContain: readonly Needle[]; readonly rubric: string }

export interface Fact {
  readonly id: string
  readonly type: FactType
  readonly question: string
  readonly gold: string
  readonly rule: GradingRule
  /** `seq` of the message that plants it (for a correction, the correction). */
  readonly seq: number
  /** Where it sits in the part of the session that a compaction removes, from 0 to 1. */
  readonly fraction: number
  readonly position: Position
}

export interface GeneratedSession {
  readonly seed: number
  readonly messages: readonly Message[]
  readonly facts: readonly Fact[]
  /** Index of the final user message: everything before it is the part a compaction removes. */
  readonly finalTurn: number
  readonly tokens: number
}

export interface GenerateOptions {
  readonly seed: number
  /** Approximate tokens of history (by `estimateMessage`). */
  readonly tokens: number
  readonly facts: number
}

export function generateSession(options: GenerateOptions): GeneratedSession {
  const rng = new Random(options.seed)
  const builder = new SessionBuilder()
  const pools = new Pools(rng)
  const budget = options.tokens - 900 // the final turn
  const plan = planFacts(rng, options.facts)
  const facts: Fact[] = []
  const pending = plan.flatMap((planned, index) => {
    const instance = pools.instance(planned.type)
    const id = `f${String(index + 1).padStart(2, "0")}-${planned.type}`
    // A correction is planted twice: the original instruction well before the correction.
    const early = planned.type === "correction" ? [{ at: planned.fraction * 0.35, index, id, instance, part: "original" as const }] : []
    return [...early, { at: planned.fraction, index, id, instance, part: "main" as const }]
  })
  pending.sort((a, b) => a.at - b.at || a.index - b.index)

  let size = 0
  let turn = 0
  const measure = () => {
    size = builder.messages.reduce((sum, message) => sum + estimateMessage(message), 0)
  }
  let lastWasFact = false
  while (size < budget || pending.length > 0 || lastWasFact) {
    const next = pending[0]
    if (next !== undefined && next.at * budget <= size) {
      pending.shift()
      const seq = next.instance.plant(builder, next.part)
      measure()
      if (next.part === "main") facts.push({ id: next.id, type: next.instance.type, ...next.instance.fact, seq, fraction: 0, position: "early" })
      lastWasFact = true
      continue
    }
    // A filler turn always separates the last fact from the final turn, so no fact lands in a kept tail.
    fillerTurn(builder, rng, pools, turn)
    lastWasFact = false
    turn += 1
    measure()
  }
  const finalTurn = builder.messages.length
  builder.user("Good. Next, update docs/configuration.md so the options it lists match what src/config/schema.ts accepts today.")
  builder.step({ calls: [read("docs/configuration.md", pools.prose(14).split(". "))] })
  measure()
  // Where each fact sits in the removable part, by tokens up to and including its planting message.
  const removable = builder.messages.slice(0, finalTurn)
  const total = removable.reduce((sum, message) => sum + estimateMessage(message), 0)
  const placed = facts
    .map((fact) => {
      const before = removable.filter((message) => message.seq <= fact.seq).reduce((sum, message) => sum + estimateMessage(message), 0)
      const fraction = Math.round((before / total) * 1000) / 1000
      return { ...fact, fraction, position: positionOf(fraction) }
    })
    .sort((a, b) => a.seq - b.seq)
  return { seed: options.seed, messages: builder.messages, facts: placed, finalTurn, tokens: size }
}

function positionOf(fraction: number): Position {
  return fraction < 1 / 3 ? "early" : fraction < 2 / 3 ? "middle" : "late"
}

/** Types spread evenly over the session: each third gets its share, types shuffled. */
function planFacts(rng: Random, count: number) {
  const types = Array.from({ length: count }, (_, index) => FACT_TYPES[index % FACT_TYPES.length]!)
  const shuffled = rng.shuffle(types)
  return shuffled.map((type, index) => ({ type, fraction: Math.min(0.97, (index + 0.3 + rng.next() * 0.4) / count) }))
}

// ---- deterministic randomness ----

export class Random {
  private state: number
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9
  }
  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }
  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)]!
  }
  shuffle<T>(values: readonly T[]): T[] {
    const copy = [...values]
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.next() * (index + 1))
      ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
    }
    return copy
  }
  hex(length: number): string {
    return Array.from({ length }, () => "0123456789abcdef"[Math.floor(this.next() * 16)]).join("")
  }
}

// ---- filler ----

const MODULES = ["invoices", "payments", "customers", "plans", "taxes", "refunds", "webhooks", "exports", "ledger", "mailer", "reports", "accounts", "discounts", "usage"]
const FILES = ["service.ts", "repository.ts", "schema.ts", "format.ts", "validate.ts", "index.ts", "routes.ts"]
const VERBS = ["compute", "load", "format", "validate", "apply", "merge", "resolve", "build", "parse", "normalize", "list", "find", "update", "record"]
const NOUNS = ["Total", "Invoice", "Customer", "Plan", "Rate", "Period", "Balance", "Entry", "Line", "Schedule", "Receipt", "Account", "Discount", "Batch"]
const WORDS = ["the", "value", "is", "kept", "in", "cents", "and", "every", "call", "checks", "that", "input", "before", "writing", "to", "store", "so", "a", "retry", "never", "duplicates", "rows", "when", "period", "ends", "we", "close", "it", "with", "one", "transaction", "which", "keeps", "totals", "consistent"]

function fillerTurn(builder: SessionBuilder, rng: Random, pools: Pools, turn: number) {
  const module = rng.pick(MODULES)
  const kind = turn % 4
  if (kind === 0) {
    builder.user(`Can you look at how ${module} ${rng.pick(["handles", "computes", "stores", "validates"])} ${rng.pick(["totals", "periods", "retries", "rounding", "currencies", "batches"])}? ${pools.sentence()}`)
    builder.step({ calls: [{ name: "ls", input: { path: `src/${module}` }, output: rng.shuffle(FILES).slice(0, 5).join("\n") }] })
    const file = `src/${module}/${rng.pick(FILES)}`
    builder.step({ calls: [read(file, pools.code(rng.int(60, 110))), grep(`${rng.pick(VERBS)}${rng.pick(NOUNS)}`, pools.matches(rng.int(3, 7)))] })
    builder.step({ text: `${pools.prose(rng.int(4, 7))}\n\nIn short, ${file} ${pools.sentence()}` })
    return
  }
  if (kind === 1) {
    const command = `bun test test/${module}`
    builder.user(`Run the ${module} tests and fix whatever fails.`)
    const failing = `${module} > ${rng.pick(VERBS)}s ${rng.pick(NOUNS).toLowerCase()} ${rng.pick(["correctly", "for empty input", "across periods", "with discounts"])}`
    builder.step({ calls: [shell(command, pools.testLog(module, rng.int(14, 26), failing), 1)] })
    const file = `src/${module}/${rng.pick(FILES)}`
    const line = rng.int(20, 180)
    builder.step({ calls: [read(file, pools.code(rng.int(40, 70)), Math.max(1, line - 20))] })
    builder.step({ calls: [edit(file, `  return ${rng.pick(NOUNS).toLowerCase()}`, `  return Math.round(${rng.pick(NOUNS).toLowerCase()})`, line)] })
    builder.step({ calls: [shell(command, pools.testLog(module, rng.int(14, 26), null))] })
    builder.step({ text: `Fixed: ${failing} failed because ${pools.sentence()} The ${module} tests pass now.` })
    return
  }
  if (kind === 2) {
    builder.user(`Add a short doc comment to the exported functions in src/${module}/${rng.pick(FILES)}. ${pools.sentence()}`)
    const file = `src/${module}/${rng.pick(FILES)}`
    builder.step({ calls: [read(file, pools.code(rng.int(50, 90)))] })
    builder.step({ calls: Array.from({ length: rng.int(2, 3) }, () => edit(file, `export function ${rng.pick(VERBS)}${rng.pick(NOUNS)}(`, `/** ${pools.sentence()} */\nexport function ${rng.pick(VERBS)}${rng.pick(NOUNS)}(`, rng.int(5, 90))) })
    builder.step({ calls: [shell("bun run typecheck", "$ tsc --noEmit -p tsconfig.json")] })
    builder.step({ text: `Done. ${pools.sentence()}` })
    return
  }
  builder.user(`Why does the ${module} report sometimes show yesterday's numbers? ${pools.sentence()}`)
  builder.step({ calls: [grep(`${module}Cache`, pools.matches(rng.int(4, 9)))] })
  builder.step({ calls: [read(`src/${module}/${rng.pick(FILES)}`, pools.code(rng.int(70, 120)))] })
  builder.step({ calls: [shell(`bun run scripts/report.ts --module ${module} --dry-run`, pools.reportLog(rng.int(12, 24)))] })
  builder.step({ text: `${pools.prose(rng.int(3, 6))} I did not change anything yet; say if you want the cache key to include the period.` })
}

// ---- pools of fact values and filler text ----

interface Instance {
  readonly type: FactType
  readonly fact: { readonly question: string; readonly gold: string; readonly rule: GradingRule }
  /** Writes the fact's messages; returns the `seq` of the planting message. */
  plant(builder: SessionBuilder, part: "original" | "main"): number
}

class Pools {
  private readonly used = new Map<FactType, number>()
  private readonly order: Record<FactType, number[]>

  constructor(private readonly rng: Random) {
    this.order = Object.fromEntries(FACT_TYPES.map((type) => [type, rng.shuffle([0, 1, 2, 3, 4])])) as Record<FactType, number[]>
  }

  instance(type: FactType): Instance {
    const count = this.used.get(type) ?? 0
    this.used.set(type, count + 1)
    const choice = this.order[type][count % 5]!
    return FACT_BUILDERS[type](choice, this.rng, this)
  }

  sentence(): string {
    const words = Array.from({ length: this.rng.int(8, 16) }, () => this.rng.pick(WORDS))
    return `${words[0]!.charAt(0).toUpperCase()}${words.slice(1).reduce((text, word) => `${text} ${word}`, words[0]!.slice(1))}.`
  }

  prose(sentences: number): string {
    return Array.from({ length: sentences }, () => this.sentence()).join(" ")
  }

  code(lines: number): string[] {
    const out: string[] = [`import { Money } from "../money.ts"`, `import type { ${this.rng.pick(NOUNS)} } from "./schema.ts"`, ""]
    while (out.length < lines) {
      const name = `${this.rng.pick(VERBS)}${this.rng.pick(NOUNS)}`
      out.push(`/** ${this.sentence()} */`)
      out.push(`export function ${name}(input: ${this.rng.pick(NOUNS)}, options: { readonly ${this.rng.pick(WORDS)}: boolean } = { ${this.rng.pick(WORDS)}: false }) {`)
      for (let index = 0; index < this.rng.int(3, 8); index += 1)
        out.push(
          this.rng.pick([
            `  const ${this.rng.pick(WORDS)}${this.rng.pick(NOUNS)} = input.${this.rng.pick(WORDS)}${this.rng.pick(NOUNS)} ?? 0`,
            `  if (options.${this.rng.pick(WORDS)}) return Money.zero("${this.rng.pick(["EUR", "USD", "GBP"])}")`,
            `  for (const line of input.lines) total += line.priceCents * line.quantity`,
            `  // ${this.sentence()}`,
            `  await this.repository.${this.rng.pick(VERBS)}${this.rng.pick(NOUNS)}(input.id)`,
          ]),
        )
      out.push(`  return ${this.rng.pick(WORDS)}${this.rng.pick(NOUNS)}`, "}", "")
    }
    return out.slice(0, lines)
  }

  matches(count: number): string[] {
    return Array.from({ length: count }, () => `src/${this.rng.pick(MODULES)}/${this.rng.pick(FILES)}:${this.rng.int(3, 240)}:  ${this.rng.pick(VERBS)}${this.rng.pick(NOUNS)}(${this.rng.pick(WORDS)})`)
  }

  testLog(module: string, tests: number, failing: string | null): string {
    const lines = ["bun test v1.4.0", "", `test/${module}/${this.rng.pick(FILES).replace(".ts", ".test.ts")}:`]
    for (let index = 0; index < tests; index += 1)
      lines.push(`(pass) ${module} > ${this.rng.pick(VERBS)}s ${this.rng.pick(NOUNS).toLowerCase()} ${this.rng.pick(WORDS)} ${this.rng.pick(WORDS)} [${this.rng.int(1, 90) / 10}ms]`)
    if (failing !== null)
      lines.push(
        `(fail) ${failing} [${this.rng.int(1, 40) / 10}ms]`,
        "error: expect(received).toBe(expected)",
        "",
        `Expected: ${this.rng.int(100, 9_999)}`,
        `Received: ${this.rng.int(100, 9_999)}`,
      )
    lines.push("", ` ${tests} pass`, ` ${failing === null ? 0 : 1} fail`, ` ${tests * 3} expect() calls`, `Ran ${tests + (failing === null ? 0 : 1)} tests across 1 file. [${this.rng.int(80, 400)}.00ms]`)
    return lines.join("\n")
  }

  reportLog(lines: number): string {
    return Array.from({ length: lines }, (_, index) => `[report] ${String(index).padStart(2, "0")} ${this.rng.pick(MODULES)} period=2026-${String(this.rng.int(1, 10)).padStart(2, "0")} rows=${this.rng.int(10, 9_000)} cached=${this.rng.pick(["yes", "no"])}`).join("\n")
  }
}

type Builder = (choice: number, rng: Random, pools: Pools) => Instance

const DECISIONS = [
  { area: "rate limiter store", chosen: "an in-process token bucket", key: "token bucket", other: "Redis", reason: "the service runs as a single instance and the tests must not need a network" },
  { area: "invoice PDF rendering", chosen: "a queued background job", key: "background job", other: "rendering inside the HTTP request", reason: "rendering takes up to 9 seconds and the load balancer cuts requests at 5" },
  { area: "customer ID format", chosen: "ULIDs", key: "ULID", other: "UUIDv4", reason: "they sort by creation time, which the nightly export relies on" },
  { area: "config validation", chosen: "a hand-written validator", key: "hand-written", other: "a schema library", reason: "the project forbids new runtime dependencies" },
  { area: "audit log storage", chosen: "an append-only SQLite table", key: "append-only", other: "one JSON file per day", reason: "auditors need to query by customer across months" },
]

const BUGS = [
  { bug: "currency rounding bug in tax totals", path: "src/taxes/rounding/half-even.ts", detail: "the half-cent case rounds away from zero" },
  { bug: "duplicate webhook delivery", path: "src/webhooks/dispatch/retry-queue.ts", detail: "the retry is enqueued before the first attempt is marked done" },
  { bug: "off-by-one in the pagination cursor", path: "src/reports/paging/cursor-codec.ts", detail: "the cursor encodes the last row instead of the next one" },
  { bug: "timezone shift on invoice dates", path: "src/invoices/dates/issue-date.ts", detail: "the date is formatted in UTC instead of the account's zone" },
  { bug: "negative refund totals", path: "src/refunds/calc/partial-refund.ts", detail: "the discount is subtracted twice for partial refunds" },
]

const COMMANDS = [
  { subject: "database migration check", command: "bun run scripts/check-migrations.ts --env staging --strict", says: "migration 0042 has no down step" },
  { subject: "end-to-end smoke test of the checkout", command: "bun run e2e/smoke.ts --suite checkout --headless", says: "step 7 of 12 timed out waiting for the receipt" },
  { subject: "dependency audit", command: "bun run scripts/audit-licenses.ts --deny GPL-3.0", says: "2 packages have a denied license" },
  { subject: "load test of the exports endpoint", command: "bun run bench/exports.ts --rps 40 --duration 30s", says: "p99 latency 2.4 s is above the 1.5 s budget" },
  { subject: "schema drift check", command: "bun run scripts/schema-drift.ts --against prod-snapshot.sql", says: "column invoices.memo differs in length" },
]

const ERRORS = [
  { subject: "CSV importer", error: "TypeError: Cannot read properties of undefined (reading 'currencyCode')", core: "Cannot read properties of undefined (reading 'currencyCode')" },
  { subject: "nightly FX rate sync", error: "Error: ENOENT: no such file or directory, open '/var/lib/ledgerline/fx/rates-2026-03.json'", core: "/var/lib/ledgerline/fx/rates-2026-03.json" },
  { subject: "invoice email job", error: "RangeError: Invalid time value at formatDueDate (src/mailer/templates/due-date.ts:31:18)", core: "Invalid time value at formatDueDate" },
  { subject: "plan upgrade endpoint", error: "LedgerConflictError: entry 88213 already settled in period 2026-09", core: "entry 88213 already settled in period 2026-09" },
  { subject: "usage meter aggregation", error: "SqliteError: UNIQUE constraint failed: usage_buckets.account_id, usage_buckets.hour", core: "UNIQUE constraint failed: usage_buckets.account_id, usage_buckets.hour" },
]

const PRESERVED = [
  { label: "label for the staging webhook endpoint", make: (rng: Random) => `whk-stg-${rng.hex(6)}-blue` },
  { label: "release tag the customer asked us to reference", make: (rng: Random) => `v4.${rng.int(10, 40)}.${rng.int(0, 9)}-hotfix.${rng.int(2, 9)}` },
  { label: "ticket reference for the auditor", make: (rng: Random) => `AUD-${rng.int(1000, 9999)}-${rng.hex(3).toUpperCase()}` },
  { label: "name of the test account to use", make: (rng: Random) => `qa+ledger-${rng.hex(4)}@example.test` },
  { label: "cron expression for the reminder job", make: (rng: Random) => `${rng.int(5, 55)} ${rng.int(1, 5)} * * 1-5` },
]

const CORRECTIONS = [
  { setting: "port", thing: "the mock payment server", original: "8081", corrected: "9417" },
  { setting: "retry limit", thing: "the mailer", original: "5 retries", corrected: "3 retries", number: [5, 3] },
  { setting: "default currency", thing: "new test accounts", original: "EUR", corrected: "CHF" },
  { setting: "timeout", thing: "the export job", original: "30 seconds", corrected: "120 seconds", number: [30, 120] },
  { setting: "base branch", thing: "this work", original: "release-2.4", corrected: "release-2.6" },
]

const DISTRACTORS = [
  {
    question: "Which database migration failed when the migrations were applied to staging?",
    gold: (rng: Random) => `2026${rng.int(1000, 1130)}_add_invoice_index`,
    decoy: (value: string) => value.replace("_index", "_idx"),
    plant: (value: string, decoy: string) =>
      shell("bun run db:migrate --env staging", `applying ${decoy} ... ok (38 ms)\napplying ${value} ... FAILED\n  duplicate column name: issued_at\nrolled back ${value}`, 1),
    explain: (value: string, decoy: string) => `The ${decoy} migration applied; ${value} failed and was rolled back.`,
  },
  {
    question: "Which feature flag was switched off in production after the incident?",
    gold: () => "billing.newTaxEngineV2",
    decoy: () => "billing.newTaxEngine",
    plant: (value: string, decoy: string) =>
      shell("bun run flags:list --env prod", `flag                      state   changed\n${decoy.padEnd(25)} on      2026-08-02\n${value.padEnd(25)} off     2026-11-09 (incident INC-311)`),
    explain: (value: string, decoy: string) => `${decoy} is still on; ${value} is the one that was switched off after the incident.`,
  },
  {
    question: "Which environment variable was missing on the worker host?",
    gold: () => "LEDGER_EXPORT_BUCKET_URL",
    decoy: () => "LEDGER_EXPORT_BUCKET",
    plant: (value: string, decoy: string) =>
      shell("ssh worker-3 'env | grep LEDGER_EXPORT; bun run scripts/check-env.ts'", `${decoy}=exports-prod\nmissing required variable: ${value}`, 2),
    explain: (value: string, decoy: string) => `The worker has ${decoy} but not ${value}, which the exporter needs.`,
  },
  {
    question: "Which customer account had the double charge that we refunded?",
    gold: (rng: Random) => `acct_${rng.int(10, 99)}7731`,
    decoy: (value: string) => `${value.slice(0, -1)}2`,
    plant: (value: string, decoy: string) =>
      shell("bun run scripts/find-double-charges.ts --since 2026-10-01", `${decoy}  2 charges  distinct invoices (ok)\n${value}  2 charges  same invoice INV-5521 (double charge)`),
    explain: (value: string, decoy: string) => `${decoy} has two separate invoices, which is fine; ${value} was charged twice for INV-5521, so I refunded one.`,
  },
  {
    question: "Which build cache directory turned out to be stale and was deleted?",
    gold: () => ".cache/tsbuild-ledger-v3",
    decoy: () => ".cache/tsbuild-ledger-v2",
    plant: (value: string, decoy: string) =>
      shell("ls -la .cache && bun run scripts/cache-age.ts", `${decoy}  updated 2026-11-11  valid\n${value}  updated 2026-06-30  STALE (hash mismatch)`),
    explain: (value: string, decoy: string) => `${value} was stale, so I deleted it; ${decoy} is current and stays.`,
  },
]

const FACT_BUILDERS: Record<FactType, Builder> = {
  decision: (choice, rng, pools) => {
    const decision = DECISIONS[choice]!
    return {
      type: "decision",
      fact: {
        question: `Which approach did we choose for the ${decision.area}, and why?`,
        gold: `${decision.chosen} rather than ${decision.other}, because ${decision.reason}.`,
        rule: {
          kind: "judge",
          mustContain: [decision.key],
          rubric: `The answer says ${decision.chosen} was chosen (not ${decision.other}) and gives the reason: ${decision.reason}.`,
        },
      },
      plant: (builder) => {
        builder.user(`For the ${decision.area}, should we use ${decision.chosen.replace(/^(an?|the) /, "")} or ${decision.other}? Pick one and tell me why.`)
        builder.step({ calls: [grep(decision.area.split(" ")[0]!, pools.matches(rng.int(3, 6)))] })
        return builder.step({ text: `I'll go with ${decision.chosen} rather than ${decision.other}: ${decision.reason}. ${pools.sentence()}` })
      },
    }
  },
  path_line: (choice, rng, pools) => {
    const bug = BUGS[choice]!
    const line = rng.int(41, 299)
    return {
      type: "path_line",
      fact: {
        question: `In which file and at which line did we find the cause of the ${bug.bug}?`,
        gold: `${bug.path}:${line}`,
        rule: { kind: "contains", all: [bug.path, { number: line }] },
      },
      plant: (builder) => {
        builder.user(`Please track down the ${bug.bug}. ${pools.sentence()}`)
        builder.step({ calls: [grep(bug.path.split("/").pop()!.replace(".ts", ""), [...pools.matches(rng.int(3, 5)), `${bug.path}:${line}:  // ${bug.detail}`])] })
        builder.step({ calls: [read(bug.path, pools.code(30), line - 12)] })
        return builder.step({ text: `Found it: ${bug.path} line ${line}, where ${bug.detail}. ${pools.sentence()}` })
      },
    }
  },
  command_exit: (choice, rng, pools) => {
    const command = COMMANDS[choice]!
    const exit = rng.int(2, 7)
    return {
      type: "command_exit",
      fact: {
        question: `What exact command did we run for the ${command.subject}, and what exit code did it return?`,
        gold: `\`${command.command}\`, exit code ${exit}`,
        rule: { kind: "contains", all: [command.command, { number: exit }] },
      },
      plant: (builder) => {
        builder.user(`Run the ${command.subject} before we go further.`)
        const seq = builder.step({ calls: [shell(command.command, `${pools.reportLog(rng.int(6, 12))}\nFAILED: ${command.says}`, exit)] })
        builder.step({ text: `The ${command.subject} did not pass: ${command.says}. I'll leave it for now as you asked.` })
        return seq
      },
    }
  },
  error_message: (choice, rng, pools) => {
    const error = ERRORS[choice]!
    return {
      type: "error_message",
      fact: {
        question: `What was the exact error message when the ${error.subject} first failed?`,
        gold: error.error,
        rule: { kind: "contains", all: [error.core] },
      },
      plant: (builder) => {
        builder.user(`The ${error.subject} failed overnight. Can you check the log?`)
        const log = [...pools.reportLog(rng.int(10, 18)).split("\n"), error.error, `    at ${rng.pick(VERBS)}${rng.pick(NOUNS)} (src/${rng.pick(MODULES)}/${rng.pick(FILES)}:${rng.int(10, 200)}:${rng.int(3, 30)})`, ...pools.reportLog(4).split("\n")]
        const seq = builder.step({ calls: [shell(`tail -n 40 /var/log/ledgerline/${error.subject.replace(/ /g, "-").toLowerCase()}.log`, log.join("\n"))] })
        builder.step({ text: `It crashed with an error part-way through the run. ${pools.sentence()} I'll look at the cause next.` })
        return seq
      },
    }
  },
  preserved_value: (choice, rng, pools) => {
    const preserved = PRESERVED[choice]!
    const value = preserved.make(rng)
    return {
      type: "preserved_value",
      fact: {
        question: `What exact ${preserved.label} did I ask you to keep?`,
        gold: value,
        rule: { kind: "contains", all: [value] },
      },
      plant: (builder) => {
        const seq = builder.user(`Keep this exactly as written, I will need it at the end: the ${preserved.label} is ${value}. ${pools.sentence()}`)
        builder.step({ text: "Noted, I will keep it as written." })
        return seq
      },
    }
  },
  correction: (choice) => {
    const correction = CORRECTIONS[choice]!
    const needle = (value: string, index: number): Needle => (correction.number === undefined ? value : { number: correction.number[index]! })
    return {
      type: "correction",
      fact: {
        question: `What ${correction.setting} should be used for ${correction.thing}, according to my latest instruction?`,
        gold: correction.corrected,
        rule: { kind: "contains", all: [needle(correction.corrected, 1)] },
      },
      plant: (builder, part) => {
        if (part === "original") {
          const seq = builder.user(`For ${correction.thing}, use ${correction.original} as the ${correction.setting}.`)
          builder.step({ text: `OK: ${correction.original} for ${correction.thing}.` })
          return seq
        }
        const seq = builder.user(`Correction to what I said earlier: the ${correction.setting} for ${correction.thing} should be ${correction.corrected}, not ${correction.original}.`)
        builder.step({ text: `Understood, ${correction.corrected} from now on.` })
        return seq
      },
    }
  },
  distractor: (choice, rng) => {
    const distractor = DISTRACTORS[choice]!
    const value = distractor.gold(rng)
    const decoy = distractor.decoy(value)
    return {
      type: "distractor",
      fact: {
        question: distractor.question,
        gold: value,
        rule: {
          kind: "contains",
          all: [value],
          ambiguousIf: [decoy],
          rubric: `The answer identifies ${value} as the one asked about. It may mention ${decoy} only as the other one, the one that does not fit the question.`,
        },
      },
      plant: (builder) => {
        builder.user(distractor.question.replace(/^Which/, "Find out which").replace(/\?$/, "."))
        const seq = builder.step({ calls: [distractor.plant(value, decoy) satisfies Call] })
        builder.step({ text: distractor.explain(value, decoy) })
        return seq
      },
    }
  },
}
