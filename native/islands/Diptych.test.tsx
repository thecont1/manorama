import { describe, expect, test } from 'bun:test'
import Diptych, {
  diptychFrameSize,
  resolveDiptychLayout,
  type DiptychFrame,
  type DiptychSegment,
} from './Diptych'

const landscape: DiptychFrame = {
  id: 'landscape',
  src: '/landscape.jpg',
  width: 2400,
  height: 1600,
  alt: 'A landscape photograph',
}

const portrait: DiptychFrame = {
  id: 'portrait',
  src: '/portrait.jpg',
  width: 1600,
  height: 2400,
  alt: 'A portrait photograph',
}

const left: DiptychSegment = { x: 0, y: 0, width: 680, height: 900 }
const right: DiptychSegment = { x: 760, y: 0, width: 680, height: 900 }
const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6)

describe('diptychFrameSize', () => {
  test('contains landscape and portrait frames without changing their aspect ratios', () => {
    const landscapeSize = diptychFrameSize(landscape, left, 1)
    const portraitSize = diptychFrameSize(portrait, right, 1)

    near(landscapeSize.width / landscapeSize.height, landscape.width / landscape.height)
    near(portraitSize.width / portraitSize.height, portrait.width / portrait.height)
    expect(landscapeSize.width).toBeLessThanOrEqual(left.width)
    expect(landscapeSize.height).toBeLessThanOrEqual(left.height)
    expect(portraitSize.width).toBeLessThanOrEqual(right.width)
    expect(portraitSize.height).toBeLessThanOrEqual(right.height)
  })

  test('never requests more source pixels than the photograph provides', () => {
    const tiny = { width: 120, height: 80 }
    for (const dpr of [1, 1.5, 2, 3]) {
      const size = diptychFrameSize(tiny, left, dpr)
      const effectiveDpr = Math.min(dpr, 2)
      expect(size.width * effectiveDpr).toBeLessThanOrEqual(tiny.width)
      expect(size.height * effectiveDpr).toBeLessThanOrEqual(tiny.height)
    }
  })

  test('rejects invalid frame or segment dimensions instead of emitting NaN', () => {
    expect(diptychFrameSize({ width: 0, height: 100 }, left)).toEqual({ width: 0, height: 0 })
    expect(diptychFrameSize(landscape, { width: Number.NaN, height: 900 })).toEqual({ width: 0, height: 0 })
  })
})

describe('resolveDiptychLayout', () => {
  test('aligns the pair to physical segment coordinates regardless of adapter order', () => {
    const layout = resolveDiptychLayout([landscape, portrait], [right, left], 1)
    expect(layout?.mode).toBe('diptych')
    if (layout?.mode !== 'diptych') throw new Error('Expected diptych layout')
    expect(layout.segments).toEqual([left, right])
  })

  test('falls back to one-at-a-time when only one frame is usable', () => {
    const invalid = { ...portrait, id: 'invalid', src: '', width: 0 }
    const layout = resolveDiptychLayout([invalid, landscape], [left, right], 1)
    expect(layout?.mode).toBe('single')
  })

  test('falls back to one-at-a-time on a single segment', () => {
    const layout = resolveDiptychLayout([landscape, portrait], [left], 1, 1)
    expect(layout?.mode).toBe('single')
    if (layout?.mode !== 'single') throw new Error('Expected single layout')
    expect(layout.frameIndex).toBe(1)
    near(layout.size.width / layout.size.height, portrait.width / portrait.height)
  })

  test('falls back to one-at-a-time when more than two usable frames are supplied', () => {
    const third = { ...landscape, id: 'third', src: '/third.jpg' }
    const layout = resolveDiptychLayout([landscape, portrait, third], [left, right], 1, 2)
    expect(layout?.mode).toBe('single')
    if (layout?.mode !== 'single') throw new Error('Expected single layout')
    expect(layout.frameIndex).toBe(2)
  })

  test('returns no stage when neither a usable frame nor a usable segment exists', () => {
    expect(resolveDiptychLayout([], [left], 1)).toBeNull()
    expect(resolveDiptychLayout([landscape], [], 1)).toBeNull()
  })
})

describe('Diptych markup', () => {
  test('renders two photographs and no controls in a two-segment stage', () => {
    const html = String(Diptych({ frames: [landscape, portrait], segments: [left, right], dpr: 1 }))
    expect(html).toContain('data-diptych-mode="diptych"')
    expect(html.match(/data-diptych-frame=/g)).toHaveLength(2)
    expect(html).toContain('left:760px')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('object-fit:cover')
  })

  test('single-segment fallback renders only the active photograph with its own ratio', () => {
    const html = String(Diptych({ frames: [landscape, portrait], segments: [left], activeIndex: 1, dpr: 1 }))
    expect(html).toContain('data-diptych-mode="single"')
    expect(html.match(/data-diptych-frame=/g)).toHaveLength(1)
    expect(html).toContain('src="/portrait.jpg"')
    expect(html).not.toContain('src="/landscape.jpg"')
  })
})
