/**
 * The dashboard's icon set, shared by the web workbench and the native account
 * screen. Both surfaces offer the same actions on a gallery — copy its link,
 * open its cloud folder, refresh it from that folder, remove it — so the
 * drawings live here once, on the same 24px grid with the same 1.5px stroke,
 * and cannot drift apart.
 *
 * Every icon is decorative: the button that carries it supplies the accessible
 * name, which is also what keeps the two surfaces' controls identical to a
 * screen reader.
 */

export const CopyIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8" y="8" width="11" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8" fill="none" stroke="currentColor" stroke-width="1.5" />
  </svg>
)

export const TrashIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 7h14M10 4h4l1 3H9l1-3ZM8 7l.7 13h6.6L16 7M10 10v7M14 10v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)

export const OpenIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M19 13v5.5A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-11A1.5 1.5 0 0 1 6.5 6H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)

export const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8M20 4v4h-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M20 12a8 8 0 0 1-13.66 5.66L4 16M4 20v-4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)

export const SourceIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.5 8.5v9A1.5 1.5 0 0 0 5 19h14a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 19 8h-7.5L9.5 5.5A1.5 1.5 0 0 0 8.5 5H5a1.5 1.5 0 0 0-1.5 1.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    <path d="M3.5 8.5h17" fill="none" stroke="currentColor" stroke-width="1.5" />
  </svg>
)

export const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
)