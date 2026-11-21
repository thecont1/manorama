import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import approvedGround from './assets/gallery-ground'

/**
 * The background is deliberately inert and independent of the browser viewport.
 * These tests inspect the visitor-facing SVG rather than comparing the complete
 * HTML: useId-derived pattern ids are allowed to differ between renders, while
 * the approved path geometry, motif metadata, and fixed tile contract are not.
 */

type GroundRecord = {
  motifId: string
  placementId: string
  paths: string[]
}

type GroundManifest = {
  placements?: GroundRecord[]
  groups?: GroundRecord[]
  motifs?: GroundRecord[]
}

const manifest = approvedGround as unknown as GroundManifest | GroundRecord[]
const approvedRecords = (): GroundRecord[] => {
  const records = Array.isArray(manifest)
    ? manifest
    : manifest.placements ?? manifest.groups ?? manifest.motifs ?? []
  return records.map((record) => ({
    motifId: record.motifId,
    placementId: record.placementId,
    paths: [...record.paths],
  }))
}

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let SeededDoodleBackground: (props: Record<string, unknown>) => unknown

beforeAll(async () => {
  const window = new Window({ width: 1440, height: 900, url: 'http://localhost/' })
  previousWindow = globals.window
  globals.window = window
  globals.document = window.document
  SeededDoodleBackground = (await import('./islands/SeededDoodleBackground')).default as typeof SeededDoodleBackground
})

afterAll(() => {
  globals.window = previousWindow
})

const render = (props: Record<string, unknown> = {}) => String(SeededDoodleBackground({ enabled: true, ...props }))

const inspect = (html: string) => {
  const parserWindow = new Window()
  parserWindow.document.body.innerHTML = html
  const svg = parserWindow.document.querySelector('svg')
  if (!svg) throw new Error('background did not render an SVG')
  const groups = Array.from(svg.querySelectorAll('[data-gallery-ground-motif]') as unknown as Element[])
  return { parserWindow, svg, groups }
}

const geometry = (groups: Element[]) => groups.map((group) => ({
  motifId: group.getAttribute('data-gallery-ground-motif') ?? '',
  placementId: group.getAttribute('data-gallery-ground-placement') ?? '',
  paths: Array.from(group.querySelectorAll('path')).map((path) => path.getAttribute('d') ?? ''),
}))

const sortedGeometry = (groups: Element[]) => geometry(groups).sort((a, b) =>
  `${a.placementId}:${a.motifId}`.localeCompare(`${b.placementId}:${b.motifId}`))

const sortedApprovedGeometry = () => approvedRecords().sort((a, b) =>
  `${a.placementId}:${a.motifId}`.localeCompare(`${b.placementId}:${b.motifId}`))

