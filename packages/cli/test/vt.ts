/**
 * A minimal terminal for tests: it applies the subset of control sequences the
 * CLI writes (cursor up and forward, carriage return, newline, backspace, erase
 * below, erase line) to a grid that scrolls without limit, with the terminal's
 * deferred wrap at the right edge. Styles are dropped.
 */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export class VirtualTerminal {
  private readonly rows: string[][] = [[]]
  private row = 0
  private col = 0
  /** The cursor is at the right edge after a write; the next character wraps first. */
  private pending = false

  constructor(readonly columns: number) {}

  write(data: string): void {
    let rest = data
    while (rest !== "") {
      const control = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(rest)
      if (control !== null) {
        this.csi(control[1]!, control[3]!)
        rest = rest.slice(control[0].length)
        continue
      }
      const char = rest.codePointAt(0)! > 0xffff ? rest.slice(0, 2) : rest[0]!
      if (char === "\r") {
        this.col = 0
        this.pending = false
      } else if (char === "\n") {
        this.col = 0
        this.pending = false
        this.down()
      } else if (char === "\b") {
        if (this.pending) this.pending = false
        else this.col = Math.max(0, this.col - 1)
      } else {
        const cluster = graphemes.segment(rest)[Symbol.iterator]().next().value!.segment
        this.put(cluster)
        rest = rest.slice(cluster.length)
        continue
      }
      rest = rest.slice(char.length)
    }
  }

  /** What the screen shows, each row without trailing spaces, without trailing empty rows. */
  get text(): string {
    const lines = this.rows.map((cells) => cells.map((cell) => cell ?? " ").join("").replace(/\s+$/, ""))
    while (lines.length > 0 && lines.at(-1) === "") lines.pop()
    return lines.join("\n")
  }

  get cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col }
  }

  private put(cluster: string): void {
    const width = Math.max(1, Bun.stringWidth(cluster))
    if (this.pending || this.col + width > this.columns) {
      this.pending = false
      this.col = 0
      this.down()
    }
    const cells = this.line()
    cells[this.col] = cluster
    for (let index = 1; index < width; index += 1) cells[this.col + index] = ""
    this.col += width
    if (this.col >= this.columns) {
      this.col = this.columns - 1
      this.pending = true
    }
  }

  private csi(params: string, final: string): void {
    const n = Number(params === "" ? 1 : params.split(";")[0]) || 1
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - n)
        this.pending = false
        return
      case "B":
        this.row += n
        this.line()
        this.pending = false
        return
      case "C":
        this.col = Math.min(this.columns - 1, this.col + n)
        this.pending = false
        return
      case "G":
        this.col = Math.min(this.columns - 1, n - 1)
        this.pending = false
        return
      case "J":
        this.line().splice(this.col)
        this.rows.splice(this.row + 1)
        return
      case "K":
        if (params === "2") this.rows[this.row] = []
        else this.line().splice(this.col)
        return
      default:
        // Styles and modes (bracketed paste) change nothing on the grid.
        return
    }
  }

  private down(): void {
    this.row += 1
    this.line()
  }

  private line(): string[] {
    while (this.rows.length <= this.row) this.rows.push([])
    return this.rows[this.row]!
  }
}
