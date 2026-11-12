/**
 * docs/event-log.md is generated from the event schema by
 * scripts/event-log-doc.ts. This fails when the page is not what the
 * generator prints: after a change to an event, run
 * `bun scripts/event-log-doc.ts --write`.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { EVENT_LOG_DOC, describeValidator, renderEventLog } from "../../scripts/event-log-doc.ts"
import { EVENT_TYPES, durableEvents } from "../../packages/core/src/event/durable.ts"
import { DecodeError, array, integer, nonEmptyString, nullable, object, oneOf, optional, string, variant } from "../../packages/core/src/validate.ts"

describe("docs/event-log.md", () => {
  test("is what the generator produces (bun scripts/event-log-doc.ts --write)", async () => {
    expect(readFileSync(EVENT_LOG_DOC, "utf8")).toBe(await renderEventLog())
  })

  test("has a section for every durable event, with its version", () => {
    const page = readFileSync(EVENT_LOG_DOC, "utf8")
    for (const type of EVENT_TYPES) expect(page, type).toContain(`### \`${type}\`\n\nVersion ${durableEvents[type].v}.`)
  })
})

describe("reading a validator by running it", () => {
  test("fields in order, optional and nullable ones, unions and lists", () => {
    const validator = object({
      id: nonEmptyString,
      note: nullable(string),
      kind: oneOf(["a", "b"]),
      count: integer(1),
      tags: array(string),
      later: optional(integer()),
      shape: variant("kind", { x: object({ kind: oneOf(["x"]), size: integer(0) }), y: object({ kind: oneOf(["y"]) }) }),
    })
    expect(describeValidator(validator as never)).toEqual({
      k: "object",
      fields: [
        { name: "id", optional: false, type: { k: "non-empty string" } },
        { name: "note", optional: false, type: { k: "nullable", inner: { k: "string" } } },
        { name: "kind", optional: false, type: { k: "enum", values: ["a", "b"] } },
        { name: "count", optional: false, type: { k: "integer", min: 1 } },
        { name: "tags", optional: false, type: { k: "array", item: { k: "string" } } },
        { name: "later", optional: true, type: { k: "integer", min: null } },
        {
          name: "shape",
          optional: false,
          type: {
            k: "variant",
            tag: "kind",
            variants: {
              x: { k: "object", fields: [{ name: "kind", optional: false, type: { k: "enum", values: ["x"] } }, { name: "size", optional: false, type: { k: "integer", min: 0 } }] },
              y: { k: "object", fields: [{ name: "kind", optional: false, type: { k: "enum", values: ["y"] } }] },
            },
          },
        },
      ],
    })
  })

  test("a hand-written validator it cannot read stops it, naming the path", () => {
    const date = (input: unknown, path: string) => {
      if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) throw new DecodeError(path, "a date", input)
      return input
    }
    const odd = object({ when: date })
    expect(() => describeValidator(odd as never)).toThrow(/when: a validator this generator cannot describe \(its error says it expects a date\)/)
  })
})
