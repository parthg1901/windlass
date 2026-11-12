import { ERRORS, type ErrorCode } from "./generated/errors.ts"

export interface ApiResponse {
  readonly status: number
  readonly body: unknown
}

export function ok(body: unknown): ApiResponse {
  return { status: 200, body }
}

export function apiError(code: ErrorCode): ApiResponse {
  const error = ERRORS[code]
  return { status: error.status, body: { error: code, message: error.message } }
}
