/**
 * AMT firmware vulnerability check.
 *
 * Ported from checkAmtVersion() (index.html:4944). AMT reports "11.8.50"; the
 * fixed-version thresholds are per platform generation, so a version is
 * vulnerable unless it clears its own generation's minimum fixed build.
 */

/** True when the firmware is still affected by the advisory. */
export function isVulnerableVersion(version: string): boolean {
  const [v1, v2, v3] = version.split('.').map((n) => parseInt(n, 10) || 0)
  const vx = v2 * 1000 + v3

  if (v1 <= 5 || v1 >= 12) return false // pre-v5 and v12+ are all fixed
  if (v1 === 6) return vx < 2061 // 1st gen Core
  if (v1 === 7) return vx < 1091 // 2nd gen Core
  if (v1 === 8) return vx < 1071 // 3rd gen Core
  if (v1 === 9) return v2 < 5 ? vx < 1041 : vx < 5061 // 4th gen Core
  if (v1 === 10) return vx < 55 // 5th gen Core
  if (v1 === 11) return v2 < 5 ? vx < 25 : vx < 6027 // 6th / 7th gen Core
  return false
}
