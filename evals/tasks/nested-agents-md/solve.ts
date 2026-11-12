import { join } from "node:path"

const dir = process.argv[2]!
const edit = async (file: string, from: string, to: string) => {
  const path = join(dir, file)
  const text = await Bun.file(path).text()
  if (!text.includes(from)) throw new Error(`${file}: ${from} not found`)
  await Bun.write(path, text.replace(from, to))
}
await edit(
  "packages/server/src/config.ts",
  "/** The server's",
  `export function parsePort(text: string): number {
  const trimmed = text.trim()
  const value = Number(trimmed)
  if (!/^\\d+$/.test(trimmed) || value < 1 || value > 65535) throw new RangeError(\`not a port: \${JSON.stringify(text)}\`)
  return value
}

/** The server's`,
)
await edit("packages/server/src/config.ts", "Number(env.PORT)", "parsePort(env.PORT)")
await edit(
  "packages/edge-agent/src/config.ts",
  "export function parseHeartbeat",
  `export function parsePort(text: string): Result<number> {
  const trimmed = text.trim()
  const value = Number(trimmed)
  if (!/^\\d+$/.test(trimmed) || value < 1 || value > 65535) return err(\`port \${JSON.stringify(text)} is not 1 to 65535\`)
  return ok(value)
}

export function parseHeartbeat`,
)
await edit(
  "packages/edge-agent/src/config.ts",
  "  const port = env.EDGE_PORT === undefined ? DEFAULT_PORT : Number.parseInt(env.EDGE_PORT, 10) || DEFAULT_PORT\n",
  `  let port = DEFAULT_PORT
  if (env.EDGE_PORT !== undefined) {
    const parsed = parsePort(env.EDGE_PORT)
    if (parsed.ok) port = parsed.value
    else warnings.push(\`\${parsed.error}; using \${DEFAULT_PORT}\`)
  }
`,
)
