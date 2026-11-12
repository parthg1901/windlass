export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("mean of no values")
  return sum(values) / values.length
}

export function variance(values: readonly number[]): number {
  const m = mean(values)
  return mean(values.map((value) => (value - m) ** 2))
}

export function stddev(values: readonly number[]): number {
  return Math.sqrt(variance(values))
}

export function range(values: readonly number[]): [number, number] {
  if (values.length === 0) throw new RangeError("range of no values")
  return [Math.min(...values), Math.max(...values)]
}
