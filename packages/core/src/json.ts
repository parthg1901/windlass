/** A value that survives `JSON.parse(JSON.stringify(value))` unchanged. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
