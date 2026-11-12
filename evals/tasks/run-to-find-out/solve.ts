// Reference: run the validator's checks on every record of both CI steps, without stopping at the first.
import { join } from "node:path"

const dir = process.argv[2]!
let ids = ""
for (const [profile, data] of [["ci", "data"], ["ci-late", "data/late"]] as const) {
  const script = `import json, sys\nfrom pathlib import Path\nsys.path.insert(0, "tools")\nfrom validate import Invalid, load_profile, validate_record\nprofile = load_profile("${profile}")\nfor path in sorted(Path("${data}").glob("*.json")):\n    record = json.loads(path.read_text())\n    try:\n        validate_record(record, profile)\n    except Invalid:\n        print(record["id"])\n`
  const proc = Bun.spawnSync(["python3", "-B", "-c", script], { cwd: dir, stdout: "pipe", stderr: "inherit" })
  if (proc.exitCode !== 0) throw new Error("python failed")
  ids += proc.stdout.toString()
}
await Bun.write(join(dir, "rejected.txt"), ids)
