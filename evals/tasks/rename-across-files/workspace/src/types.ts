export interface Line {
  readonly description: string
  /** Integer cents. */
  readonly amount: number
}

export interface Invoice {
  readonly id: string
  readonly userId: string
  readonly issuedAt: string
  readonly paid: boolean
  readonly lines: readonly Line[]
}
