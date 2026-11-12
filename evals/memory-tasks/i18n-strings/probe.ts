// Run by check.ts in a fresh process (so en.json is read again): prints an empty cart's lines.
const { cartLines } = await import(`${process.argv[2]!}/src/cart.ts`)
console.log(JSON.stringify(cartLines([])))
