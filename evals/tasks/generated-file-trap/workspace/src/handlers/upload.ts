import { type ApiResponse, apiError, ok } from "../http.ts"

export const MAX_BYTES = 25 * 1024 * 1024

export interface UploadRequest {
  readonly user: string | null
  readonly name: string
  readonly bytes: number
}

/** How many uploads each user made in the current rate-limit window; the scheduler clears it every minute. */
export const uploadsInWindow = new Map<string, number>()

export function handleUpload(request: UploadRequest): ApiResponse {
  if (request.user === null) return apiError("UNAUTHENTICATED")
  if (request.name.trim() === "") return apiError("BAD_REQUEST")
  if (request.bytes > MAX_BYTES) return apiError("FILE_TOO_LARGE")
  uploadsInWindow.set(request.user, (uploadsInWindow.get(request.user) ?? 0) + 1)
  return ok({ stored: request.name })
}
