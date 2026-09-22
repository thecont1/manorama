import { describe, expect, test } from 'bun:test'
import {
  CANVAS_SCALE,
  DEFAULT_MAX_ICONS,
  DOODLE_ICONS,
  MAX_CELL,
  MIN_CELL,
  buildDoodleLayout,
  doodleLayoutForUrl,
  hashSeed,
  mulberry32,
  normalizeSeedUrl,
  quantizeViewport,
  responsiveCell,
  seedFromUrl,
} from './doodle-background'

/**
 * The doodle background's whole promise is determinism: one URL, one
 * pattern, forever. These cover the seed derivation, the PRNG, the
 * placement algorithm's bounds, and the degenerate inputs that a real
 * viewport throws at it (SSR zero size, ultrawide, a hidden tab).
 */

const VIEWPORT = { width: 1440, height: 900 }

describe('normalizeSeedUrl', () => {
  test('keeps the path and drops the origin so every environment matches', () => {
    expect(normalizeSeedUrl('https://manorama.xyz/mahesh/kashi')).toBe('/mahesh/kashi')
    expect(normalizeSeedUrl('http://localhost:5173/mahesh/kashi')).toBe('/mahesh/kashi')
    expect(normalizeSeedUrl('/mahesh/kashi')).toBe('/mahesh/kashi')
  })

  test('a trailing slash is the same view', () => {
    expect(normalizeSeedUrl('/mahesh/kashi/')).toBe('/mahesh/kashi')
    expect(normalizeSeedUrl('/mahesh/kashi///')).toBe('/mahesh/kashi')
  })

  test('the root normalizes to a single slash', () => {
    expect(normalizeSeedUrl('/')).toBe('/')
    expect(normalizeSeedUrl('')).toBe('/')
    expect(normalizeSeedUrl('   ')).toBe('/')
    expect(normalizeSeedUrl(null)).toBe('/')
    expect(normalizeSeedUrl(undefined)).toBe('/')
  })

  test('the hash fragment never reaches the seed', () => {
    expect(normalizeSeedUrl('/a/b#frame-3')).toBe(normalizeSeedUrl('/a/b'))
    expect(normalizeSeedUrl('/a/b#frame-99')).toBe(normalizeSeedUrl('/a/b'))
  })

  test('transient params are stripped, meaningful ones kept', () => {
    expect(normalizeSeedUrl('/a?t=1699999999')).toBe('/a')
    expect(normalizeSeedUrl('/a?scroll=420&i=7')).toBe('/a')
    expect(normalizeSeedUrl('/a?utm_source=x&utm_campaign=y')).toBe('/a')
    expect(normalizeSeedUrl('/a?mode=strip')).toBe('/a?mode=strip')
  })

  test('query order does not matter', () => {
    expect(normalizeSeedUrl('/a?x=1&y=2')).toBe(normalizeSeedUrl('/a?y=2&x=1'))
  })

  test('canonical encoding keeps structurally different queries distinct', () => {
    expect(normalizeSeedUrl('/a?x=a%26y%3Db')).toBe('/a?x=a%26y%3Db')
    expect(normalizeSeedUrl('/a?x=a%26y%3Db')).not.toBe(normalizeSeedUrl('/a?x=a&y=b'))
  })

  test('repeated keys normalize independent of their input order', () => {
    expect(normalizeSeedUrl('/a?tag=z&tag=a')).toBe(normalizeSeedUrl('/a?tag=a&tag=z'))
  })

  test('a malformed url still yields a stable string instead of throwing', () => {
    const weird = normalizeSeedUrl('/a/%E0%A4%A?q=1#z')
    expect(typeof weird).toBe('string')
    expect(weird.length).toBeGreaterThan(0)
    expect(normalizeSeedUrl('/a/%E0%A4%A?q=1#z')).toBe(weird)
  })
})

