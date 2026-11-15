import {
  FREE_PIPELINE_LIMIT,
  FREE_RETAINED_LIMIT,
  PAID_RETAINED_LIMIT,
  PIPELINE_LIFETIME_MS,
} from '../../lib/gallery-policy'

/**
 * The single source of truth for the marketing homepage.
 *
 * Everything a launch decision can change lives here: the sample gallery
 * path, the app URLs, the Terms and Support slots, the image assets and the
 * prices: so the page can be corrected in one place and the numbers can
 * never drift from the limits the code enforces.
 *
 * The limits are imported from `gallery-policy.ts` rather than written out,
 * because a page that says "3" while the policy says 4 is a lie the owner
 * has to find in production.
 */

/** The one gallery the owner has cleared for public linking (plan D6). */
export const SAMPLE_GALLERY_PATH = '/thecontrarian/italy'

/**
 * The interactive homepage photo demo. On by default: the owner cleared the
 * photographs for the public page on 13 November 2026 (see
 * `demo/manifest.ts`). Set the Worker var `MANORAMA_HOME_DEMO=off` to fall
 * back to the static hero; when off, no demo code or assets load at all.
 */
export const HOME_DEMO_ENABLED = true

/** A temporary gallery's life, in whole days, derived from the policy. */
export const TEMPORARY_GALLERY_DAYS = Math.round(PIPELINE_LIFETIME_MS / 86_400_000)

export const PRICING = {
  /** Owner-approved launch prices (plan §1). */
  free: '$0',
  firstYear: '$12',
  yearly: '$20',
}

/** The allowance, in the words the page uses. */
export const LIMITS = {
  freePermanent: FREE_RETAINED_LIMIT,
  freeTemporary: FREE_PIPELINE_LIMIT,
  visionaryPermanent: PAID_RETAINED_LIMIT,
  temporaryDays: TEMPORARY_GALLERY_DAYS,
}

/**
 * Footer links that only exist once the owner approves them (plan D8).
 * `null` means the link is not rendered at all: never a dead link.
 */
export const LINKS: { terms: string | null; support: string | null } = {
  terms: null,
  support: null,
}

export type AssetStatus =
  /** No capture yet: an exact-ratio box, neutral in production. */
  | 'placeholder'
  /**
   * A real capture exists in the repository but the owner has not cleared
   * it for the public page yet. It ships as the interim picture and is
   * listed in `docs/homepage-assets.md` as a launch blocker.
   */
  | 'interim'
  /** Cleared by the owner. */
  | 'approved'

export type Asset = {
  id: string
  /** The picture's alt text. */
  alt: string
  /** The capture this slot wants. */
  intended: string
  /** Intrinsic pixel size, so the box is reserved and the picture never stretches. */
  width: number
  height: number
  /** The file basename under /home, without an extension. */
  src: string | null
  /** True when a half-size variant of the same capture is served too. */
  small?: boolean
  status: AssetStatus
  /** The caption printed under the picture. */
  caption: string
  /** True when the picture is the first thing on the page. */
  eager?: boolean
}

/**
 * The pictures. Intrinsic sizes are the source sizes: the served file is
 * never stretched, and the reserved box matches the file exactly.
 */
export const ASSETS: Asset[] = [
  {
    id: 'H1',
    alt: 'The macOS app showing one photograph at its own size, with the next frame waiting at the edge',
    intended: 'Desktop viewer, one photograph fitted, mixed portrait and landscape frames abutting',
    width: 1440,
    height: 900,
    src: 'h1-viewer',
    status: 'interim',
    caption: 'Every frame shown whole. Explore at your own pace.',
    eager: true,
  },
  {
    id: 'H2',
    alt: 'A matrix of photographs from one gallery on the iPhone, the active one outlined in pink',
    intended: 'iPhone Global View: a matrix of closely hanging photographs',
    width: 1284,
    height: 2778,
    src: 'h2-matrix',
    small: true,
    status: 'interim',
    caption: 'Every gallery, hanging together.',
  },
  {
    id: 'H3',
    alt: 'The iPhone app showing one photograph fitted on a black canvas',
    intended: 'iPhone: one photograph fitted, chrome hidden',
    width: 1284,
    height: 2778,
    src: 'h3-iphone',
    small: true,
    status: 'interim',
    caption: 'One photograph, fitted.',
  },
  {
    id: 'H4',
    alt: 'The Mac app opening a gallery, the gallery title set large over the first photograph',
    intended: 'macOS shell: the gallery curtain, title in the display face',
    width: 1440,
    height: 900,
    src: 'h4-macos-curtain',
    status: 'interim',
    caption: 'One tap, and it opens.',
  },
  {
    id: 'H5',
    alt: 'The iPad app showing one photograph from the gallery, fitted on a black canvas',
    intended: 'iPad: one photograph fitted, chrome hidden',
    width: 2752,
    height: 2064,
    src: 'h5-ipad',
    small: true,
    status: 'interim',
    caption: 'The same gallery, on the iPad.',
  },
]

export const assetById = (id: string): Asset | undefined => ASSETS.find((a) => a.id === id)

export type Source = {
  id: string
  name: string
  /**
   * The line printed under the name: what this source actually gives, in
   * the visitor's words. It is the truth the page must not drift from —
   * iCloud and Google Photos both carry video, the encrypted sources
   * decrypt on the visitor's own device, and Proton Drive refuses to
   * serve a browser at all.
   */
  detail: string
}

/**
 * The supported sources, each one verified against `app/lib/sources.ts` and
 * the README during implementation (plan §D).
 */
export const SOURCES: Source[] = [
  {
    id: 'dropbox',
    name: 'Dropbox',
    detail: 'Photos and video',
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    detail: 'Photos',
  },
  {
    id: 'icloud',
    name: 'iCloud',
    detail: 'Photos and video',
  },
  {
    id: 'gphotos',
    name: 'Google Photos',
    detail: 'Photos and video',
  },
  {
    id: 'mega',
    name: 'MEGA',
    detail: 'Photos, decrypted on your device',
  },
  {
    id: 'ente',
    name: 'Ente',
    detail: 'Photos, decrypted on your device',
  },
  {
    id: 'proton',
    name: 'Proton Drive',
    detail: 'Photos, in the apps only',
  },
]
