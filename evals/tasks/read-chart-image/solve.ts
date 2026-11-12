import { join } from "node:path"

const path = join(process.argv[2]!, "deploy/services.json")
const config = (await Bun.file(path).json()) as { services: { name: string; scaleUp: boolean; scaleDown: boolean }[] }
for (const service of config.services) {
  if (service.name === "queue-worker") service.scaleUp = true
  if (service.name === "scheduler") service.scaleDown = true
}
await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`)
