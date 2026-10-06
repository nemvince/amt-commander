/**
 * Byte-order helpers shared by the redirection protocols.
 *
 * The legacy naming is load-bearing: a trailing `X` means little-endian, and no
 * suffix means big-endian. The AMT protocols mix both on the wire, so these stay
 * four distinct functions rather than one with a flag -- conflating them would
 * corrupt a session in a way that is painful to debug.
 *
 * These were reimplemented per module (kvm, redirect, scripting, audit) before
 * being collected here.
 */

/** 32-bit, big-endian. */
export function intToStr(v: number): string {
  return String.fromCharCode((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
}

/** 16-bit, big-endian. */
export function shortToStr(v: number): string {
  return String.fromCharCode((v >> 8) & 0xff, v & 0xff)
}

/** 32-bit, little-endian. */
export function intToStrX(v: number): string {
  return String.fromCharCode(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
}

/** 16-bit, little-endian. */
export function shortToStrX(v: number): string {
  return String.fromCharCode(v & 0xff, (v >> 8) & 0xff)
}

/** Read a 16-bit big-endian value out of a byte string. */
export function readShort(v: string, p: number): number {
  return (v.charCodeAt(p) << 8) + v.charCodeAt(p + 1)
}
