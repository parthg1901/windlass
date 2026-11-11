// Applies pending migrations from migrations/ to a JSON "database" in db/<env>.json.
//   bun migrate.ts --env <dev|test>
import { readdir, unlink } from "node:fs/promises"

const ENVS = ["dev", "test"]
const args = process.argv.slice(2)
const flag = args.indexOf("--env")
const env = flag >= 0 ? args[flag + 1] : undefined
if (!env || !ENVS.includes(env)) {
  console.error(`error: missing or unknown --env. Usage: bun migrate.ts --env <${ENVS.join("|")}>`)
  process.exit(2)
}

const dbPath = `db/${env}.json`
const lockPath = `db/${env}.lock`
const lock = Bun.file(lockPath)
if (await lock.exists()) {
  const pid = (await lock.text()).match(/pid=(\d+)/)?.[1]
  console.error(`error: ${lockPath} exists (left by pid ${pid}). Another migration may be running.`)
  console.error(`If no migration is running, delete ${lockPath} and run the command again.`)
  process.exit(1)
}
await Bun.write(lockPath, `pid=${process.pid}\nstarted=${new Date().toISOString()}\n`)

const db = await Bun.file(dbPath).json()
const names = (await readdir("migrations")).filter((name) => name.endsWith(".json")).sort()
for (const file of names) {
  const name = file.replace(/\.json$/, "")
  if (db.applied.some((entry: { name: string }) => entry.name === name)) continue
  const text = await Bun.file(`migrations/${file}`).text()
  const step = JSON.parse(text)
  if (step.create) db.tables[step.create] = step.columns
  if (step.alter) db.tables[step.alter] = [...db.tables[step.alter], ...step.add]
  const checksum = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12)
  db.applied.push({ name, checksum })
  db.version = db.applied.length
  console.log(`applied ${name}`)
}
await Bun.write(dbPath, JSON.stringify(db, null, 2) + "\n")
await unlink(lockPath)
console.log(`${env} is at version ${db.version}`)
