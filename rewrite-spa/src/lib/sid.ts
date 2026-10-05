/**
 * Windows SID encoding, ported from amt-0.2.0.js (GetSidString/GetSidByteArray).
 *
 * AMT hands Kerberos ACL entries and Kerberos audit initiators back as a raw SID
 * byte string, and takes one back when a Kerberos account is added.
 */

/** S-1-5-21-... from raw SID bytes, e.g. `S-1-5-32-544`. */
export function getSidString(sid: string): string {
  // Revision and the 48 bit authority live at fixed offsets in the header; the
  // sub-authorities that follow are 32 bit little endian.
  let r = 'S-' + sid.charCodeAt(0) + '-' + sid.charCodeAt(7)
  for (let i = 2; i < sid.length / 4; i++) {
    const p = i * 4
    r += '-' + (sid.charCodeAt(p + 3) * 0x1000000 + (sid.charCodeAt(p + 2) << 16) + (sid.charCodeAt(p + 1) << 8) + sid.charCodeAt(p))
  }
  return r
}

/**
 * Raw SID bytes from `S-1-5-...`, or null when the string is not a SID at all --
 * which is how the account form tells a Kerberos user apart from a digest user.
 */
export function sidToBytes(sidString: string): string | null {
  const parts = sidString.split('-')
  if (parts.length < 4 || (parts[0] !== 's' && parts[0] !== 'S')) return null
  for (let i = 1; i < parts.length; i++) if (!/^\d+$/.test(parts[i])) return null

  const revision = Number(parts[1])
  const authority = Number(parts[2])
  const sub = parts.slice(3).map(Number)

  let r = String.fromCharCode(revision, sub.length + 1)
  r += String.fromCharCode(
    Math.floor(authority / 0x1000000),
    (authority >> 16) & 0xff,
    (authority >> 8) & 0xff,
    authority & 0xff,
  )
  for (const a of sub) r += String.fromCharCode(a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff, (a >> 24) & 0xff)
  return r
}
