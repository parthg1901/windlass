import type { Store } from "./store.ts"

/** Comments whose body contains every word of the query, newest first. */
export function searchComments(store: Store, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "")
  return [...store.comments.values()]
    .filter((comment) => words.every((word) => comment.body.toLowerCase().includes(word)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
