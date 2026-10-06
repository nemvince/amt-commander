/**
 * Firmware vulnerability notice.
 *
 * Ported from checkAmtVersion() (index.html:4944) and the banner markup at
 * index.html:845. AMT reports "11.8.50"; the thresholds below are per platform
 * generation, so a version is vulnerable unless it clears its generation's fix.
 *
 * It is a toast rather than a banner: it is about the device, not the page, and
 * a banner would push every view's content down by a row for the whole session.
 */
import { useState } from 'preact/hooks'
import { FEAT_VersionWarning } from '../features'
import { amtVersionString } from '../state/device'
import { isVulnerableVersion } from '../lib/version'
import { S } from '../strings'
import { WarnIcon } from './icons'

const ADVISORY_URL = 'https://security-center.intel.com/advisory.aspx?intelid=INTEL-SA-00075&languageid=en-fr'
const STORAGE_KEY = 'mc-ver-dismiss'

export function VersionWarning() {
  const [dismissed, setDismissed] = useState(localStorage.getItem(STORAGE_KEY) == 'true')
  const version = amtVersionString.value
  if (!FEAT_VersionWarning || dismissed || version === '') return null

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    setDismissed(true)
  }

  if (!isVulnerableVersion(version)) return null

  return (
    <div class="toast-host">
      <div class="toast toast-warn" role="status">
        <WarnIcon size={18} />
        <span style={{ flex: 1 }}>
          {S.vulnerableVersionVersion.replace('{0}', version)}{' '}
          <a href={ADVISORY_URL} target="_blank" rel="noreferrer noopener">
            {S.advisoryLink}
          </a>
        </span>
        <button type="button" class="dialog-close" onClick={handleDismiss} aria-label={S.close}>
          ×
        </button>
      </div>
    </div>
  )
}