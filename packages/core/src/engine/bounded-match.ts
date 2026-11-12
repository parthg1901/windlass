/**
 * A regular expression tried on a line with a time limit of the engine's own.
 *
 * The runtime's matcher backtracks, and nothing can stop it from the thread
 * it runs on: `(a+)+$` on a line of thirty characters that almost matches
 * takes about a second. Matched in the engine's thread, every such line
 * would hold the whole process for that long: no interrupt is taken, no
 * other session advances, no client is answered.
 *
 * So the match is made on a helper thread, and the engine waits for its
 * answer no longer than the budget it is given. A match that has not
 * answered by then is given up on: the helper is ended (the next match
 * starts another), and the caller is told, so that it stops asking with
 * that expression (`watchMatcher` ends its watch). What the engine's thread
 * loses to a slow expression is the budget, once.
 *
 * The helper is one per process, started on first use, and never keeps the
 * process alive. Where it cannot be started, the match is made in the
 * engine's thread and timed, so a slow one is at least noticed afterwards.
 */

export type BoundedMatch = "matched" | "no_match" | "over_budget"

/** What the helper thread runs: it compiles each expression once and answers through the shared cell. */
const HELPER_SOURCE = `
let cell = null
const compiled = new Map()
self.onmessage = (event) => {
  const data = event.data
  if (data.cell !== undefined) {
    cell = new Int32Array(data.cell)
    Atomics.store(cell, 0, 1)
    Atomics.notify(cell, 0)
    return
  }
  let answer = 4
  try {
    const key = data.flags + "/" + data.source
    let expression = compiled.get(key)
    if (expression === undefined) {
      if (compiled.size >= 64) compiled.clear()
      expression = new RegExp(data.source, data.flags)
      compiled.set(key, expression)
    }
    expression.lastIndex = 0
    answer = expression.test(data.line) ? 2 : 3
  } catch {}
  if (Atomics.compareExchange(cell, 0, 0, answer) === 0) Atomics.notify(cell, 0)
}
`

/** The states of the shared cell: the engine sets `PENDING` and waits; the helper sets one of the others. */
const PENDING = 0
const MATCHED = 2

/** How long the helper thread is given to start. It starts in a few milliseconds; this is for a machine under load. */
const START_WAIT_MS = 2000

interface Helper {
  readonly worker: Worker
  /** One cell this helper alone answers through. A helper that was given up on keeps its own, so a late answer of its reaches nobody. */
  readonly cell: Int32Array
}

let helper: Helper | null = null
/** Whether a helper could not be started in this process: it is not tried again. */
let unavailable = false

function startHelper(): Helper | null {
  if (unavailable) return null
  let url: string | null = null
  try {
    url = URL.createObjectURL(new Blob([HELPER_SOURCE], { type: "application/javascript" }))
    const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    const worker = new Worker(url)
    // It never keeps the process alive, and its failures are the caller's to notice (no answer in time).
    worker.unref()
    worker.onerror = () => {}
    worker.postMessage({ cell: cell.buffer })
    if (Atomics.wait(cell, 0, PENDING, START_WAIT_MS) === "timed-out") {
      worker.terminate()
      unavailable = true
      return null
    }
    return { worker, cell }
  } catch {
    unavailable = true
    return null
  } finally {
    if (url !== null) URL.revokeObjectURL(url)
  }
}

/**
 * Whether `expression` matches `line`, decided within `budgetMs` of the
 * engine's thread or not at all (`over_budget`). The expression is not
 * changed; one with the `g` or `y` flag is tried from the start of the line.
 */
export function boundedTest(expression: RegExp, line: string, budgetMs: number): BoundedMatch {
  helper ??= startHelper()
  if (helper === null) {
    const started = performance.now()
    expression.lastIndex = 0
    const matched = expression.test(line)
    return performance.now() - started > budgetMs ? "over_budget" : matched ? "matched" : "no_match"
  }
  const { worker, cell } = helper
  Atomics.store(cell, 0, PENDING)
  worker.postMessage({ source: expression.source, flags: expression.flags, line })
  Atomics.wait(cell, 0, PENDING, budgetMs)
  const answer = Atomics.load(cell, 0)
  if (answer === PENDING) {
    // Still at it: the thread is ended with its match, and the next match starts a new one.
    helper = null
    worker.terminate()
    return "over_budget"
  }
  return answer === MATCHED ? "matched" : "no_match"
}

/** Ends the helper thread, if one runs. The next match starts another. */
export function stopBoundedMatcher(): void {
  helper?.worker.terminate()
  helper = null
}
