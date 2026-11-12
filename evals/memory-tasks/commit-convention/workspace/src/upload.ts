import { MAX_BYTES } from "./limits.ts"

export function checkUpload(name: string, bytes: number): string | null {
  if (bytes > MAX_BYTES) return `${name} exeeds the maximum upload size of ${MAX_BYTES / 1024 / 1024} MB`
  return null
}
