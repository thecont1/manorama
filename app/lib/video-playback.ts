/**
 * Video playback policy — the decisions, separated from the lifecycle.
 *
 * The island owns the `<video>` element and its effects; this module owns
 * every *choice* it makes, as pure functions over plain data. That keeps
 * the rules testable without a DOM and keeps the three requirements they
 * encode in one readable place:
 *
 *   1. A video starts playing when it LOADS, not when it becomes the
 *      active slide. Arriving at a video slide should find motion already
 *      underway.
 *   2. Playing video is bounded: only frames near the cursor own a media
 *      element, so a long gallery does not open dozens of decoders.
 *   3. On a poor connection the clip stays a still image — we do not even
 *      fetch its metadata.
 */

/**
 * The parts of the Network Information API we rely on. It is unevenly
 * implemented (absent in Safari and Firefox), so every field is optional
 * and absence means "no reason to hold back".
 */
export type ConnectionLike = {
  /** Browser-level Data Saver: an explicit request for less traffic. */
  saveData?: boolean
  /** Round-trip-derived bucket: 'slow-2g' | '2g' | '3g' | '4g' | ... */
  effectiveType?: string
  /** Estimated downlink in Mbit/s. 0 means "unknown", not "slow". */
  downlink?: number
}

/** Effective-type buckets too slow to stream a clip without stalling. */
const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g'])

/**
 * Below this many Mbit/s we treat the link as poor even when the carrier
 * labels it 4g — congested mobile links routinely report a good bucket
 * with a measured downlink far under it.
 */
const MIN_DOWNLINK_MBPS = 1

/**
 * True when the connection is too poor (or too deliberately frugal) to
 * stream video. Unknown is never treated as slow: most browsers expose
 * nothing here, and failing closed would disable video for them all.
 */
export const isSlowConnection = (connection: ConnectionLike | null | undefined): boolean => {
  if (!connection) return false
  if (connection.saveData === true) return true

  const effectiveType = typeof connection.effectiveType === 'string'
    ? connection.effectiveType.toLowerCase()
    : ''
  if (SLOW_EFFECTIVE_TYPES.has(effectiveType)) return true

  // A reading of 0 (or a non-finite value from a polyfill) is "unknown",
  // so only a positive measurement below the floor counts as slow.
  const downlink = connection.downlink
  if (typeof downlink === 'number' && Number.isFinite(downlink) && downlink > 0 && downlink < MIN_DOWNLINK_MBPS) {
    return true
  }
  return false
}

/**
 * Reads the Network Information API off a navigator-like object, tolerating
 * the vendor-prefixed spellings and its total absence.
 */
export const connectionOf = (nav: unknown): ConnectionLike | undefined => {
  if (!nav || typeof nav !== 'object') return undefined
  const n = nav as Record<string, unknown>
  const candidate = n.connection ?? n.mozConnection ?? n.webkitConnection
  return candidate && typeof candidate === 'object' ? candidate as ConnectionLike : undefined
}

export type AutoplayInput = {
  /** Whether this slide is the one the visitor is looking at. */
  isActive?: boolean
  prefersReducedMotion?: boolean
  connection?: ConnectionLike | null
  documentHidden?: boolean
}

/**
 * Whether a mounted video may start playing.
 *
 * Deliberately does NOT consult `isActive`: a loaded video plays. The
 * bound on *how many* videos load lives in `videoMountsFor`, which is the
 * honest place for it — gating playback on activation is what made videos
 * wait for their turn.
 */
export const shouldAutoplayVideo = ({
  prefersReducedMotion = false,
  connection = undefined,
  documentHidden = false,
}: AutoplayInput): boolean => {
  if (prefersReducedMotion) return false
  if (documentHidden) return false
  if (isSlowConnection(connection)) return false
  return true
}

/**
 * How far from the current slide a video still gets a media element.
 * One on each side: the next step always lands on a clip that is already
 * running, without opening a decoder for the whole gallery.
 */
export const VIDEO_MOUNT_RADIUS = 1

export type MountInput = {
  imageIndex: number
  index: number
  /** The viewer's own activity window (strip retention, vertical IO, ...). */
  frameActive: boolean
  galleryEntered?: boolean
  /** A modal, info sheet, or anything else that should silence the stage. */
  blocked?: boolean
  connection?: ConnectionLike | null
}

/**
 * Whether this frame owns a `<video>` at all.
 *
 * Bounded to a small neighbourhood so "already running when loaded" is
 * true for the frames a visitor can reach in one step, while a 200-photo
 * strip never mounts 200 decoders. On a poor connection nothing mounts:
 * the poster is the whole frame.
 */
export const videoMountsFor = ({
  imageIndex,
  index,
  frameActive,
  galleryEntered = true,
  blocked = false,
  connection = undefined,
}: MountInput): boolean => {
  if (!galleryEntered || blocked) return false
  if (!frameActive) return false
  if (isSlowConnection(connection)) return false
  return Math.abs(imageIndex - index) <= VIDEO_MOUNT_RADIUS
}

/**
 * Only the active slide may be audible. Neighbours run muted, so stepping
 * between two clips never overlaps two soundtracks.
 */
export const videoAudibleFor = ({ isActive, soundOn }: { isActive: boolean; soundOn: boolean }): boolean =>
  Boolean(isActive && soundOn)
