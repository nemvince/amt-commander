/**
 * Firmware vulnerability banner.
 *
 * Ported from checkAmtVersion() (index.html:4944) and the banner markup at
 * index.html:845. AMT reports "11.8.50"; the thresholds below are per platform
 * generation, so a version is vulnerable unless it clears its generation's fix.
 */
import { useState } from 'preact/hooks'
import { FEAT_VersionWarning } from '../features'
import { amtVersionString } from '../state/device'
import { isVulnerableVersion } from '../lib/version'
import { S } from '../strings'
import { WarnIcon } from './icons'

const ADVISORY_URL = 'https://security-center.intel.com/advisory.aspx?intelid=INTEL-SA-00075&languageid=en-fr'

export function VersionWarning() {
  const [dismissed, setDismissed] = useState(false)
  const version = amtVersionString.value
  if (!FEAT_VersionWarning || dismissed || version === '') return null

  if (!isVulnerableVersion(version)) return null

  return (
    <div class="banner" role="status">
      <WarnIcon size={18} />
      <span style={{ flex: 1 }}>
        {S.vulnerableVersionVersion.replace('{0}', version)}{' '}
        <a href={ADVISORY_URL} target="_blank" rel="noreferrer noopener">
          {S.advisoryLink}
        </a>
      </span>
      <button type="button" class="dialog-close" onClick={() => setDismissed(true)} aria-label={S.close}>
        ×
      </button>
    </div>
  )
}