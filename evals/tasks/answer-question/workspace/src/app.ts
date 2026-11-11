import { createClient } from "./client.ts"

// The app's one shared client. Product asked for fewer, slower retries against the inventory service.
export const client = createClient({ retry: { attempts: 4, baseDelayMs: 900 } })
