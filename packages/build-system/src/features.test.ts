/**
 * The feature manifest's contract with the build: a selection must resolve to a
 * closed, deterministic set, and every id must map to a valid `__FEAT_*__`
 * identifier. `vite.config.ts` folds those identifiers to literals, and that
 * folding is the only thing that drops a page from a smaller tier -- so a
 * duplicate or non-identifier flag silently stops gating and grows every
 * artifact. These are the invariants that keep that from regressing.
 */
import { describe, expect, test } from 'bun:test'
import {
  FEATURES,
  FEATURE_IDS,
  MANDATORY,
  TIERS,
  flagName,
  resolveFeatures,
} from './features'

const sorted = (ids: Iterable<string>) => [...ids].sort()

describe('flagName', () => {
  test('every feature id maps to a distinct, valid identifier', () => {
    const flags = FEATURE_IDS.map(flagName)
    for (const flag of flags) expect(flag).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    // A collision would give two features the same define, so one of them could
    // never be toggled independently.
    expect(new Set(flags).size).toBe(flags.length)
  })

  test('hyphenated legacy ids lose their hyphens', () => {
    expect(flagName('Desktop-Multi')).toBe('DesktopMulti')
    expect(flagName('Terminal-Enumation-All')).toBe('TerminalEnumationAll')
  })

  test('rejects an unknown id rather than inventing a flag', () => {
    expect(() => flagName('No-Such-Feature')).toThrow()
  })
})

describe('resolveFeatures', () => {
  test.each(Object.keys(TIERS))('%s preset resolves to a stable closed set', (tier) => {
    const first = sorted(resolveFeatures(undefined, tier))
    expect(sorted(resolveFeatures(undefined, tier))).toEqual(first)
    // Passing the resolved set back in as an explicit spec must be a no-op.
    expect(sorted(resolveFeatures(first.join(',')))).toEqual(first)
  })

  test('mandatory features are re-added even when the spec omits them', () => {
    for (const spec of ['FileSaver', TIERS.large.join(',')]) {
      const got = resolveFeatures(spec)
      for (const id of MANDATORY) expect(got.has(id)).toBe(true)
    }
  })

  test('requires is closed transitively', () => {
    expect(resolveFeatures('Scripting-Editor').has('Scripting')).toBe(true)
    expect(resolveFeatures('Wireless').has('NetworkSettings')).toBe(true)
    expect(resolveFeatures('IDERStats').has('IDER')).toBe(true)
  })

  test('every tier preset names known features', () => {
    for (const [tier, ids] of Object.entries(TIERS)) {
      for (const id of ids) {
        expect(FEATURE_IDS, `${tier} names unknown feature ${id}`).toContain(id)
      }
    }
  })

  test('the large preset covers every visible non-inert feature', () => {
    const large = resolveFeatures(undefined, 'large')
    const missing = FEATURES.filter(
      (f) => f.inert !== true && f.mandatory !== true && !large.has(f.id),
    ).map((f) => f.id)
    // InstallFromWeb is deliberately outside every preset.
    expect(missing).toEqual(['InstallFromWeb'])
  })

  test('an unknown tier is an error, not a silent default', () => {
    expect(() => resolveFeatures(undefined, 'gigantic')).toThrow()
  })
})
