export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]!
}

/** The closest candidate within a small edit distance, for "did you mean …?". */
export function suggest(input: string, candidates: Iterable<string>): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const c of candidates) {
    if (c === input) continue
    const d = levenshtein(input.toUpperCase(), c.toUpperCase())
    if (d < bestDist) {
      best = c
      bestDist = d
    }
  }
  const limit = Math.max(1, Math.min(3, Math.floor(input.length / 4)))
  return bestDist <= limit ? best : null
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function shortDate(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : ''
}
