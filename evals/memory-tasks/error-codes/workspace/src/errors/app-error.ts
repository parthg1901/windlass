import { CODES, type ErrorCode } from "./codes.ts"

/** An error the API turns into a 4xx/5xx response with a stable code clients can match on. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail?: string,
  ) {
    super(detail === undefined ? CODES[code] : `${CODES[code]}: ${detail}`)
    this.name = "AppError"
  }

  get status(): number {
    return this.code.startsWith("E4") ? 400 : 500
  }
}
