/**
 * Seeded "doodle" background — deterministic scattered photography icons.
 *
 * WhatsApp ships one static doodle tile. Manorama instead derives the
 * pattern from the URL, so every album owns a recognisable field of its
 * own while staying byte-identical across reloads, sessions, and
 * re-renders. The chain is:
 *
 *     url -> normalizeSeedUrl -> hashSeed (FNV-1a) -> mulberry32 -> layout
 *
 * Every stage is pure. No Math.random(), no Date.now(), no crypto — the
 * same input always yields the same placements, which is what makes the
 * layout safe to memoize and cheap to re-derive after a resize.
 *
 * This module is DOM-free on purpose: it runs identically under bun test,
 * during SSR, and in the browser.
 */

export type DoodleIcon = {
  /** Sprite symbol id, referenced by `<use href="#id">`. */
  id: string
  /** Single-path line art drawn on a 24x24 canvas, stroked in currentColor. */
  path: string
}

export type DoodlePlacement = {
  /** Sprite symbol id to reference. */
  icon: string
  /** Centre of the icon, in layout pixels. */
  x: number
  y: number
  /** Degrees, negative is counter-clockwise. */
  rotation: number
  scale: number
  opacity: number
  /** Rendered edge length in px (base cell glyph size * scale). */
  size: number
}

export type DoodleLayout = {
  seed: number
  width: number
  height: number
  cell: number
  placements: readonly DoodlePlacement[]
}

export type DoodleLayoutOptions = {
  width: number
  height: number
  /** Nominal grid cell edge in px. Clamped into [MIN_CELL, MAX_CELL]. */
  cell?: number
  /** Share of cells that receive an icon, 0..1. */
  fill?: number
  /** Hard ceiling on rendered instances, whatever the viewport. */
  maxIcons?: number
  icons?: readonly DoodleIcon[]
}

/* ---------------------------------------------------------------- tuning */

export const MIN_CELL = 80
export const MAX_CELL = 140
export const DEFAULT_CELL = 108
export const DEFAULT_FILL = 0.68
export const DEFAULT_MAX_ICONS = 220
/** Extra canvas below the fold so scrolling never reveals a bare edge. */
export const CANVAS_SCALE = 2
/** Jitter is +/- this share of the cell, keeping glyphs off a rigid grid. */
const JITTER = 0.3
const ROTATION_RANGE = 25
const SCALE_MIN = 0.7
const SCALE_MAX = 1.3
const OPACITY_MIN = 0.08
const OPACITY_MAX = 0.18
/** Glyph edge relative to the cell, before the per-icon scale roll. */
const GLYPH_RATIO = 0.52

/**
 * Query keys that must never reach the seed: they change while the user
 * sits on one view, and a pattern that reshuffles mid-scroll is exactly
 * the flicker this feature exists to avoid.
 */
const TRANSIENT_PARAMS = new Set([
  'scroll', 'scrolltop', 'scrollpos', 'pos', 'offset', 'y',
  't', 'ts', 'time', 'timestamp', 'now', 'cachebust', 'cb', '_', 'v', 'rand', 'nonce',
  'i', 'index', 'frame', 'photo', 'fbclid', 'gclid', 'ref', 'referrer', 'session', 'sid',
])
const isTransient = (key: string) => {
  const k = key.toLowerCase()
  return TRANSIENT_PARAMS.has(k) || k.startsWith('utm_')
}

/* ------------------------------------------------------------ icon sprite */

/**
 * Photography line art on a 24x24 grid. Single-path, no fill, stroked in
 * currentColor so one CSS variable tints the whole field for light and
 * dark themes alike. Order is part of the contract: icon choice indexes
 * into this array, so reordering would repaint every existing URL.
 */
