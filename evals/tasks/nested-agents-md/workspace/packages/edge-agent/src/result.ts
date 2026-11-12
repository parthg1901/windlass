export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const err = <T = never>(error: string): Result<T> => ({ ok: false, error })
