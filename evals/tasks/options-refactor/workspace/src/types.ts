export interface Customer {
  readonly name: string
  readonly email: string
  readonly locale: string
  readonly currency: string
}

export interface Item {
  readonly label: string
  readonly price: number
  readonly quantity: number
}
