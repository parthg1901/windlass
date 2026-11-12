import { join } from "node:path"

await Bun.write(
  join(process.argv[2]!, "ANSWER.md"),
  "Not a bug in our code: in 2.4.0 parseDuration(\"1h30m\") returns 5400 (checked). The customer is on 2.2.1 (their lockfile); the compound-duration bug was fixed in 2.3.0. They should upgrade.\n",
)