export const DOODLE_ICONS: readonly DoodleIcon[] = Object.freeze([
  { id: 'dd-camera', path: 'M3 8h3l1.5-2.5h9L18 8h3v11H3V8Zm9 2.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z' },
  { id: 'dd-aperture', path: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0 5 8.5M22 12h-9.8M17 20.6 12.2 12M7 20.6l5-8.6M2 12h9.9M7 3.4 11.9 12' },
  { id: 'dd-film', path: 'M3 5h18v14H3V5Zm0 3.5h3m-3 3.5h3m-3 3.5h3m12-7h3m-3 3.5h3m-3 3.5h3M9 5v14m6-14v14' },
  { id: 'dd-lens', path: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm-2 3.2a3 3 0 0 1 2-1.1' },
  { id: 'dd-mountain', path: 'M2 19h20L15 7l-4 6.5L8.5 10 2 19Z' },
  { id: 'dd-sun', path: 'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9m10.4 10.4 1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9' },
  { id: 'dd-polaroid', path: 'M4 3h16v18H4V3Zm0 13h16M7.5 6.5h9v6h-9v-6Z' },
  { id: 'dd-stack', path: 'M7 3h14v14H7V3Zm-4 4v14h14M10.5 9.5l3 3.5 2.5-2.5 2.5 3.5h-11l3-4.5Z' },
  { id: 'dd-tripod', path: 'M12 3h1m-4 0h10v4H8V3Zm4 4v6m0 0-5 8m5-8 5 8m-8-3.5h6' },
  { id: 'dd-flash', path: 'M5 3h14l-3 5h3l-9 13 2.5-9H5l3-5H5V3Z' },
  { id: 'dd-shutter', path: 'M12 2.5v19M2.5 12h19M5.2 5.2l13.6 13.6M18.8 5.2 5.2 18.8M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z' },
  { id: 'dd-frame', path: 'M3 4h18v16H3V4Zm3.5 3.5h11v9h-11v-9ZM3 4l3.5 3.5M21 4l-3.5 3.5M3 20l3.5-3.5M21 20l-3.5-3.5' },
  { id: 'dd-moon', path: 'M20 14.5A8.5 8.5 0 1 1 10.2 4a7 7 0 0 0 9.8 10.5Z' },
  { id: 'dd-eye', path: 'M2 12s3.8-6 10-6 10 6 10 6-3.8 6-10 6-10-6-10-6Zm10-2.6a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z' },
])

/* ------------------------------------------------------------------- seed */

/**
 * Reduces a URL to the part that should define its pattern: the pathname
 * plus non-transient query params, sorted so that `?a=1&b=2` and
 * `?b=2&a=1` are one view, not two. The origin and the hash fragment are
 * dropped — the same album served from localhost, preview, or production
 * must look the same, and `#frame-3` is navigation within a view.
 *
 * Accepts absolute URLs, bare paths, and junk; never throws.
 */
export const normalizeSeedUrl = (input: string | null | undefined): string => {
  if (typeof input !== 'string') return '/'
  const raw = input.trim()
  if (!raw) return '/'

  let pathname = raw
  let search = ''
  // `URL` handles absolute inputs; the base makes bare paths parse too.
  try {
    const parsed = new URL(raw, 'http://d')
    pathname = parsed.pathname
    search = parsed.search
  } catch {
    // Malformed percent-escapes and the like: fall back to a manual split
    // so a broken URL still seeds something stable rather than throwing.
    const hashCut = raw.indexOf('#')
    const noHash = hashCut === -1 ? raw : raw.slice(0, hashCut)
    const queryCut = noHash.indexOf('?')
    pathname = queryCut === -1 ? noHash : noHash.slice(0, queryCut)
    search = queryCut === -1 ? '' : noHash.slice(queryCut)
  }

  // Trailing slashes are the same view; the root stays "/".
  pathname = pathname.replace(/\/+$/, '') || '/'

  const kept: [string, string][] = []
  try {
    const params = new URLSearchParams(search)
    params.forEach((value, key) => {
      if (!isTransient(key)) kept.push([key, value])
    })
  } catch {
    // Unparseable query: the pathname alone still seeds deterministically.
  }
  kept.sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))

  // URLSearchParams supplies an unambiguous canonical encoding. Joining
  // raw key/value strings would make `/a?x=a%26y%3Db` collide with
  // `/a?x=a&y=b`, despite those being distinct relevant queries.
  const canonical = new URLSearchParams(kept).toString()
  return canonical ? `${pathname}?${canonical}` : pathname
}

/**
 * FNV-1a, 32-bit. Chosen over djb2 for slightly better avalanche on short
 * ASCII paths, and over any crypto hash because this needs zero deps and
 * runs in microseconds. Returns an unsigned integer so the value is
 * stable across platforms and safe to feed the PRNG.
 */
