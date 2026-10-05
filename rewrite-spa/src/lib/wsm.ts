/**
 * WSMAN node accessors.
 *
 * AMT wraps a field's value in a single-key object (`{ Value: 'x' }`) and
 * sometimes returns arrays, so pulling a plain string or number out of a
 * response is fiddly enough that nearly every page had grown its own copy of
 * these helpers -- `s` alone existed four times. They live here so the
 * unwrapping rules are defined once.
 */
import type { AmtResult } from './amt-stack'
import type { WsmanNode } from './wsman'

/** Read a field as a string, unwrapping AMT's single-value wrapper objects. */
export function s(node: WsmanNode | undefined, key: string): string {
  const v = node?.[key]
  if (v == null) return ''
  if (typeof v === 'object' && !Array.isArray(v)) return String((v as WsmanNode)['Value'] ?? '')
  return Array.isArray(v) ? '' : String(v)
}

/** Read a field as a number; anything unparseable becomes 0. */
export function n(node: WsmanNode | undefined, key: string): number {
  return Number(s(node, key)) || 0
}

/** AMT spells booleans both ways depending on the class. */
export function yes(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Find a selector's value anywhere in a nested response. */
export function selectorValue(node: unknown, attr: string): string {
  if (node == null || typeof node !== 'object') return ''
  if (Array.isArray(node)) {
    for (const x of node) {
      const v = selectorValue(x, attr)
      if (v) return v
    }
    return ''
  }
  const o = node as WsmanNode
  if (o['@Name'] === attr) return s(o, 'Value')
  for (const key in o) {
    const v = selectorValue(o[key], attr)
    if (v) return v
  }
  return ''
}

/** Strip AMT's single-capitalised-key wrapper from a response node. */
export function unwrap(node: WsmanNode): WsmanNode {
  const keys = Object.keys(node)
  const only = keys.length === 1 ? node[keys[0]] : undefined
  const wrapper = typeof only === 'object' && only != null && !Array.isArray(only)
  return wrapper && /^[A-Z]/.test(keys[0]) ? (only as WsmanNode) : node
}

/** Normalise an AmtResult into the list of nodes it carries. */
export function items(result: AmtResult): WsmanNode[] {
  if (result.status !== 200) return []
  const body = result.response
  if (body != null) return [unwrap(body)]
  const many = result.responses as unknown
  return Array.isArray(many) ? (many as WsmanNode[]).map(unwrap) : []
}

/** Read a field as trimmed text, tolerating numbers. */
export function text(node: WsmanNode | undefined, key: string): string {
  const value = node?.[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

/** Read a field as a number, tolerating a missing node. */
export function num(node: WsmanNode | undefined, key: string): number {
  return Number(node?.[key] ?? 0)
}
