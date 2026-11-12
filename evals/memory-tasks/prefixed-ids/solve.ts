import { join } from "node:path"

const dir = process.argv[2]!
const ids = join(dir, "src/ids.ts")
await Bun.write(ids, (await Bun.file(ids).text()).replace('  att: "attachment",\n', '  att: "attachment",\n  rxn: "reaction",\n'))
await Bun.write(
  join(dir, "src/reactions.ts"),
  `import { newId } from "./ids.ts"

export interface Reaction {
  readonly id: string
  readonly commentId: string
  readonly emoji: string
  readonly userId: string
}

const byStore = new WeakMap<object, Reaction[]>()

export function addReaction(store: object, commentId: string, emoji: string, userId: string): Reaction {
  const list = byStore.get(store) ?? []
  byStore.set(store, list)
  const existing = list.find((reaction) => reaction.commentId === commentId && reaction.emoji === emoji && reaction.userId === userId)
  if (existing) return existing
  const reaction = { id: newId("rxn"), commentId, emoji, userId }
  list.push(reaction)
  return reaction
}

export function reactionsFor(store: object, commentId: string): Reaction[] {
  return (byStore.get(store) ?? []).filter((reaction) => reaction.commentId === commentId)
}
`,
)
