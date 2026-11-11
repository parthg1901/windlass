/**
 * The text the model is shown for a set of check results. Pure and
 * deterministic: it depends only on the results' names, commands, statuses and
 * output bytes (never the duration). Passing and interrupted checks come first,
 * one line each, then the failures; each group keeps the order given.
 *
 * The whole report fits the tool output limits, so nothing downstream caps it
 * again. Failing checks share the room left after the fixed lines equally; each
 * output is capped by the same rule as tool output (line boundaries, a marker
 * naming the full output file), with four fifths of its room given to the end
 * of the output, where failures usually are.
 */
import { ACKNOWLEDGE_TOOL_NAME } from "./acknowledge.ts"
import { type CheckOutput, type CheckResult, isFailure } from "./run.ts"
import { OUTPUT_LIMITS, type OutputLimits, countLines, fitsLimits, renderCapped } from "../tool/cap.ts"

/** The part of a result the report reads. */
export type ReportedCheck = Pick<CheckResult, "name" | "command" | "timeoutSeconds" | "status" | "exitCode" | "signal" | "interruptedBy" | "startError" | "output">

/** Kept below the limits for the marker; the same values as the tool output cap. */
const MARKER_BYTES = 512
const MARKER_LINES = 4
/** Room per failing output never goes below this, however many checks fail. */
const MIN_OUTPUT_LIMITS: OutputLimits = { maxBytes: 2048, maxLines: 40 }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function renderReport(results: readonly ReportedCheck[], limits: OutputLimits = OUTPUT_LIMITS): string {
  const failing = results.filter((result) => isFailure(result.status))
  const frame = encoder.encode(render(results, failing, () => ""))
  const room = shareRoom(
    failing.filter((result) => result.output.totalBytes > 0).map((result) => result.output),
    { maxBytes: limits.maxBytes - frame.length, maxLines: limits.maxLines - countLines(frame) },
  )
  return render(results, failing, (output) => renderOutput(output, room.get(output) ?? MIN_OUTPUT_LIMITS))
}

/**
 * Divides the room among outputs, smallest first: an output that fits its equal share of what is left is shown
 * whole and leaves the rest to the larger ones. Depends only on the sizes and the order, so it is deterministic.
 */
function shareRoom(outputs: readonly CheckOutput[], room: OutputLimits): Map<CheckOutput, OutputLimits> {
  const bySize = outputs
    .map((output, index) => ({ output, index }))
    .sort((a, b) => a.output.totalBytes - b.output.totalBytes || a.output.totalLines - b.output.totalLines || a.index - b.index)
  const shares = new Map<CheckOutput, OutputLimits>()
  let bytes = room.maxBytes
  let lines = room.maxLines
  bySize.forEach(({ output }, position) => {
    const left = bySize.length - position
    const share = {
      maxBytes: Math.max(MIN_OUTPUT_LIMITS.maxBytes, Math.floor(bytes / left)),
      maxLines: Math.max(MIN_OUTPUT_LIMITS.maxLines, Math.floor(lines / left)),
    }
    const used = fitsLimits(output.totalBytes, output.totalLines, share) ? { maxBytes: output.totalBytes, maxLines: output.totalLines } : share
    shares.set(output, share)
    bytes -= used.maxBytes
    lines -= used.maxLines
  })
  return shares
}

function render(results: readonly ReportedCheck[], failing: readonly ReportedCheck[], output: (output: CheckOutput) => string): string {
  const lines = [`Checks run by the harness after your changes: ${counts(results)}.`]
  // One-line results first, then each failure with its output, so the failures read as one block.
  for (const result of results) if (!isFailure(result.status)) lines.push(...describe(result, output))
  for (const result of failing) lines.push(...describe(result, output))
  if (failing.length > 0)
    lines.push(
      "",
      `Fix the code so that ${failing.length === 1 ? "this check passes" : "these checks pass"}, or, if you cannot, call ${ACKNOWLEDGE_TOOL_NAME} with the name of each failing check and the reason.`,
    )
  return `${lines.join("\n")}\n`
}

function describe(result: ReportedCheck, output: (output: CheckOutput) => string): string[] {
  const what = `${result.name} (${result.command})`
  switch (result.status) {
    case "passed":
      return [`passed: ${what}`]
    case "interrupted":
      return [`interrupted: ${what}, stopped ${result.interruptedBy === "shutdown" ? "because the harness is shutting down" : "by the user"}`]
    case "could_not_start":
      if (result.startError !== null) return ["", `could not start: ${what}: ${result.startError}`]
      return withOutput(`could not start: ${what}, exit code ${result.exitCode}`, result, output)
    case "timed_out":
      return withOutput(`timed out: ${what}, stopped after ${result.timeoutSeconds} ${result.timeoutSeconds === 1 ? "second" : "seconds"}`, result, output)
    case "failed":
      return withOutput(`failed: ${what}, ${result.signal !== null ? `killed by signal ${result.signal}` : `exit code ${result.exitCode}`}`, result, output)
  }
}

function withOutput(heading: string, result: ReportedCheck, output: (output: CheckOutput) => string): string[] {
  if (result.output.totalBytes === 0) return ["", `${heading}, no output.`]
  const text = output(result.output)
  return ["", `${heading}. Output:`, `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}[end of ${result.name} output]`]
}

function counts(results: readonly ReportedCheck[]) {
  const labels = [
    ["passed", "passed"],
    ["failed", "failed"],
    ["timed_out", "timed out"],
    ["could_not_start", "could not start"],
    ["interrupted", "interrupted"],
  ] as const
  const parts = labels.flatMap(([status, label]) => {
    const count = results.filter((result) => result.status === status).length
    return count === 0 ? [] : [`${count} ${label}`]
  })
  return parts.length === 0 ? "none ran" : parts.join(", ")
}

/**
 * A check's output within `limits`: whole when it fits, else a short head, the
 * standard omission marker and a long tail. `renderCapped` splits its room in
 * half, so it is given a head already cut to one fifth of the room and limits
 * whose half is the remaining four fifths.
 */
export function renderOutput(output: CheckOutput, limits: OutputLimits = OUTPUT_LIMITS): string {
  const source = output.source
  if (fitsLimits(source.totalBytes, source.totalLines, limits) && source.head.length === source.totalBytes) return decoder.decode(source.head)
  const byteRoom = Math.max(0, limits.maxBytes - MARKER_BYTES)
  const lineRoom = Math.max(0, limits.maxLines - MARKER_LINES)
  const headBytes = Math.floor(byteRoom / 5)
  const headLines = Math.floor(lineRoom / 5)
  const tailBytes = byteRoom - headBytes
  const tailLines = lineRoom - headLines
  return renderCapped(
    { ...source, head: source.head.subarray(0, cutHead(source.head, headBytes, headLines)) },
    { path: output.path, savedBytes: output.savedBytes },
    { maxBytes: 2 * tailBytes + MARKER_BYTES, maxLines: 2 * tailLines + MARKER_LINES },
  )
}

/** After the last whole line within both budgets, or on a character boundary inside an overlong first line. */
function cutHead(bytes: Uint8Array, maxBytes: number, maxLines: number): number {
  const limit = Math.min(bytes.length, maxBytes)
  let end = 0
  let lines = 0
  for (let index = bytes.indexOf(0x0a); index !== -1 && index < limit && lines < maxLines; index = bytes.indexOf(0x0a, index + 1)) {
    end = index + 1
    lines += 1
  }
  if (end > 0 || maxLines === 0) return end
  let cut = limit
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1
  return cut
}
