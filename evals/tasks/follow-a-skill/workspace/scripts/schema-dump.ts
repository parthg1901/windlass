// Applies every migration to an empty database and writes schema.sql. See the schema-change skill.
import { join } from "node:path"
import { dumpSchema, freshDatabase } from "../src/migrate.ts"

const root = join(import.meta.dir, "..")
await Bun.write(join(root, "schema.sql"), dumpSchema(freshDatabase(join(root, "migrations"))))
console.log("schema.sql written")
