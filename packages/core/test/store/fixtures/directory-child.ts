/**
 * A child process for the session-directory tests.
 *
 *   bun directory-child.ts hold <dataDir> <id>            open the session for writing and wait until killed
 *   bun directory-child.ts crash <dataDir> <id>           open it, start an execution and a step, then wait to be killed
 *   bun directory-child.ts open <dataDir> <id>            try to open it; print the outcome as JSON
 *   bun directory-child.ts create <dataDir> <tag> <n>     create n sessions `<tag>_<i>`, each with one turn
 *   bun directory-child.ts append <dataDir> <id> <n>      open it and append n turns, one event at a time
 *   bun directory-child.ts list-loop <dataDir>            list all sessions over and over until killed
 *   bun directory-child.ts list <dataDir>                 print the listing as JSON
 *   bun directory-child.ts blobs <dataDir> <tag> <n>      store the same n blobs under this process's media type
 *
 * `hold`, `crash` and the loops print `ready` on its own line once they are at work.
 */
import type { SessionId } from "../../../src/id.ts"
import { SessionInUseError, openSessionDirectory } from "../../../src/store/directory.ts"
import { Driver, baselineSet, created, executionStarted, exchange, stepStarted, textEnded } from "../scripted.ts"

const [mode, dataDir, first, second] = process.argv.slice(2)
if (mode === undefined || dataDir === undefined) throw new Error("usage: directory-child.ts <mode> <dataDir> ...")
const directory = openSessionDirectory({ dataDir, notice: () => {} })
const id = first as SessionId

switch (mode) {
  case "hold": {
    directory.open(id)
    console.log("ready")
    await Bun.sleep(60_000)
    break
  }
  case "crash": {
    const store = directory.open(id)
    // A claim and an open step, as a process that dies in the middle of a model call leaves them.
    new Driver(store, id).add(executionStarted("exe_crash"), stepStarted("a_crash"), textEnded("a_crash", "Half an ans"))
    console.log("ready")
    await Bun.sleep(60_000)
    break
  }
  case "open": {
    try {
      directory.open(id).close()
      console.log(JSON.stringify({ ok: true }))
    } catch (error) {
      const held = error instanceof SessionInUseError
      console.log(JSON.stringify({ ok: false, name: (error as Error).name, message: (error as Error).message, code: (error as { code?: string }).code, holderPid: held ? error.holderPid : null }))
    }
    break
  }
  case "create": {
    for (let index = 0; index < Number(second); index += 1) {
      const session = `${first}_${index}` as SessionId
      const store = directory.create(session)
      const driver = new Driver(store, session)
      driver.add(created(`/work/${first}`, `${first} ${index}`), baselineSet())
      exchange(driver, "1", "What is this?", `Session ${index} of ${first}.`)
      store.close()
    }
    console.log(JSON.stringify({ created: Number(second) }))
    break
  }
  case "append": {
    const store = directory.open(id)
    const driver = new Driver(store, id)
    console.log("ready")
    for (let index = 0; index < Number(second); index += 1) {
      exchange(driver, `x${process.pid}_${index}`, `Question ${index}`, `Answer ${index}`)
      await Bun.sleep(2)
    }
    store.close()
    console.log(JSON.stringify({ lastSeq: directory.get(id)?.lastSeq }))
    break
  }
  case "list-loop": {
    console.log("ready")
    for (;;) directory.list({ includeArchived: true })
  }
  case "list": {
    console.log(JSON.stringify(directory.list({ includeArchived: true }).map((summary) => ({ id: summary.session.id, lastSeq: summary.lastSeq, archived: summary.session.archived }))))
    break
  }
  case "blobs": {
    const refs = Array.from({ length: Number(second) }, (_, index) => directory.putBlob(new TextEncoder().encode(`blob ${index} ${"x".repeat(index * 100)}`), `application/x-${first}`))
    console.log(JSON.stringify(refs))
    break
  }
  default:
    throw new Error(`unknown mode ${mode}`)
}
directory.close()
