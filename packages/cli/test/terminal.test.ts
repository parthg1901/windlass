import { describe, expect, test } from "bun:test"
import { type EditorAction, Screen } from "../src/terminal.ts"
import { VirtualTerminal } from "./vt.ts"

const UP = "\x1b[A"
const DOWN = "\x1b[B"
const ALT_ENTER = "\x1b\r"

function setup(columns = 40) {
  const vt = new VirtualTerminal(columns)
  const raw = new Screen({ write: (text) => vt.write(text), columns: () => columns, color: false })
  // The actions each read amounts to, in order.
  const screen = Object.assign(raw, {
    input(data: string) {
      const actions: EditorAction[] = []
      Screen.prototype.input.call(raw, data, (action) => actions.push(action))
      return actions
    },
  })
  return { vt, screen }
}

/** Lets the footer redraw that `write` schedules run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("the editor", () => {
  test("Enter submits; Alt-Enter and a trailing backslash continue the entry on a new line", () => {
    const { screen } = setup()
    expect(screen.input("first line")).toEqual([])
    expect(screen.input(ALT_ENTER)).toEqual([])
    expect(screen.input("second\\")).toEqual([])
    expect(screen.input("\r")).toEqual([])
    expect(screen.input("third\r")).toEqual([{ kind: "submit", text: "first line\nsecond\nthird" }])
    expect(screen.entry).toBe("")
  })

  test("Up recalls a multi-line entry whole; inside it Up and Down move between its lines first", () => {
    const { screen } = setup()
    screen.input("one\r")
    screen.input(`two${ALT_ENTER}lines\r`)
    screen.input("draft")
    screen.input(UP)
    expect(screen.entry).toBe("two\nlines")
    // The cursor is at the end of "lines"; Up moves to "two", the next Up goes to the older entry.
    screen.input(UP)
    expect(screen.entry).toBe("two\nlines")
    screen.input(UP)
    expect(screen.entry).toBe("one")
    screen.input(DOWN)
    expect(screen.entry).toBe("two\nlines")
    screen.input(DOWN)
    screen.input(DOWN)
    expect(screen.entry).toBe("draft")
    // A recalled entry submits whole.
    screen.input("\x15")
    screen.input(UP)
    expect(screen.input("\r")).toEqual([{ kind: "submit", text: "two\nlines" }])
  })

  test("a paste is inserted whole, line breaks included, and does not submit by itself", () => {
    const { screen } = setup()
    expect(screen.input("\x1b[200~a\r\nb\rc\x1b[201~")).toEqual([])
    expect(screen.entry).toBe("a\nb\nc")
    // Without bracketed paste, several lines in one read are a paste too; a final Enter submits it.
    screen.input("\x15\x15\x15")
    const { screen: plain } = setup()
    expect(plain.input("x\ry\r")).toEqual([{ kind: "submit", text: "x\ny" }])
  })

  test("editing keys", () => {
    const { screen } = setup()
    screen.input("hello wide world")
    screen.input("\x17")
    expect(screen.entry).toBe("hello wide ")
    screen.input("\x01X")
    expect(screen.entry).toBe("Xhello wide ")
    screen.input("\x05\x7f\x7f")
    expect(screen.entry).toBe("Xhello wid")
    screen.input("\x1b[D\x1b[D\x0b")
    expect(screen.entry).toBe("Xhello w")
    screen.input("\x15")
    expect(screen.entry).toBe("")
    screen.input("é👍🏽")
    screen.input("\x7f")
    expect(screen.entry).toBe("é")
  })

  test("an action is handled before the keys after it in the same read apply", () => {
    const { screen } = setup()
    screen.input("draft")
    const seen: string[] = []
    Screen.prototype.input.call(screen, "\x03/exit\r", (action) => {
      seen.push(`${action.kind}:${screen.entry}`)
      if (action.kind === "interrupt") screen.clear()
      if (action.kind === "submit") seen.push(action.text)
    })
    expect(seen).toEqual(["interrupt:draft", "submit:", "/exit"])
  })

  test("Ctrl-C is an interrupt; Ctrl-D is end of input only on an empty entry", () => {
    const { screen } = setup()
    expect(screen.input("\x03")).toEqual([{ kind: "interrupt" }])
    screen.input("ab\x01")
    expect(screen.input("\x04")).toEqual([])
    expect(screen.entry).toBe("b")
    screen.clear()
    expect(screen.input("\x04")).toEqual([{ kind: "eof" }])
  })
})

describe("the footer", () => {
  test("sits below output, follows it, and leaves only the output when closed", async () => {
    const { vt, screen } = setup()
    screen.write("line one\n")
    screen.show("› ", "type to steer")
    expect(vt.text).toBe("line one\n› type to steer")
    expect(vt.cursor).toEqual({ row: 1, col: 2 })
    screen.input("abc")
    expect(vt.text).toBe("line one\n› abc")
    screen.write("line two\n")
    await settle()
    expect(vt.text).toBe("line one\nline two\n› abc")
    expect(vt.cursor).toEqual({ row: 2, col: 5 })
    screen.close()
    expect(vt.text).toBe("line one\nline two")
  })

  test("text that is still streaming continues on its own line, above the footer", async () => {
    const { vt, screen } = setup(20)
    screen.show("› ")
    screen.setStatus("⋯ working")
    screen.write("The answer is")
    await settle()
    expect(vt.text).toBe("The answer is\n⋯ working\n›")
    screen.write(" long enough to wrap twice over")
    screen.write(" here.")
    await settle()
    expect(vt.text).toBe("The answer is long e\nnough to wrap twice\nover here.\n⋯ working\n›")
    screen.write("\n")
    screen.setStatus(null)
    await settle()
    expect(vt.text).toBe("The answer is long e\nnough to wrap twice\nover here.\n›")
  })

  test("a multi-line entry wider than the terminal keeps the cursor where the text is", async () => {
    const { vt, screen } = setup(12)
    screen.show("› ")
    screen.input(`abcdefghijklmnop${ALT_ENTER}xy`)
    expect(vt.text).toBe("› abcdefghij\nklmnop\n  xy")
    expect(vt.cursor).toEqual({ row: 2, col: 4 })
    screen.input(UP)
    expect(vt.cursor).toEqual({ row: 0, col: 4 })
    screen.write("out\n")
    await settle()
    expect(vt.text).toBe("out\n› abcdefghij\nklmnop\n  xy")
  })

  test("an entry that exactly fills a row does not throw the cursor off", async () => {
    const { vt, screen } = setup(10)
    screen.show("› ")
    screen.input("12345678")
    expect(vt.cursor).toEqual({ row: 1, col: 0 })
    screen.write("next\n")
    await settle()
    expect(vt.text).toBe("next\n› 12345678")
    expect(vt.cursor).toEqual({ row: 2, col: 0 })
  })
})
