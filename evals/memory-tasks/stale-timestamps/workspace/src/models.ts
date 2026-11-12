export type ShipmentStatus = "waiting" | "picked_up" | "delivered" | "failed"

export interface Shipment {
  readonly id: string
  readonly orderId: string
  readonly driverId: string | null
  readonly status: ShipmentStatus
  readonly createdAt: Date
  /** Set by the driver app when the parcel is scanned at pick-up; null before. */
  readonly pickedUpAt: Date | null
  readonly deliveredAt: Date | null
}

export interface Driver {
  readonly id: string
  readonly name: string
  readonly phone: string
  readonly lastSeenAt: Date | null
}

export interface Order {
  readonly id: string
  readonly customerId: string
  readonly placedAt: Date
  readonly items: readonly { sku: string; quantity: number }[]
}