export const hashSeed = (value: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    // hash *= 16777619, via shifts to stay inside 32-bit integer maths.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/** Convenience: URL string straight to the numeric seed. */
export const seedFromUrl = (url: string | null | undefined): number => hashSeed(normalizeSeedUrl(url))

/* ------------------------------------------------------------------- prng */

/**
 * mulberry32 — 32 bits of state, one multiply-xorshift round per draw.
 * Fast, dependency-free, and good enough for visual scatter. Returns
 * floats in [0, 1). A seed of 0 is fine: the constant increment walks the
 * state off zero on the first call.
 */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ----------------------------------------------------------------- layout */

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const finite = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
/** Three decimals is below one device pixel and keeps the DOM string small. */
const round3 = (value: number) => Math.round(value * 1000) / 1000

/**
 * Walks a grid over the canvas and rolls, per cell: place-or-skip, which
 * icon, jitter, rotation, scale, opacity. Draw order is fixed row-major,
 * so the same seed reproduces the same field exactly.
 *
 * A skipped cell consumes exactly one draw (the fill test) and no more,
 * so the stream stays in lockstep with the grid walk while the fill
 * probability keeps its meaning.
 *
 * Over-budget layouts are thinned with an even stride rather than
 * truncated, so a capped ultrawide keeps icons all the way to the bottom
 * instead of crowding the first rows.
 */
export const buildDoodleLayout = (seed: number, options: DoodleLayoutOptions): DoodleLayout => {
  const icons = options.icons ?? DOODLE_ICONS
  const cell = clamp(Math.round(finite(options.cell, DEFAULT_CELL)), MIN_CELL, MAX_CELL)
  const width = Math.max(0, Math.floor(finite(options.width, 0)))
  const height = Math.max(0, Math.floor(finite(options.height, 0)))
  const fill = clamp(finite(options.fill, DEFAULT_FILL), 0, 1)
  const maxIcons = Math.max(0, Math.floor(finite(options.maxIcons, DEFAULT_MAX_ICONS)))
  const safeSeed = (finite(seed, 0) | 0) >>> 0

  const empty: DoodleLayout = { seed: safeSeed, width, height, cell, placements: [] }
  // A zero-area viewport (SSR, a collapsed pane, a hidden tab on some
  // engines) has nothing to lay out; bail before dividing by anything.
  if (width <= 0 || height <= 0 || icons.length === 0 || maxIcons === 0 || fill === 0) return empty

  const cols = Math.max(1, Math.ceil(width / cell))
  const rows = Math.max(1, Math.ceil(height / cell))
  const next = mulberry32(safeSeed)
  const glyph = cell * GLYPH_RATIO
  const candidates: DoodlePlacement[] = []

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      // One draw decides occupancy; skipping early keeps sparse layouts cheap.
      if (next() >= fill) continue
      const icon = icons[Math.floor(next() * icons.length)] ?? icons[0]
      const jitterX = (next() * 2 - 1) * JITTER * cell
      const jitterY = (next() * 2 - 1) * JITTER * cell
      const rotation = (next() * 2 - 1) * ROTATION_RANGE
      const scale = SCALE_MIN + next() * (SCALE_MAX - SCALE_MIN)
      const opacity = OPACITY_MIN + next() * (OPACITY_MAX - OPACITY_MIN)
      candidates.push({
        icon: icon.id,
        x: round3(col * cell + cell / 2 + jitterX),
        y: round3(row * cell + cell / 2 + jitterY),
        rotation: round3(rotation),
        scale: round3(scale),
        opacity: round3(opacity),
        size: round3(glyph * scale),
      })
    }
  }

  if (candidates.length <= maxIcons) return { seed: safeSeed, width, height, cell, placements: candidates }

  // Even stride thinning: keep every nth candidate across the whole
  // canvas. Deterministic, and density drops uniformly instead of the
  // field ending halfway down the page.
  const stride = candidates.length / maxIcons
  const thinned: DoodlePlacement[] = []
  for (let i = 0; i < maxIcons; i += 1) {
    const pick = candidates[Math.floor(i * stride)]
    if (pick) thinned.push(pick)
  }
  return { seed: safeSeed, width, height, cell, placements: thinned }
}

/**
 * Responsive cell size: tighter grids on phones, roomier on desktops, so
 * the motif reads at the same visual density on both.
 */
export const responsiveCell = (viewportWidth: number): number => {
  const w = finite(viewportWidth, 0)
  if (w <= 0) return DEFAULT_CELL
  if (w < 480) return MIN_CELL
  if (w < 900) return 96
  if (w < 1600) return DEFAULT_CELL
  return 124
}

/**
 * Buckets a dimension so that the layout is only rebuilt when the
 * viewport moves materially. Mobile browsers resize by a few pixels on
 * every URL-bar collapse; regenerating 200 placements for that is waste.
 */
export const quantizeViewport = (value: number, step = 120): number => {
  const v = Math.max(0, finite(value, 0))
  const s = Math.max(1, Math.floor(finite(step, 120)))
  return Math.ceil(v / s) * s
}

/**
 * One-call convenience used by the island: URL + viewport in, layout out.
 * The canvas is CANVAS_SCALE taller than the viewport so a scrolled page
 * keeps meeting pattern rather than empty background.
 */
export const doodleLayoutForUrl = (
  url: string | null | undefined,
  viewportWidth: number,
  viewportHeight: number,
  overrides: Partial<DoodleLayoutOptions> = {},
): DoodleLayout => {
  const width = quantizeViewport(viewportWidth)
  const height = quantizeViewport(viewportHeight) * CANVAS_SCALE
  return buildDoodleLayout(seedFromUrl(url), {
    width,
    height,
    cell: responsiveCell(viewportWidth),
    ...overrides,
  })
}
