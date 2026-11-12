import { slugify } from "./slug.ts"

export interface Post {
  readonly title: string
  readonly date: string
  readonly body: string
}

/** Where a post is served: /2026/11/<slug>/ */
export function postPath(post: Post): string {
  const [year, month] = post.date.split("-")
  return `/${year}/${month}/${slugify(post.title)}/`
}
