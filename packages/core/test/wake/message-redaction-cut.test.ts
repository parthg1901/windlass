/**
 * A webhook's body is redacted before it is cut to the length a firing shows.
 *
 * docs/safety.md, "Secrets in tool output": a credential value never reaches the model in clear. A body longer
 * than the shown length is cut (`webhookSection` in `src/wake/message.ts`); cut first and redacted after, a value
 * that lies across the cut would be shown in part, since half of it is no longer the value. So the whole body is
 * redacted first and the cut is made in the redacted text, on a character boundary and never inside a placeholder
 * (`markerAround` and `isContinuation` of `src/tool/cap.ts`, as for a check's output in `src/wake/check.ts`).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { firingText } from "../../src/wake/message.ts"
import { T0, cleanup, manualClock, store } from "./helpers.ts"

afterAll(cleanup)

const VALUE = "EXAMPLE_VALUE_0123456789abcdef"
const encoder = new TextEncoder()

function webhookWake() {
  const created = store(manualClock()).create({ sessionId: "ses_1", message: "A deploy finished.", trigger: { kind: "webhook", includeBody: true }, author: "user" })
  if (!created.ok) throw new Error(created.error)
  return created.wake
}

/** The firing's text for `body`, and what it shows between the fence's markers. */
function shownOf(body: string, shownBodyBytes: number) {
  const text = firingText({ wake: webhookWake(), n: 1, source: "webhook", dueAt: T0, now: T0, webhook: { body: encoder.encode(body), receivedAt: T0, contentType: "text/plain", event: null }, shownBodyBytes, secrets: [VALUE] })
  const lines = text.split("\n")
  const open = lines.findIndex((line) => line.startsWith("<<<untrusted webhook-body "))
  const close = lines.findIndex((line) => line.startsWith("untrusted webhook-body "))
  return { text, shown: lines.slice(open + 1, close).join("\n") }
}

describe("a webhook body longer than what a firing shows", () => {
  test("a value that lies across the cut is replaced whole: no part of it is shown", () => {
    // The value starts ten bytes before the cut and ends twenty bytes after it.
    const body = `${"a".repeat(90)}${VALUE}${"b".repeat(200)}`
    const { text, shown } = shownOf(body, 100)
    for (let length = 4; length <= VALUE.length; length += 1) expect(text).not.toContain(VALUE.slice(0, length))
    expect(shown.startsWith("a".repeat(90))).toBe(true)
    expect(text).toContain("Only its first 100 bytes are shown.")
  })

  test("the cut never falls inside a placeholder: it is shown whole or not at all", () => {
    for (let before = 60; before <= 100; before += 1) {
      const { shown } = shownOf(`${"a".repeat(before)}${VALUE}${"b".repeat(200)}`, 100)
      const rest = shown.slice(before)
      // What follows the leading text is nothing, or a whole placeholder and then the rest of the body.
      expect(rest === "" || /^\[REDACTED:[a-z_-]+\]b*$/.test(rest)).toBe(true)
      expect(encoder.encode(shown).length).toBeLessThanOrEqual(100)
    }
  })

  test("the cut falls on a character boundary", () => {
    const { shown } = shownOf(`${"a".repeat(99)}é${"b".repeat(50)}`, 100)
    expect(shown).toBe("a".repeat(99))
    expect(shown).not.toContain("�")
  })

  test("a body that fits is shown whole, with its values replaced, and is not said to be cut", () => {
    const { text, shown } = shownOf(`token=${VALUE} done`, 100)
    expect(shown).toMatch(/^token=\[REDACTED:[a-z_-]+\] done$/)
    expect(text).not.toContain("are shown")
    // Redaction can make a body that was too long fit: then nothing is left out, and nothing says so.
    const long = shownOf(`${VALUE} ${VALUE} ${VALUE} ${VALUE}`, 100)
    expect(long.shown).not.toContain("EXAMPLE")
    expect(encoder.encode(long.shown).length).toBeLessThanOrEqual(100)
  })
})
