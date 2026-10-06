/**
 * Live size arithmetic for the feature picker.
 *
 * The numbers are measurements, never guesses: `scripts/prepare.ts` reduces the
 * console's real-build cache (`apps/console/build/.size-cache.json`) into the
 * baseline plus one marginal per feature, and this file only adds up the ones
 * that are still the sole carrier of their code. A dependency's cost is already
 * inside every dependent's measurement -- counting its own entry as well is what
 * inflated a full selection by a quarter in the old estimator.
 */
import { FEATURES } from '@meshcommander/build-system'

export interface SizeTable {
  /** Mandatory-only build, in gzipped bytes; null means "never measured". */
  baseline: number | null
  /** Feature id -> bytes that feature adds on top of the baseline. */
  marginal: Record<string, number>
  /** Sorted feature list -> the artifact size that list was measured at. */
  whole: Record<string, number>
}

export interface SizeEstimate {
  bytes: number
  /** True when this exact selection was built and measured, not summed. */
  exact: boolean
  /** Features with no measurement behind them, so the number is a floor. */
  unmeasured: string[]
}

/** Features that gate nothing: they cost no bytes and are never measured. */
const INERT = new Set(FEATURES.filter((f) => f.inert === true).map((f) => f.id))

/** Ids `id` pulls in through `requires`, transitively, excluding itself. */
const closureOf = (id: string): string[] => {
  const out: string[] = []
  const stack = [...(FEATURES.find((f) => f.id === id)?.requires ?? [])]
  while (stack.length > 0) {
    const dep = stack.pop()
    if (dep == null || out.includes(dep)) {
      continue
    }
    out.push(dep)
    stack.push(...(FEATURES.find((f) => f.id === dep)?.requires ?? []))
  }
  return out
}

/**
 * The measured selection closest to `selected`, by symmetric difference.
 *
 * Ties go to the larger set: a preset with one feature toggled off is a better
 * anchor than a single-feature probe that happens to be the same distance away.
 */
const closestMeasured = (selected: ReadonlySet<string>, whole: Record<string, number>): string | null => {
  let best: string | null = null
  let bestDistance = Infinity
  for (const key of Object.keys(whole)) {
    const ids = key.split(',')
    const known = new Set(ids)
    let distance = 0
    for (const id of selected) {
      if (!known.has(id)) {
        distance++
      }
    }
    for (const id of known) {
      if (!selected.has(id)) {
        distance++
      }
    }
    if (distance < bestDistance || (distance === bestDistance && best != null && ids.length > best.split(',').length)) {
      best = key
      bestDistance = distance
    }
  }
  return best
}

/**
 * Gzipped size of a closed feature selection.
 *
 * `enabled` must already include the mandatory core and every `requires`
 * dependency (`resolveFeatures` produces exactly that).
 *
 * A measured selection is reported as measured. Anything else is anchored on the
 * closest measured build and moved by the marginals that differ: a plain sum of
 * marginals counts shared shell code once per feature, which is what made
 * *removing* a feature raise the number (78,276 B measured, 86,013 B estimated
 * for one feature less). Anchoring keeps the display monotone and lands within a
 * few hundred bytes of the real artifact.
 */
export const estimateSize = (enabled: readonly string[], table: SizeTable | null): SizeEstimate => {
  if (table?.baseline == null) {
    return { bytes: 0, exact: false, unmeasured: [...enabled] }
  }

  const selected = new Set(enabled)
  const measured = table.whole[[...enabled].sort().join(',')]
  if (measured != null) {
    return { bytes: measured, exact: true, unmeasured: [] }
  }

  const anchorKey = closestMeasured(selected, table.whole)
  if (anchorKey == null) {
    return { bytes: table.baseline, exact: false, unmeasured: [...enabled] }
  }

  const anchor = new Set(anchorKey.split(','))
  const added = [...selected].filter((id) => !anchor.has(id))
  const removed = [...anchor].filter((id) => !selected.has(id))

  /*
   * A marginal is measured as baseline + that feature's whole requires-closure,
   * so when both a feature and something it requires differ from the anchor, the
   * dependency's cost is already inside the dependent's number. Counting its own
   * marginal as well is the double-count this model exists to avoid.
   */
  const carriedBy = (ids: readonly string[]): Set<string> => {
    const out = new Set<string>()
    for (const id of ids) {
      for (const dep of closureOf(id)) {
        out.add(dep)
      }
    }
    return out
  }
  const addedCarried = carriedBy(added)
  const removedCarried = carriedBy(removed)

  const unmeasured: string[] = []
  let bytes = table.whole[anchorKey]
  for (const [id, sign] of [
    ...added.filter((id) => !addedCarried.has(id)).map((id) => [id, 1] as const),
    ...removed.filter((id) => !removedCarried.has(id)).map((id) => [id, -1] as const),
  ]) {
    const marginal = table.marginal[id]
    if (marginal == null) {
      if (!INERT.has(id)) {
        unmeasured.push(id)
      }
    } else {
      bytes += sign * marginal
    }
  }
  return { bytes, exact: false, unmeasured }
}

export const formatBytes = (n: number): string => `${n.toLocaleString('en-US')} B`
