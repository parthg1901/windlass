import { join } from "node:path"

const dir = process.argv[2]!
const settings = join(dir, "settings.json")
await Bun.write(settings, (await Bun.file(settings).text()).replace('"2.3.7"', '"2.4.0"').replace('"telemetry": false', '"telemetry": true'))
const deploy = join(dir, "deploy.yaml")
await Bun.write(
  deploy,
  (await Bun.file(deploy).text())
    .replace("replicas: 2 # keep", "replicas: 4 # keep")
    .replace('CACHE_TTL: "300"\n', 'CACHE_TTL: "300"\n      LOG_LEVEL: debug\n'),
)
