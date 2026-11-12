import { join } from "node:path"

const path = join(process.argv[2]!, "src/api/shipments.ts")
const text = await Bun.file(path).text()
await Bun.write(path, text.replace("    deliveredAt: iso(shipment.deliveredAt),\n", "    pickedUpAt: iso(shipment.pickedUpAt),\n    deliveredAt: iso(shipment.deliveredAt),\n"))
