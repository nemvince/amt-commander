/** Inline SVG icons, replacing the legacy GIF/PNG icon set. */
interface IconProps {
  size?: number
  class?: string
}

/** Shared presentation attributes for every inline icon. */
function Icon(props: IconProps): Record<string, string | number | undefined> {
  return {
    width: props.size ?? 16,
    height: props.size ?? 16,
    viewBox: '0 0 16 16',
    class: props.class,
    'aria-hidden': 'true',
  }
}

export const InfoIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a1 1 0 110 2 1 1 0 010-2zm1 8H7V7h2v5z" />
  </svg>
)

export const WarnIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M8 1L1 14h14L8 1zm0 4l4.5 8h-9L8 5zm-1 3v3h2V8H7zm0 4v2h2v-2H7z" />
  </svg>
)

export const ErrorIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z" />
  </svg>
)

export const OkIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3.7 5.3l-4.2 4.2-2.8-2.8 1.4-1.4 1.4 1.4 2.8-2.8 1.4 1.4z" />
  </svg>
)

export const LockIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M4 7V5a4 4 0 118 0v2h1v7H3V7h1zm2 0h4V5a2 2 0 10-4 0v2z" />
  </svg>
)

export const UnlockIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M6 7V5a2 2 0 114 0h2a4 4 0 10-8 0v2H3v7h10V7H6zm1 2h4v3H7V9z" />
  </svg>
)

export const RefreshIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M8 3V1L5 4l3 3V5a3 3 0 11-3 3H3a5 5 0 105-5z" />
  </svg>
)

export const AddIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M7 2h2v5h5v2H9v5H7V9H2V7h5V2z" />
  </svg>
)

export const TrashIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M6 2V1h4v1h4v2H2V2h4zM3 5h10l-1 10H4L3 5zm3 1v7h1V6H6zm3 0v7h1V6H9z" />
  </svg>
)

export const PowerIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M8 1v6h2V3.1a6 6 0 11-4 0V7h2V1H8z" />
  </svg>
)

export const ChevronIcon = (p: IconProps) => (
  <svg {...Icon(p)} fill="currentColor">
    <path d="M6 3l5 5-5 5V3z" />
  </svg>
)

/** Nav glyphs: one per top-level view, drawn on a 16x16 grid. */
const NAV_PATHS: Record<string, string> = {
  system: 'M2 2h12v3H2V2zm0 4h12v2H2V6zm0 3h12v2H2V9zm0 3h8v2H2v-2z',
  hardware: 'M2 3h12v10H2V3zm2 2v6h8V5H4zm1 1h6v4H5V6z',
  events: 'M3 2h10v12H3V2zm1 1v10h8V3H4zm2 2h4v1H6V5zm0 2h4v1H6V7zm0 2h4v1H6V9z',
  audit: 'M4 2h8v12H4V2zm1 1v10h6V3H5zm1 2h4v1H6V5zm0 2h4v1H6V7z',
  storage: 'M2 4h12v3H2V4zm0 5h12v3H2V9zm1-4h2v1H3V5zm0 5h2v1H3v-1z',
  network: 'M2 2h12v4H2V2zm0 8h12v4H2v-4zm1-7h2v1H3V3zm0 9h2v1H3v-1zm7-8h2v1h-2V4zm0 8h2v1h-2v-1z',
  users: 'M6 2a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM2 14c0-2.2 1.8-4 4-4s4 1.8 4 4H2zm9-6a2 2 0 110 4 2 2 0 010-4zm1 3c2 0 3 1.1 3 3h-3.5c.2-.5.3-1 .3-1.6 0-.5-.1-1-.3-1.4H12z',
  sol: 'M2 3h12v10H2V3zm1 1v8h10V4H3zm1 1h2v1H4V5zm0 2h2v1H4V7zm0 2h2v1H4V9zm3 0h5v1H7V9zm0-2h5v1H7V7zm0-2h5v1H7V5z',
  kvm: 'M2 3h12v9H2V3zm1 1v7h10V4H3zm3 9h4v1H6v-1z',
  internet: 'M8 1a7 7 0 100 14A7 7 0 008 1zM5 7.5C5 5 6.3 3 8 3s3 2 3 4.5c0 1.7-.8 3.2-2 4V10H7.5v1.5c-1.5-.8-2.5-2.3-2.5-4z',
  defense: 'M8 1l6 2v5c0 3.3-2.5 6.3-6 7-3.5-.7-6-3.7-6-7V3l6-2zm0 2.2L4 4.4V8c0 2.4 1.7 4.7 4 5.4 2.3-.7 4-3 4-5.4V4.4L8 3.2z',
  presence: 'M8 1a4 4 0 110 8 4 4 0 010-8zm0 2a2 2 0 100 4 2 2 0 000-4zM8 10c2.8 0 5 1.6 5 4v1H3v-1c0-2.4 2.2-4 5-4z',
  scripts: 'M3 2h7l3 3v9H3V2zm6 1.5V6h2.5L9 3.5zM5 8h6v1H5V8zm0 2h6v1H5v-1zm0 2h4v1H5v-1z',
  subs: 'M2 4h12v8H2V4zm2 2v4h8V6H4zm1 1h6v2H5V7z',
  alarms: 'M8 1a4.5 4.5 0 014.5 4.5V11l1.5 2H2l1.5-2V5.5A4.5 4.5 0 018 1zm0 2a2.5 2.5 0 00-2.5 2.5V10h5V5.5A2.5 2.5 0 008 3zm-1 8h2v2H7v-2z',
}

export function NavIcon(props: IconProps & { name: string }) {
  return (
    <svg {...Icon(props)} fill="currentColor">
      <path d={NAV_PATHS[props.name] ?? NAV_PATHS.system} />
    </svg>
  )
}