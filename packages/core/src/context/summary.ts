/**
 * The summary request and the check of its answer.
 *
 * The request is the normal step request of the part being summarised plus
 * one appended `developer` message, `summaryPrompt(...)`, so it reads that
 * part from the provider's prompt cache (`buildCompactionRequest`). The answer
 * must have the sections of `SUMMARY_SECTIONS`, in order, each with a body,
 * and fit `maxTokens`. `validateSummary` checks that; when it fails, the
 * engine may ask once more by appending the failed answer as assistant text
 * and `summaryRepairPrompt(problems)` as another `developer` message (the
 * prefix still extends, so the retry is cached too).
 *
 * A model does not always stop where it should. The first live run of the
 * recall evaluation got summaries that repeated every section several times,
 * and one that was still writing after fifteen minutes. So the answer is
 * bounded twice: `summaryOutputCapChars` is where the engine stops reading a
 * runaway stream (this provider rejects `max_output_tokens`), and
 * `resolveSummary` first tries the answer as it is and then with everything
 * from the first repeated heading on removed (`salvageSummary`). What is
 * still unusable after the one repair is not used at all: the engine builds
 * the checkpoint without a summary (`buildCheckpoint` with `summary: null`).
 *
 * The summary is only the part of the checkpoint that needs a model. Exact
 * identifiers and the user's own words are added mechanically by
 * `buildCheckpoint`, and the prompt says so, so the model spends its words on
 * meaning, reasons and state.
 */
import { estimateTokens } from "./estimate.ts"

/** The required sections: heading text and what the model is asked to put under it. */
export const SUMMARY_SECTIONS = [
  { heading: "Goal", ask: "what the user wants overall, in one or two sentences." },
  {
    heading: "Instructions and constraints",
    ask: "every instruction, preference and constraint from the user that is still in force. When the user changed an instruction, give only the latest version and say that it replaced an earlier one.",
  },
  { heading: "Decisions", ask: "each decision that was made, and why." },
  { heading: "Work completed", ask: "what is done, and how it was checked." },
  {
    heading: "In progress",
    ask: 'what was being done when this summary was taken. End with one line that starts with "Next step:" and names the exact next action (or says that the next step is to wait for the user).',
  },
  { heading: "Files", ask: "each file read, created or changed, by its exact path, with what was done to it." },
  { heading: "Commands", ask: "the commands that matter, exactly as run, each with its outcome (exit code, what passed or failed)." },
  { heading: "Open questions", ask: "what is unresolved or waiting for the user." },
  { heading: "Verbatim", ask: "anything the user asked to keep exactly, quoted exactly." },
] as const

export const NEXT_STEP_MARKER = "Next step:"

/** The appended prompt. `maxWords` is a soft bound the model can follow; `validateSummary` checks tokens. */
export function summaryPrompt(maxWords = 1_200): string {
  return [
    "Pause the task here. Do not continue it and do not reply to the user: this message is from the harness, and tools are switched off for this one reply on purpose. The conversation above is about to be replaced by a checkpoint, because it is getting too long for the context window. Write the summary part of that checkpoint now, as your whole reply. Do not call tools.",
    "Whoever continues sees only the checkpoint and the most recent messages. Next to your summary the harness adds, by itself, an index of exact file paths, commands, error messages, commit hashes and test names taken from the conversation, the user's own messages quoted verbatim, and tools to search and read the full earlier conversation. So write what those cannot give: what things mean, why they were done, and where the work stands.",
    "Use exactly these headings, in this order, each followed by short bullet points. Under a heading with nothing to report, write `- None.`",
    ...SUMMARY_SECTIONS.map((section) => `## ${section.heading}: ${section.ask}`),
    "Copy identifiers (paths, line numbers, commands, error text, names, values) character for character; never paraphrase them. When a later message corrected an earlier one, the later one wins.",
    `At most ${maxWords} words. No preamble, and do not address the user.`,
  ].join("\n")
}

export type SummaryProblem =
  | { readonly kind: "missing_section"; readonly heading: string }
  | { readonly kind: "duplicate_section"; readonly heading: string }
  | { readonly kind: "out_of_order"; readonly heading: string }
  | { readonly kind: "empty_section"; readonly heading: string }
  | { readonly kind: "no_next_step" }
  | { readonly kind: "too_long"; readonly tokens: number; readonly maxTokens: number }

export type SummaryCheck =
  | { readonly ok: true; readonly tokens: number }
  | { readonly ok: false; readonly tokens: number; readonly problems: readonly SummaryProblem[] }

/**
 * Checks a returned summary. A heading is a line `## <name>` (case and a
 * trailing colon or explanation after the name are tolerated); text before the
 * first heading is ignored.
 */
export function validateSummary(summary: string, maxTokens: number): SummaryCheck {
  const tokens = estimateTokens(summary)
  const sections = parseSections(summary)
  const problems: SummaryProblem[] = []
  let position = -1
  for (const section of SUMMARY_SECTIONS) {
    const found = sections.filter((candidate) => candidate.name === section.heading.toLowerCase())
    if (found.length === 0) {
      problems.push({ kind: "missing_section", heading: section.heading })
      continue
    }
    if (found.length > 1) problems.push({ kind: "duplicate_section", heading: section.heading })
    const at = sections.indexOf(found[0]!)
    if (at < position) problems.push({ kind: "out_of_order", heading: section.heading })
    position = Math.max(position, at)
    if (found[0]!.body.trim() === "") problems.push({ kind: "empty_section", heading: section.heading })
  }
  const progress = sections.find((section) => section.name === "in progress")
  if (progress !== undefined && !progress.body.includes(NEXT_STEP_MARKER)) problems.push({ kind: "no_next_step" })
  if (tokens > maxTokens) problems.push({ kind: "too_long", tokens, maxTokens })
  return problems.length === 0 ? { ok: true, tokens } : { ok: false, tokens, problems }
}

