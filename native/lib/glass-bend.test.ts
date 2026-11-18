import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { initGlassBend } from './glass-bend'

type FakeMql = { matches: boolean; listeners: (() => void)[]; addEventListener: (t: string, l: () => void) => void }

const mql = (matches = false): FakeMql => ({
  matches,
  listeners: [],
  addEventListener(_t, l) {
    this.listeners.push(l)
  },
})

/// A rAF queue the test pumps manually — timestamps are the frame clock.
const fakeRaf = () => {
  const queue: ((t: number) => void)[] = []
  return {
    queue,
    requestAnimationFrame: (cb: (t: number) => void) => {
      queue.push(cb)
      return queue.length
    },
    cancelAnimationFrame: () => queue.splice(0, queue.length),
    /// Run queued callbacks as one frame at `time`, collecting re-queues.
    step(time: number) {
      const due = queue.splice(0, queue.length)
      for (const cb of due) cb(time)
    },
  }
}

const fakeDoc = () => {
  const dom = new Window({ width: 393, height: 873, url: 'http://localhost/' })
  const doc = dom.document as unknown as Document
  return { root: doc.documentElement, body: doc.body, doc }
}

const androidWin = (overrides: Record<string, unknown> = {}) => ({
  navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36' },
  SVGFEDisplacementMapElement: function () {},
  CSS: { supports: (condition: string) => /url/.test(condition) },
  matchMedia: () => mql(false),
  ...overrides,
})

const deps = (overrides: Record<string, unknown> = {}) => ({
  mapUrl: () => 'data:image/png;base64,AAAA',
  ...overrides,
})

describe('glass bend — gating', () => {
  test('non-Android UA never gets the marker or the filter', () => {
    const raf = fakeRaf()
    const { doc, root } = fakeDoc()
    const win = androidWin({ navigator: { userAgent: 'Mozilla/5.0 (iPhone)' }, requestAnimationFrame: raf.requestAnimationFrame })
    const report = initGlassBend({ win, doc, ...deps() })
    expect(report.supported).toBe(false)
    expect(root.dataset.androidGlass).toBeUndefined()
    expect(doc.documentElement.querySelector('svg')).toBeNull()
  })

  test('missing feDisplacementMap support never gets the marker', () => {
    const raf = fakeRaf()
    const { doc, root } = fakeDoc()
    const win = androidWin({ SVGFEDisplacementMapElement: undefined, requestAnimationFrame: raf.requestAnimationFrame })
    const report = initGlassBend({ win, doc, ...deps() })
    expect(report.supported).toBe(false)
    expect(root.dataset.androidGlass).toBeUndefined()
  })

  test('marker lands only after the no-bend baseline is measured', () => {
    const raf = fakeRaf()
    const { doc, root } = fakeDoc()
    const win = androidWin({ requestAnimationFrame: raf.requestAnimationFrame, cancelAnimationFrame: raf.cancelAnimationFrame })
    const report = initGlassBend({ win, doc, ...deps() })
    expect(report.supported).toBe(true)
    expect(root.dataset.androidGlass).toBeUndefined()
    for (let t = 16; t <= 1300; t += 16) raf.step(t)
    expect(report.baselineMs).not.toBeNull()
    expect(root.dataset.androidGlass).toBe('1')
    expect(report.enabled).toBe(true)
    expect(doc.documentElement.querySelector('svg #manorama-bend')).not.toBeNull()
  })

  test('a segmented viewport keeps the marker off until it unfolds', () => {
    const raf = fakeRaf()
    const segments = mql(true)
    const { doc, root } = fakeDoc()
    const win = androidWin({
      matchMedia: () => segments,
      requestAnimationFrame: raf.requestAnimationFrame,
      cancelAnimationFrame: raf.cancelAnimationFrame,
    })
    const report = initGlassBend({ win, doc, ...deps() })
    for (let t = 16; t <= 1300; t += 16) raf.step(t)
    expect(root.dataset.androidGlass).toBeUndefined()
    expect(report.enabled).toBe(false)
    expect(report.segmented).toBe(true)
    segments.matches = false
    for (const l of segments.listeners) l()
    expect(root.dataset.androidGlass).toBe('1')
  })

  test('three continuous seconds over budget trips the session', () => {
    const raf = fakeRaf()
    const { doc, root } = fakeDoc()
    const win = androidWin({ requestAnimationFrame: raf.requestAnimationFrame, cancelAnimationFrame: raf.cancelAnimationFrame })
    const report = initGlassBend({ win, doc, ...deps() })
    for (let t = 16; t <= 1300; t += 16) raf.step(t)
    expect(root.dataset.androidGlass).toBe('1')
    // 40ms frames — over the 20ms budget and the 120% baseline cap.
    let t = 1300
    for (let i = 0; i < 80; i += 1) {
      t += 40
      raf.step(t)
    }
    expect(report.degraded).toBe(true)
    expect(root.dataset.androidGlass).toBeUndefined()
  })

  test('an over-budget spike under three seconds does not trip', () => {
    const raf = fakeRaf()
    const { doc, root } = fakeDoc()
    const win = androidWin({ requestAnimationFrame: raf.requestAnimationFrame, cancelAnimationFrame: raf.cancelAnimationFrame })
    const report = initGlassBend({ win, doc, ...deps() })
    for (let t = 16; t <= 1300; t += 16) raf.step(t)
    let t = 1300
    // 2s of slow frames, then recovery — the sustain clock resets.
    for (let i = 0; i < 50; i += 1) {
      t += 40
      raf.step(t)
    }
    t += 16
    raf.step(t)
    for (let i = 0; i < 100; i += 1) {
      t += 16
      raf.step(t)
    }
    expect(report.degraded).toBe(false)
    expect(root.dataset.androidGlass).toBe('1')
  })

  test('degradation is session-scoped — localStorage is never consulted', () => {
    const raf = fakeRaf()
    const { doc } = fakeDoc()
    const win = androidWin({ requestAnimationFrame: raf.requestAnimationFrame, cancelAnimationFrame: raf.cancelAnimationFrame })
    const reads: string[] = []
    const writes: string[] = []
    const storage = {
      getItem: (k: string) => (reads.push(k), null),
      setItem: (k: string) => writes.push(k),
    }
    ;(win as Record<string, unknown>).localStorage = storage
    initGlassBend({ win, doc, ...deps() })
    for (let t = 16; t <= 1300; t += 16) raf.step(t)
    let t = 1300
    for (let i = 0; i < 80; i += 1) {
      t += 40
      raf.step(t)
    }
    expect(reads).toEqual([])
    expect(writes).toEqual([])
  })
})
