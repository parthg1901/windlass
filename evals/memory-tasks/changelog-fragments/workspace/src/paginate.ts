export interface Page<T> {
  readonly items: readonly T[]
  readonly page: number
  readonly pages: number
}

/** Page `page` (1-based) of `items`, `size` per page. A page past the end is empty. */
export function paginate<T>(items: readonly T[], page: number, size: number): Page<T> {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`page size ${size}`)
  const pages = Math.max(1, Math.ceil(items.length / size))
  const start = (page - 1) * size
  const end = Math.min(start + size, items.length - 1)
  return { items: items.slice(start, Math.max(start, end)), page, pages }
}
