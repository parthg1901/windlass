/**
 * Review finding (measured): a watch's regular expression is matched with no time bound of the engine's own,
 * on the engine's only thread. One short line of a command's output can hold the whole process for about a
 * second, and every further such line for another.
 *
 * What is promised.
 * - docs/architecture.md, "Watches on a command's output": "Nothing is polled, and nothing is kept for a
 *   command nobody watches." and, on refusals, that a pattern that "is not a regular expression" is refused.
 *   Nothing there bounds the time of a match; `watchMatcher`'s own comment says the expression "is tried on a
 *   line of bounded length" (16 KiB), which bounds the input, not the work.
 * - The pattern comes from a client (`session.watchOutput`, which the ACP server exposes), the line from
 *   whatever the command prints.
 *
 * What happens, measured here with Bun 1.4 on the review machine: `(a+)+$` (and ordinary-looking patterns of
 * the same shape, such as `(\w+\s?)+:` or `^(\S+ ?)+error$`) against a line of 30 characters that almost
 * matches takes 0.9 to 1.1 s. The time doubles per character up to about 26 characters and then stays there:
 * the JavaScript engine gives up on a match after a fixed amount of backtracking, so one match is bounded by
 * the runtime at about a second, not by the harness. `follow((line) => { ... matcher.matches(line) ... })` in
 * `watchOutput` runs synchronously for every line: a command that prints 600 such lines (a server's access log)
 * holds the process for about ten minutes. While it does, nothing else runs: no interrupt is taken, no other
 * session of the process advances, the client gets no answer. The match that gave up counts as "no match", so
 * the watch also silently misses lines it should have fired on.
 *
 * Code path. packages/core/src/engine/spawn.ts, `watchMatcher` (`expression.test(line)`); called from the
 * listener `LiveSession.watchOutput` registers in packages/core/src/engine/engine.ts.
 *
 * Smallest fix. Measure each match in the listener and end the watch when one takes longer than a small budget
 * (say 50 ms): `watch.ended` gets a reason for it and the user is told that the pattern is too slow for this
 * output. That turns "a second per line for as long as the command prints" into one slow match. A stricter fix
 * (matching off the main thread, or refusing nested quantifiers when the watch is set) costs more.
 *
 * What that fix could affect. `watch.ended` gains a reason, so the reducer, the scenarios and the clients that
 * print a watch's end change with it. A pattern that is slow on one unusual line and fine otherwise would lose
 * its watch.
 */
import { expect, test } from "bun:test"
import { watchMatcher } from "../../src/engine/spawn.ts"
import { WATCH_LIMITS } from "../../src/event/durable.ts"

test.failing(
  "matching one short line of output against a user's regular expression should not hold the engine for anything like a second",
  () => {
    const pattern = "(a+)+$"
    expect(pattern.length).toBeLessThanOrEqual(WATCH_LIMITS.patternChars)
    const matcher = watchMatcher({ pattern, regex: true, ignoreCase: false })
    if ("problem" in matcher) throw new Error(matcher.problem)
    // Thirty characters: far below the 16 KiB of a line that is looked at.
    const line = `${"a".repeat(29)}!`
    const started = performance.now()
    const matched = matcher.matches(line)
    const elapsed = performance.now() - started
    expect(matched).toBe(false)
    // Generous for a line of thirty characters; today it takes about a second.
    expect(elapsed).toBeLessThan(100)
  },
  60_000,
)
