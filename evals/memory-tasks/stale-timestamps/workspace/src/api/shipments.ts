import type { Shipment } from "../models.ts"
import { iso } from "./time.ts"

export function shipmentResponse(shipment: Shipment) {
  return {
    id: shipment.id,
    orderId: shipment.orderId,
    driverId: shipment.driverId,
    status: shipment.status,
    createdAt: iso(shipment.createdAt),
    deliveredAt: iso(shipment.deliveredAt),
  }
}
