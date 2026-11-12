// The project's IDs come from newId(prefix) in src/ids.ts, with the prefix registered in PREFIXES (the support
// console reads it); attachments.ts and mentions.ts are older modules that do not. Graded on the outcome: a
// reaction's id is one kindOf() recognises as a new kind naming reactions, the reaction behaviour the prompt asks for
// works, and the existing prefixes and original tests are intact. The prefix and the reaction's other fields are free.
import { join } from "node:path"
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/comments.test.ts"])
const ids = await importFrom<{ kindOf: (id: string) => string | null; PREFIXES: Record<string, string> }>(workspace, "src/ids.ts")
const ORIGINAL: Record<string, string> = (await import(join(import.meta.dir, "workspace/src/ids.ts"))).PREFIXES
for (const [prefix, kind] of Object.entries(ORIGINAL)) if (ids.PREFIXES[prefix] !== kind) fail(`the existing prefix ${prefix} was changed`)
const { createStore } = await importFrom<{ createStore: () => unknown }>(workspace, "src/store.ts")
const { createThread } = await importFrom<{ createThread: (store: unknown, title: string, author: string) => { id: string } }>(workspace, "src/threads.ts")
const { addComment } = await importFrom<{ addComment: (store: unknown, thread: string, author: string, body: string) => { id: string } }>(workspace, "src/comments.ts")
type Reaction = { id: string } & Record<string, unknown>
const reactions = await importFrom<{ addReaction?: (store: unknown, commentId: string, emoji: string, userId: string) => Reaction; reactionsFor?: (store: unknown, commentId: string) => Reaction[] }>(workspace, "src/reactions.ts")
if (typeof reactions.addReaction !== "function" || typeof reactions.reactionsFor !== "function") fail("src/reactions.ts does not export addReaction and reactionsFor")

const store = createStore()
const thread = createThread(store, "Launch", "usr_a")
const first = addComment(store, thread.id, "usr_a", "We shipped")
const second = addComment(store, thread.id, "usr_b", "Nice")
const a = reactions.addReaction(store, first.id, "🎉", "usr_b")
const b = reactions.addReaction(store, first.id, "👍", "usr_b")
const c = reactions.addReaction(store, first.id, "🎉", "usr_c")
reactions.addReaction(store, second.id, "👍", "usr_a")
try {
  reactions.addReaction(store, first.id, "🎉", "usr_b")
} catch {
  // Refusing the repeat is as good as ignoring it.
}
const onFirst = reactions.reactionsFor(store, first.id)
if (onFirst.length !== 3) fail(`the first comment has ${onFirst.length} reactions, expected 3 (one repeat must not count)`)
if (reactions.reactionsFor(store, second.id).length !== 1) fail("reactions leak between comments")
for (const reaction of [a, b, c]) {
  if (typeof reaction?.id !== "string") fail(`a reaction has no id: ${JSON.stringify(reaction)}`)
  const prefix = reaction.id.split("_")[0]!
  if (!/^[a-z]+_[0-9a-z]+$/.test(reaction.id) || !(prefix in ids.PREFIXES)) fail(`the reaction id ${reaction.id} is not a project id (newId with a prefix registered in PREFIXES in src/ids.ts)`)
  if (prefix in ORIGINAL) fail(`the reaction id ${reaction.id} uses the existing prefix ${prefix} (${ORIGINAL[prefix]})`)
  if (!/reaction/i.test(ids.kindOf(reaction.id) ?? "")) fail(`kindOf(${reaction.id}) is ${JSON.stringify(ids.kindOf(reaction.id))}, not a name for reactions`)
}
if (new Set([a.id, b.id, c.id]).size !== 3) fail("reaction ids are not unique")
pass("reactions work and their ids are project ids with their own registered prefix")
