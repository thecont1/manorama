import type { ExifData } from './imagesource'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31

/** "2026-11-22T14:05:09+05:30" -> "22 November 2026, 14:05". The recorded
 *  wall-clock time is shown as written — the offset is metadata, not a
 *  licence to re-zone the photograph. Date-only input drops the time;
 *  anything unparseable returns untouched so a manifest string can never
 *  disappear. */
export const formatCaptured = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)?/.exec(raw.trim())
  if (!m) return raw
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return raw
  const date = `${day} ${MONTHS[month - 1]} ${year}`
  if (m[4] === undefined) return date
  const hour = Number(m[4]), minute = Number(m[5])
  if (hour > 23 || minute > 59) return raw
  return `${date}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** The exposure line: "f/2.8 · 1/250 s · ISO 400 · 35 mm" — aperture,
 *  shutter, ISO and focal length in that order, each only when the
 *  manifest carries it. */
export const formatExposure = (exif: ExifData | undefined): string | undefined => {
  if (!exif) return undefined
  const parts: string[] = []
  if (exif.aperture) parts.push(exif.aperture)
  if (exif.shutter) parts.push(exif.shutter)
  if (typeof exif.iso === 'number' && exif.iso > 0) parts.push(`ISO ${exif.iso}`)
  if (exif.focalLength) parts.push(exif.focalLength)
  return parts.length ? parts.join(' · ') : undefined
}
