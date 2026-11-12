export interface LineItem {
  readonly sku: string
  readonly quantity: number
  readonly unitPrice: number
}

export interface Order {
  readonly id: string
  readonly items: readonly LineItem[]
  readonly subtotal: number
  readonly couponCode: string | null
  readonly region: "US" | "CA"
}

export interface Coupon {
  readonly code: string
  /** Percent off the subtotal, 0 to 100. */
  readonly percentOff: number
  readonly minimumSubtotal: number
}

export interface Customer {
  readonly id: string
  readonly email: string
  readonly taxExempt: boolean
}

export interface Receipt {
  readonly orderId: string
  readonly lines: readonly string[]
  readonly total: number
}

// Money: every price, subtotal, fee and total in this codebase is an integer number of cents (1999 is $19.99).
// Convert to dollars only for display, in src/ui/format.ts.
