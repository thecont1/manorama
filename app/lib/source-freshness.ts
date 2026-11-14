/**
 * Gallery source-freshness, the platform-free half.
 *
 * A probe is a cheap metadata listing compared against the stored
 * manifest: changed → the caller runs the full refresh; unchanged →
 * nothing else happens; unknown → the listing was incomplete or the
 * manifest predates per-item change tokens, so the honest answer is "we
 * could not tell" — never "unchanged". This file holds the compare and
 * throttle rules the server probe and the device-side (encrypted source)
 * compare share; the provider listing code lives in source-probe.ts and
 * the scanners.
 */

export type ProbeStatus = 'changed' | 'unchanged' | 'unknown' | 'device' | 'skipped'
export type ProbeOutcome = { status: ProbeStatus; reason?: string }

/** The slice of a manifest item the compare needs — structural, so a
 *  GalleryImage, a VideoItem, and a device-scanned listing item all fit. */
export type FreshnessItem = { ref?: string; filename: string; contentVersion?: string }

/** How fresh a source check must be before a Library load re-probes. */
export const SOURCE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** A gallery is due for a source probe when its last check is missing or
 *  older than the interval. Unparseable stamps count as never checked. */
export const sourceCheckDue = (lastSourceCheckAt: string | null | undefined, now = Date.now()): boolean => {
  if (!lastSourceCheckAt) return true
  const at = Date.parse(lastSourceCheckAt)
  return !Number.isFinite(at) || now - at >= SOURCE_CHECK_INTERVAL_MS
}

/** The identity a provider listing and a manifest share: `ref` when the
 *  provider hands out a stable item id (Drive file id, iCloud photo guid,
 *  CloudKit record name, Google Photos uid, encrypted node id), else the
 *  filename — the same key the refresh merge and reorder use. */
export const manifestKeyOf = (image: { ref?: string; filename: string }): string =>
  image.ref ?? image.filename

/** One entry in a provider listing: the item's manifest key and the
 *  provider's content-change token for it (Dropbox rev, Drive md5Checksum,
 *  an iCloud derivative set, a CloudKit recordChangeTag). */
export type ListingEntry = { key: string; version?: string }

/**
 * Compares the stored manifest against a fresh listing.
 *  - 'changed' when the key sets differ or any shared item's version moved.
 *  - 'unchanged' only when every item on both sides carries a version and
 *    they all match.
 *  - 'unknown' when the sets match but a version is missing on either side
 *    — a manifest written before change tokens, or a provider that could
 *    not supply one. An unprovable answer is never 'unchanged'.
 */
export const versionedListingDiffers = (
  stored: readonly FreshnessItem[],
  fresh: readonly ListingEntry[],
): 'changed' | 'unchanged' | 'unknown' => {
  const expected = new Map<string, string | undefined>()
  for (const image of stored) expected.set(manifestKeyOf(image), image.contentVersion)
  const found = new Map<string, string | undefined>()
  for (const entry of fresh) found.set(entry.key, entry.version)
  if (expected.size !== found.size) return 'changed'
  let unproven = false
  for (const [key, version] of expected) {
    if (!found.has(key)) return 'changed'
    const live = found.get(key)
    if (version === undefined || live === undefined) unproven = true
    else if (version !== live) return 'changed'
  }
  return unproven ? 'unknown' : 'unchanged'
}

/** Key-set compare for providers with no per-item change token (Google
 *  Photos share items are immutable — an add or a removal is the only
 *  possible change). Order is deliberately ignored everywhere: the
 *  refresh merge preserves the owner's ordering, so a source-side reorder
 *  alone is not a change a refresh would act on. */
export const keyListingDiffers = (
  stored: readonly { ref?: string; filename: string }[],
  freshKeys: readonly string[],
): 'changed' | 'unchanged' => {
  const expected = new Set(stored.map(manifestKeyOf))
  if (expected.size !== freshKeys.length) return 'changed'
  return freshKeys.every((key) => expected.has(key)) ? 'unchanged' : 'changed'
}

/** The device-side twin of the server probe: a client-opened encrypted
 *  source listing compared against the stored manifest the same way.
 *  A truncated listing can prove nothing — 'unknown', never 'unchanged'. */
export const deviceListingOutcome = (
  stored: readonly FreshnessItem[],
  listing: { images: readonly FreshnessItem[]; truncated?: number },
): 'changed' | 'unchanged' | 'unknown' =>
  listing.truncated !== undefined
    ? 'unknown'
    : versionedListingDiffers(stored, listing.images.map((image) => ({ key: manifestKeyOf(image), version: image.contentVersion })))