/** Where the engine stops reading a summary that does not end: twice the token limit, in characters. */
export function summaryOutputCapChars(maxTokens: number): number {
  return maxTokens * 8
}

/**
 * Cuts a summary at the first heading that names a section already seen, and
 * drops a last line that was cut in the middle. A summary the model repeated
 * (or that the engine stopped while it was being repeated) is its first copy.
 */
export function salvageSummary(summary: string, complete = true): string {
  const seen = new Set<string>()
  const kept: string[] = []
  const lines = summary.split("\n")
  // A stream that was cut ends in the middle of a line, which is dropped unless it is all there is.
  if (!complete && lines.length > 1) lines.pop()
  for (const line of lines) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line)
    if (heading !== null) {
      const name = sectionName(heading[1]!)
      if (seen.has(name)) break
      seen.add(name)
    }
    kept.push(line)
  }
  return kept.join("\n").trim()
}

/** Problems that leave a summary usable: it has every section once, in order. */
const SOFT: readonly SummaryProblem["kind"][] = ["too_long", "no_next_step", "empty_section"]

export type ResolvedSummary =
  /** `text` is the summary to use: the answer, or its first copy when the model repeated itself. */
  | { readonly ok: true; readonly text: string; readonly tokens: number; readonly salvaged: boolean }
  /**
   * Not valid. `text` is the better of the answer and its salvaged form;
   * `usable` says that only soft problems are left (too long but within
   * `hardMaxTokens`, no "Next step:" line, an empty section), so it may be
   * used when a repair does no better.
   */
  | { readonly ok: false; readonly text: string; readonly tokens: number; readonly problems: readonly SummaryProblem[]; readonly usable: boolean }

/**
 * Decides what an answer to the summary request is worth. `complete` is
 * `false` when the engine stopped the stream (the output cap or the time
 * limit), so the text ends wherever it was cut.
 */
export function resolveSummary(answer: string, maxTokens: number, options: { readonly complete?: boolean; readonly hardMaxTokens?: number } = {}): ResolvedSummary {
  const complete = options.complete ?? true
  const hardMaxTokens = options.hardMaxTokens ?? maxTokens * 2
  const whole = answer.trim()
  const direct = complete ? validateSummary(whole, maxTokens) : null
  if (direct?.ok) return { ok: true, text: whole, tokens: direct.tokens, salvaged: false }
  const salvaged = salvageSummary(answer, complete)
  const second = validateSummary(salvaged, maxTokens)
  if (second.ok) return { ok: true, text: salvaged, tokens: second.tokens, salvaged: salvaged !== whole }
  // The salvaged form is never worse: it only removes repeats and a cut last line.
  const usable = second.problems.every((problem) => SOFT.includes(problem.kind)) && second.tokens <= hardMaxTokens && salvaged !== ""
  return { ok: false, text: salvaged, tokens: second.tokens, problems: second.problems, usable }
}

/** The one follow-up prompt that asks for a fixed summary. */
export function summaryRepairPrompt(problems: readonly SummaryProblem[]): string {
  return [
    "That summary does not have the required form:",
    ...problems.map((problem) => `- ${describeProblem(problem)}`),
    "Write the whole summary again with these fixed, using the same headings in the same order. Do not call tools.",
  ].join("\n")
}

export function describeProblem(problem: SummaryProblem): string {
  switch (problem.kind) {
    case "missing_section":
      return `the section "## ${problem.heading}" is missing`
    case "duplicate_section":
      return `the section "## ${problem.heading}" appears more than once`
    case "out_of_order":
      return `the section "## ${problem.heading}" is out of order`
    case "empty_section":
      return `the section "## ${problem.heading}" is empty (write "- None." when there is nothing to say)`
    case "no_next_step":
      return `the section "## In progress" has no line starting with "${NEXT_STEP_MARKER}"`
    case "too_long":
      return `it is about ${problem.tokens} tokens long; the limit is ${problem.maxTokens}, so shorten it`
  }
}

function parseSections(summary: string) {
  const sections: { name: string; body: string }[] = []
  for (const line of summary.split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line)
    if (heading !== null) {
      sections.push({ name: sectionName(heading[1]!), body: "" })
      continue
    }
    const current = sections[sections.length - 1]
    if (current !== undefined) current.body += `${line}\n`
  }
  return sections
}

/** `Goal`, `goal:`, `Goal: what the user wants` and `**Goal**` all name the section `goal`. */
function sectionName(heading: string) {
  const plain = heading.replace(/\*+/g, "").trim().toLowerCase()
  const known = SUMMARY_SECTIONS.map((section) => section.heading.toLowerCase()).find(
    (name) => plain === name || plain.startsWith(`${name}:`) || plain.startsWith(`${name} -`) || plain.startsWith(`${name} —`),
  )
  return known ?? plain
}