describe('hashSeed', () => {
  test('is stable for the same string', () => {
    expect(hashSeed('/mahesh/kashi')).toBe(hashSeed('/mahesh/kashi'))
  })

  test('returns an unsigned 32-bit integer', () => {
    for (const s of ['', '/', '/a', '/mahesh/kashi', 'x'.repeat(500)]) {
      const h = hashSeed(s)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })

  test('different strings overwhelmingly differ', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i += 1) seen.add(hashSeed(`/owner/album-${i}`))
    // FNV-1a over 2000 distinct short paths should collide rarely if at all.
    expect(seen.size).toBeGreaterThan(1990)
  })

  test('a one-character change moves the hash', () => {
    expect(hashSeed('/a/b')).not.toBe(hashSeed('/a/c'))
  })
})

describe('mulberry32', () => {
  test('two generators on one seed emit the same stream', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    for (let i = 0; i < 100; i += 1) expect(a()).toBe(b())
  })

  test('different seeds diverge', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const left = Array.from({ length: 10 }, a)
    const right = Array.from({ length: 10 }, b)
    expect(left).not.toEqual(right)
  })

  test('every draw sits in [0, 1)', () => {
    const next = mulberry32(0xdeadbeef)
    for (let i = 0; i < 5000; i += 1) {
      const v = next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  test('a zero seed still produces a varied stream', () => {
    const next = mulberry32(0)
    const draws = new Set(Array.from({ length: 50 }, next))
    expect(draws.size).toBeGreaterThan(40)
  })

  test('the mean sits near 0.5', () => {
    const next = mulberry32(99)
    let total = 0
    for (let i = 0; i < 20000; i += 1) total += next()
    expect(Math.abs(total / 20000 - 0.5)).toBeLessThan(0.02)
  })
})

describe('buildDoodleLayout determinism', () => {
  test('the same seed and size reproduce an identical layout', () => {
    const a = buildDoodleLayout(4242, VIEWPORT)
    const b = buildDoodleLayout(4242, VIEWPORT)
    expect(a.placements).toEqual(b.placements)
    expect(a.placements.length).toBeGreaterThan(0)
  })

  test('different seeds produce visibly different fields', () => {
    const a = buildDoodleLayout(hashSeed('/mahesh/kashi'), VIEWPORT)
    const b = buildDoodleLayout(hashSeed('/mahesh/goa'), VIEWPORT)
    expect(a.placements).not.toEqual(b.placements)
  })

  test('the same URL produces the same field across "reloads"', () => {
    const first = doodleLayoutForUrl('https://manorama.xyz/mahesh/kashi', 1440, 900)
    const second = doodleLayoutForUrl('https://manorama.xyz/mahesh/kashi', 1440, 900)
    expect(first).toEqual(second)
  })

  test('a scroll/timestamp param does not repaint the field', () => {
    const plain = doodleLayoutForUrl('/mahesh/kashi', 1440, 900)
    const noisy = doodleLayoutForUrl('/mahesh/kashi?scroll=980&t=1699999999', 1440, 900)
    expect(noisy.placements).toEqual(plain.placements)
  })

  test('a different album produces a different field', () => {
    const kashi = doodleLayoutForUrl('/mahesh/kashi', 1440, 900)
    const goa = doodleLayoutForUrl('/mahesh/goa', 1440, 900)
    expect(goa.placements).not.toEqual(kashi.placements)
    expect(goa.seed).not.toBe(kashi.seed)
  })
})

describe('placement bounds', () => {
  const layout = buildDoodleLayout(hashSeed('/bounds'), { width: 1600, height: 1200 })

  test('every placement names a real sprite symbol', () => {
    const ids = new Set(DOODLE_ICONS.map((i) => i.id))
    for (const p of layout.placements) expect(ids.has(p.icon)).toBe(true)
  })

  test('rotation, scale and opacity stay inside the design range', () => {
    for (const p of layout.placements) {
      expect(p.rotation).toBeGreaterThanOrEqual(-25)
      expect(p.rotation).toBeLessThanOrEqual(25)
      expect(p.scale).toBeGreaterThanOrEqual(0.7)
      expect(p.scale).toBeLessThanOrEqual(1.3)
      expect(p.opacity).toBeGreaterThanOrEqual(0.08)
      expect(p.opacity).toBeLessThanOrEqual(0.18)
      expect(p.size).toBeGreaterThan(0)
    }
  })

  test('jitter never throws a glyph far outside the canvas', () => {
    const slack = layout.cell
    for (const p of layout.placements) {
      expect(p.x).toBeGreaterThan(-slack)
      expect(p.y).toBeGreaterThan(-slack)
      expect(p.x).toBeLessThan(layout.width + slack)
      expect(p.y).toBeLessThan(layout.height + slack)
    }
  })

  test('the field is sparse, not a solid grid', () => {
    const cells = Math.ceil(1600 / layout.cell) * Math.ceil(1200 / layout.cell)
    expect(layout.placements.length).toBeLessThan(cells)
    expect(layout.placements.length).toBeGreaterThan(cells * 0.3)
  })

  test('the icon set spans a useful variety', () => {
    const used = new Set(layout.placements.map((p) => p.icon))
    expect(used.size).toBeGreaterThan(5)
  })
})

describe('degenerate input', () => {
  test('a zero-area viewport lays out nothing instead of throwing', () => {
    expect(buildDoodleLayout(1, { width: 0, height: 0 }).placements).toEqual([])
    expect(buildDoodleLayout(1, { width: 1200, height: 0 }).placements).toEqual([])
    expect(buildDoodleLayout(1, { width: 0, height: 800 }).placements).toEqual([])
  })

  test('negative and non-finite sizes are clamped, not crashed on', () => {
    expect(buildDoodleLayout(1, { width: -500, height: -500 }).placements).toEqual([])
    expect(buildDoodleLayout(1, { width: Number.NaN, height: Number.NaN }).placements).toEqual([])
    expect(buildDoodleLayout(1, { width: Number.POSITIVE_INFINITY, height: 400 }).placements).toEqual([])
  })

  test('a non-finite seed still yields a stable layout', () => {
    const a = buildDoodleLayout(Number.NaN, VIEWPORT)
    const b = buildDoodleLayout(Number.NaN, VIEWPORT)
    expect(a.placements).toEqual(b.placements)
  })

  test('zero fill or zero budget renders nothing', () => {
    expect(buildDoodleLayout(1, { ...VIEWPORT, fill: 0 }).placements).toEqual([])
    expect(buildDoodleLayout(1, { ...VIEWPORT, maxIcons: 0 }).placements).toEqual([])
  })

  test('full fill places one icon in every cell', () => {
    const layout = buildDoodleLayout(7, { width: 400, height: 400, cell: 100, fill: 1, maxIcons: 10_000 })
    expect(layout.placements).toHaveLength(16)
  })

  test('an empty icon set degrades to an empty field', () => {
    expect(buildDoodleLayout(1, { ...VIEWPORT, icons: [] }).placements).toEqual([])
  })

  test('a viewport smaller than one cell still gets a cell', () => {
    const layout = buildDoodleLayout(3, { width: 20, height: 20, fill: 1, maxIcons: 100 })
    expect(layout.placements).toHaveLength(1)
  })

  test('cell size is clamped into the responsive range', () => {
    expect(buildDoodleLayout(1, { ...VIEWPORT, cell: 5 }).cell).toBe(MIN_CELL)
    expect(buildDoodleLayout(1, { ...VIEWPORT, cell: 9000 }).cell).toBe(MAX_CELL)
    expect(buildDoodleLayout(1, { ...VIEWPORT, cell: Number.NaN }).cell).toBeGreaterThanOrEqual(MIN_CELL)
  })
})

describe('performance guards', () => {
  test('an ultrawide canvas respects the icon cap', () => {
    const layout = buildDoodleLayout(hashSeed('/wide'), { width: 5120, height: 2880 })
    expect(layout.placements.length).toBeLessThanOrEqual(DEFAULT_MAX_ICONS)
    expect(layout.placements.length).toBeGreaterThan(100)
  })

  test('thinning keeps coverage across the whole canvas, not just the top', () => {
    const layout = buildDoodleLayout(hashSeed('/wide'), { width: 5120, height: 2880 })
    const lowest = Math.max(...layout.placements.map((p) => p.y))
    expect(lowest).toBeGreaterThan(2880 * 0.8)
  })

  test('the cap is honoured for an explicit budget too', () => {
    const layout = buildDoodleLayout(1, { width: 4000, height: 4000, maxIcons: 40 })
    expect(layout.placements.length).toBeLessThanOrEqual(40)
  })

  test('thinning stays deterministic', () => {
    const a = buildDoodleLayout(9, { width: 5120, height: 2880, maxIcons: 60 })
    const b = buildDoodleLayout(9, { width: 5120, height: 2880, maxIcons: 60 })
    expect(a.placements).toEqual(b.placements)
  })

  test('a large layout builds well inside a frame budget', () => {
    const started = performance.now()
    buildDoodleLayout(hashSeed('/perf'), { width: 3840, height: 2160 })
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('viewport helpers', () => {
  test('quantizing absorbs small resizes', () => {
    expect(quantizeViewport(1441)).toBe(quantizeViewport(1450))
    expect(quantizeViewport(900)).toBe(quantizeViewport(880))
  })

  test('quantizing still separates material changes', () => {
    expect(quantizeViewport(400)).not.toBe(quantizeViewport(1400))
  })

  test('quantizing never returns a negative or non-finite bucket', () => {
    expect(quantizeViewport(-10)).toBe(0)
    expect(quantizeViewport(Number.NaN)).toBe(0)
  })

  test('cell size responds to viewport width within the clamp', () => {
    expect(responsiveCell(390)).toBe(MIN_CELL)
    expect(responsiveCell(3440)).toBeLessThanOrEqual(MAX_CELL)
    expect(responsiveCell(0)).toBeGreaterThanOrEqual(MIN_CELL)
    expect(responsiveCell(1440)).toBeGreaterThanOrEqual(MIN_CELL)
  })

  test('the canvas is taller than the viewport for scroll headroom', () => {
    const layout = doodleLayoutForUrl('/a', 1440, 900)
    expect(layout.height).toBeGreaterThanOrEqual(quantizeViewport(900) * CANVAS_SCALE)
  })

  test('a resize that crosses a bucket rebuilds the field', () => {
    const small = doodleLayoutForUrl('/a', 600, 800)
    const large = doodleLayoutForUrl('/a', 1800, 800)
    expect(large.placements).not.toEqual(small.placements)
    // ...but the seed is untouched: it is the same view, just resized.
    expect(large.seed).toBe(small.seed)
  })
})

describe('the sprite set', () => {
  test('ships enough variety without bloating the DOM', () => {
    expect(DOODLE_ICONS.length).toBeGreaterThanOrEqual(8)
    expect(DOODLE_ICONS.length).toBeLessThanOrEqual(14)
  })

  test('ids are unique and path data is present', () => {
    const ids = new Set(DOODLE_ICONS.map((i) => i.id))
    expect(ids.size).toBe(DOODLE_ICONS.length)
    for (const icon of DOODLE_ICONS) {
      expect(icon.path.length).toBeGreaterThan(10)
      expect(icon.id.startsWith('dd-')).toBe(true)
    }
  })

  test('carries no hardcoded colour so themes can tint it', () => {
    for (const icon of DOODLE_ICONS) {
      expect(/#[0-9a-f]{3,6}|rgb\(/i.test(icon.path)).toBe(false)
    }
  })

  test('seedFromUrl composes normalization and hashing', () => {
    expect(seedFromUrl('https://x.test/a/b/?t=1#z')).toBe(hashSeed('/a/b'))
  })
})
