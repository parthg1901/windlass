// Reference: run the validator's checks on every record under the CI profile, without stopping at the first.
import { join } from "node:path"

const dir = process.argv[2]!
const script = `import json, sys\nfrom pathlib import Path\nsys.path.insert(0, "tools")\nfrom validate import Invalid, load_profile, validate_record\nprofile = load_profile("ci")\nfor path in sorted(Path("data").glob("*.json")):\n    record = json.loads(path.read_text())\n    try:\n        validate_record(record, profile)\n    except Invalid:\n        print(record["id"])\n`
const proc = Bun.spawnSync(["python3", "-c", script], { cwd: dir, stdout: "pipe", stderr: "inherit" })
if (proc.exitCode !== 0) throw new Error("python failed")
await Bun.write(join(dir, "rejected.txt"), proc.stdout.toString())
