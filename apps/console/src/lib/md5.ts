/**
 * MD5 for AMT digest users. Ported from amt-0.2.0.js (TinyMD5).
 *
 * AMT's digest password is md5(user + ':' + realm + ':' + pass); there is no
 * stdlib MD5, and pulling in a crypto library for 200 bytes of digest is not
 * worth the bundle. This is the same arithmetic as the legacy implementation.
 */

const K = new Int32Array(64)
for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0

/** Per-round rotation amounts, indexed as 4 * round + (step % 4). */
const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]

export function hexMd5(str: string | null): string {
  const bytes = new TextEncoder().encode(str ?? '')
  // 16 int32 words per 64-byte block, plus room for the length tail.
  const x = new Int32Array((((bytes.length + 8) >> 6) + 1) * 16)
  for (let i = 0; i < bytes.length; i++) x[i >> 2] |= bytes[i] << (8 * (i % 4))
  // 0x80 terminator, then the 64-bit little-endian bit length.
  x[bytes.length >> 2] |= 0x80 << (8 * (bytes.length % 4))
  x[(((bytes.length + 8) >> 6) * 16) + 14] = bytes.length * 8

  let h0 = 1732584193
  let h1 = -271733879
  let h2 = ~1732584193
  let h3 = ~-271733879

  for (let i = 0; i < x.length; i += 16) {
    let a = h0
    let b = h1
    let c = h2
    let d = h3

    for (let j = 0; j < 64; j++) {
      const round = j >> 4
      let f: number
      let word: number
      if (round === 0) {
        f = (b & c) | (~b & d)
        word = j
      } else if (round === 1) {
        f = (d & b) | (~d & c)
        word = 5 * j + 1
      } else if (round === 2) {
        f = b ^ c ^ d
        word = 3 * j + 5
      } else {
        f = c ^ (b | ~d)
        word = 7 * j
      }

      const sh = SHIFTS[4 * round + (j % 4)]
      const sum = (a + f + K[j] + (x[word % 16 + i] | 0)) | 0
      const rotated = ((sum << sh) | (sum >>> (32 - sh))) | 0
      a = d
      d = c
      c = b
      b = (b + rotated) | 0
    }

    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
  }

  let out = ''
  for (const h of [h0, h1, h2, h3]) {
    for (const s of [0, 8, 16, 24]) out += ((h >>> s) & 0xff).toString(16).padStart(2, '0')
  }
  return out
}

/** Raw-string MD5 result: the hex digest reinterpreted as a byte string. */
export function rstrMd5(str: string | null): string {
  const hex = hexMd5(str)
  let out = ''
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16))
  return out
}

/** AMT digest: md5(user:realm:pass). */
export function digestPassword(user: string, realm: string, pass: string): string {
  return hexMd5(user + ':' + realm + ':' + pass)
}