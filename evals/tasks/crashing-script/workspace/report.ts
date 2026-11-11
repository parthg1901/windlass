// Prints a summary of an orders file: bun report.ts [orders.json]
interface Order {
  id: string
  customer: string
  totalCents: number
  tags: string[]
}

const path = process.argv[2] ?? "orders.json"
const orders: Order[] = await Bun.file(path).json()

const revenue = orders.reduce((sum, order) => sum + order.totalCents, 0)
const tagCounts = new Map<string, number>()
for (const order of orders) {
  for (const tag of order.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
}
const customers = new Set(orders.map((order) => order.customer))
const topTags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

console.log(`orders: ${orders.length}`)
console.log(`customers: ${customers.size}`)
console.log(`revenue: $${(revenue / 100).toFixed(2)}`)
console.log(`untagged: ${orders.filter((order) => order.tags.length === 0).length}`)
for (const [tag, count] of topTags) console.log(`tag ${tag}: ${count}`)