describe('SeededDoodleBackground markup', () => {
  test('renders an inert CSS-sized SVG with the fixed approved tile contract', () => {
    const { svg } = inspect(render())
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('role')).toBe('presentation')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.hasAttribute('data-doodle-bg')).toBe(true)
    expect(svg.getAttribute('data-doodle-seed')).toBe('1843')
    expect(svg.getAttribute('data-doodle-count')).toBe('80')
    expect(svg.getAttribute('data-doodle-artwork')).toBe('optical-marginalia-v1')
    expect(svg.getAttribute('width')).toBe('100%')
    expect(svg.getAttribute('height')).toBe('100%')
    expect(svg.getAttribute('viewBox')).toBeNull()
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull()
  })

  test('uses a fixed 256px pattern with the approved artwork uniformly quarter-scaled', () => {
    const { svg } = inspect(render())
    const pattern = svg.querySelector('pattern')
    expect(pattern).not.toBeNull()
    expect(pattern!.getAttribute('patternUnits')).toBe('userSpaceOnUse')
    expect(pattern!.getAttribute('width')).toBe('256')
    expect(pattern!.getAttribute('height')).toBe('256')
    expect(pattern!.getAttribute('viewBox')).toBeNull()
    const scale = pattern!.querySelector('[data-gallery-ground-scale]')
    expect(scale!.getAttribute('data-gallery-ground-scale')).toBe('0.25')
    expect(scale!.getAttribute('transform')).toBe('scale(0.25)')
    expect(scale!.querySelectorAll('[data-gallery-ground-motif]')).toHaveLength(92)
    expect(pattern!.querySelectorAll('[transform]')).toHaveLength(1)

    const id = pattern!.getAttribute('id')
    expect(id).toBeTruthy()
    const fills = Array.from(svg.querySelectorAll('[fill]')).map((element) => element.getAttribute('fill'))
    expect(fills).toContain(`url(#${id})`)
    expect(svg.querySelectorAll('use')).toHaveLength(0)
    expect(svg.querySelectorAll('symbol')).toHaveLength(0)
  })

  test('contains the approved baked groups for 80 placements, wrapped at tile edges, with exact path geometry', () => {
    const { svg, groups } = inspect(render())
    const expected = sortedApprovedGeometry()
    // The manifest contains wrapped edge copies, so its 92 groups represent
    // exactly 80 unique placement ids. The root data count remains 80.
    expect(expected).toHaveLength(92)
    expect(new Set(expected.map((record) => record.placementId)).size).toBe(80)
    expect(new Set(expected.map((record) => record.motifId)).size).toBe(24)
    expect(new Set(groups.map((group) => group.getAttribute('data-gallery-ground-motif'))).size).toBe(24)
    expect(new Set(groups.map((group) => group.getAttribute('data-gallery-ground-placement'))).size).toBe(80)
    expect(groups).toHaveLength(92)
    expect(sortedGeometry(groups)).toEqual(expected)
  })

  test('retains currentColor and 3-unit round source strokes, scaled to 0.75px without non-scaling strokes', () => {
    const { svg } = inspect(render())
    const paths = Array.from(svg.querySelectorAll('path'))
    expect(paths.length).toBeGreaterThan(0)
    expect(Number(svg.querySelector('[data-gallery-ground-scale]')!.getAttribute('data-gallery-ground-scale')) * approvedGround.strokeWidth).toBe(0.75)
    for (const path of paths) {
      expect(path.getAttribute('fill')).toBe('none')
      expect(path.getAttribute('stroke')).toBe('currentColor')
      expect(path.getAttribute('stroke-width')).toBe('3')
      expect(path.getAttribute('stroke-linecap')).toBe('round')
      expect(path.getAttribute('stroke-linejoin')).toBe('round')
      expect(path.getAttribute('vector-effect')).toBeNull()
    }
    expect(svg.querySelectorAll('filter')).toHaveLength(0)
    expect(svg.querySelectorAll('feGaussianBlur')).toHaveLength(0)
    expect(svg.querySelectorAll('image')).toHaveLength(0)
    expect(svg.querySelectorAll('foreignObject')).toHaveLength(0)
  })

  test('does not let URL, history-like props, or icon-budget props alter the baked artwork', () => {
    const baseline = sortedGeometry(inspect(render({ url: '/mahesh/kashi' })).groups)
    expect(sortedGeometry(inspect(render({ url: '/mahesh/goa', maxIcons: 1 })).groups)).toEqual(baseline)
    expect(sortedGeometry(inspect(render({ url: '/another/gallery?mode=single' })).groups)).toEqual(baseline)
  })

  test('renders nothing at all when disabled', () => {
    expect(SeededDoodleBackground({ enabled: false })).toBeNull()
  })

  test('pattern ids may differ, but each id is locally wired to the same geometry', () => {
    const first = inspect(render())
    const second = inspect(render())
    const firstId = first.svg.querySelector('pattern')?.getAttribute('id')
    const secondId = second.svg.querySelector('pattern')?.getAttribute('id')
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(first.svg.querySelector(`[fill="url(#${firstId})"]`)).not.toBeNull()
    expect(second.svg.querySelector(`[fill="url(#${secondId})"]`)).not.toBeNull()
    expect(sortedGeometry(first.groups)).toEqual(sortedGeometry(second.groups))
  })

  test('carries no pointer-grabbing attributes', () => {
    const { svg } = inspect(render())
    expect(svg.outerHTML).not.toContain('onclick')
    expect(svg.outerHTML).not.toContain('tabindex')
  })
})
