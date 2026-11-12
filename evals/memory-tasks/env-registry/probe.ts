// Run by check.ts in a fresh process with or without DIGEST_BATCH_SIZE set: prints the batch sizes sendDigests uses.
const workspace = process.argv[2]!
const { sendDigests } = await import(`${workspace}/src/digest.ts`)
const count = Number(process.argv[3])
const subscribers = Array.from({ length: count }, (_, index) => ({ email: `user${index}@x.example`, items: ["news"] }))
const sizes: number[] = []
await sendDigests(subscribers, async (batch: unknown[]) => {
  sizes.push(batch.length)
})
console.log(JSON.stringify(sizes))
