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
 * Terms points at the site's own /terms page; Support stays empty until
 * the owner names a channel.
 */
export const LINKS: { terms: string | null; support: string | null } = {
  terms: '/terms',
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

/**
 * One appearance of the Library.
 *
 * The four captures are the same Library — dark, quiet and dark, quiet and
 * light, light — and the loop moves through them in this order. Because
 * the quiet captures are the same pixels with the words sunk to a whisper
 * and the photographs left at full brightness, the dissolve between a
 * loud state and its quiet twin reads as the interface going out rather
 * than as a cut between two unrelated pictures.
 */
export type LibraryState = {
  /** The file basename under /home, without an extension. */
  src: string
  /** The name of the state, in the app's own words. */
  name: string
  /** The one line that says what the state is for. */
  caption: string
  /** What a reader of the picture would see. */
  alt: string
}

/**
 * The Library's four appearances, in the order the loop walks them.
 *
 * The captures are 3456×2168 — a 1728×1084 window at 2× — and they are
 * served at that width: `src` names the file the homepage publishes the
 * capture as. The canvas is drawn at the capture's logical size, so a 2×
 * screen asks the device for exactly the pixels the file holds, and
 * nothing is resampled in between.
 */
export const LIBRARY_STATES: LibraryState[] = [
  {
    src: 'lib-dark',
    name: 'Dark mode',
    caption: 'Every control, lit.',
    alt:
      'The manorama Library in dark mode: the wordmark and the Library heading in the left column, the Add Gallery button, a strip of pinned gallery photographs across the top and a grid of local galleries below.',
  },
  {
    src: 'lib-quiet-dark',
    name: 'Quiet and Dark mode',
    caption: 'The interface steps back.',
    alt:
      'The same Library in dark mode with the quiet view on: every word and control has sunk to a whisper while the photographs keep their full brightness.',
  },
  {
    src: 'lib-quiet-light',
    name: 'Quiet and Light mode',
    caption: 'Quiet, in daylight too.',
    alt:
      'The same Library in light mode with the quiet view on: a pale ground, the photographs at full brightness, and the words sunk almost to nothing.',
  },
  {
    src: 'lib-light',
    name: 'Light mode',
    caption: 'The same Library. Different light.',
    alt:
      'The manorama Library in light mode: the same wordmark, the Add Gallery button, the strip of pinned photographs and the grid of local galleries, on a pale ground.',
  },
]

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
