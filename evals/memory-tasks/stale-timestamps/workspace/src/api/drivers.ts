import type { Driver } from "../models.ts"
import { iso } from "./time.ts"

/** What the customer app may see of a driver: never the phone number. */
export function driverResponse(driver: Driver) {
  return { id: driver.id, name: driver.name, lastSeenAt: iso(driver.lastSeenAt) }
}
