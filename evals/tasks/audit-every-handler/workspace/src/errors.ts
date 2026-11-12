export class ValidationError extends Error {
  constructor(
    readonly field: string,
    readonly problem: string,
  ) {
    super(`${field} ${problem}`)
  }
}

export class NotFoundError extends Error {
  constructor(
    readonly table: string,
    readonly id: string,
  ) {
    super(`no ${table} row ${id}`)
  }
}

export function requireText(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(field, "is required")
}
