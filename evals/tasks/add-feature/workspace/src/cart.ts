export interface LineItem {
  readonly sku: string
  readonly priceCents: number
  readonly quantity: number
}

/** A shopping cart. All amounts are integer cents. */
export class Cart {
  private readonly items: LineItem[] = []

  add(sku: string, priceCents: number, quantity = 1) {
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new RangeError(`invalid price: ${priceCents}`)
    if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError(`invalid quantity: ${quantity}`)
    this.items.push({ sku, priceCents, quantity })
    return this
  }

  subtotal() {
    return this.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
  }

  total() {
    return this.subtotal()
  }

  count() {
    return this.items.reduce((sum, item) => sum + item.quantity, 0)
  }
}
