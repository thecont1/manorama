// G5 — Tier-A bend for the Android Chromium WebView, the only WebView that
// can refract a backdrop. `data-android-glass` is the bend gate: it is set
// only when the platform can run SVG feDisplacementMap through
// backdrop-filter, the viewport is a single segment, and the session's
// frame budget is holding. Degradation is session-scoped by design — a
// photo-decode stall must not become a permanent kill switch, so nothing
// here touches localStorage.

const MARKER = 'androidGlass'
const BEND_FILTER_ID = 'manorama-bend'
const DISPLACEMENT_SCALE = 10
const FRAME_BUDGET_MS = 20
const SUSTAINED_MS = 3000
const BASELINE_MS = 1200
const SEGMENT_QUERIES = [
  '(horizontal-viewport-segments: 2)',
  '(vertical-viewport-segments: 2)',
]

export interface GlassBendReport {
  readonly supported: boolean
  readonly enabled: boolean
  readonly degraded: boolean
  readonly segmented: boolean
  readonly baselineMs: number | null
}

interface BendWindow {
  navigator: { userAgent: string }
  SVGFEDisplacementMapElement?: unknown
  CSS?: { supports?: (condition: string) => boolean }
  matchMedia?: (query: string) => {
    matches: boolean
    addEventListener?: (type: string, listener: () => void) => void
    addListener?: (listener: () => void) => void
  }
  requestAnimationFrame?: (cb: (time: number) => void) => number
  cancelAnimationFrame?: (id: number) => void
}

export interface GlassBendDeps {
  win?: BendWindow
  doc?: Document
  // Production renders the displacement map on a canvas; tests inject a
  // data URL so the DOM environment never needs a 2d context.
  mapUrl?: (doc: Document) => string | null
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/// The displacement map: mid-grey is identity, the channels push outward
/// toward each edge so the backdrop reads as bent at the glass rim while
/// the centre stays flat. One 256×256 ImageData fill at init, no assets.
const canvasDisplacementMap = (doc: Document): string | null => {
  const canvas = doc.createElement('canvas')
  const size = 256
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext?.('2d')
  if (!context) return null
  const image = context.createImageData(size, size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / (size - 1) - 0.5
      const ny = y / (size - 1) - 0.5
      // Pull is strongest at the rim and eases to identity ~40% in — a
      // lens edge, not a uniform shift.
      const dx = Math.sign(nx) * smoothstep(0.1, 0.5, Math.abs(nx))
      const dy = Math.sign(ny) * smoothstep(0.1, 0.5, Math.abs(ny))
      const i = (y * size + x) * 4
      image.data[i] = 128 + 64 * dx
      image.data[i + 1] = 128 + 64 * dy
      image.data[i + 2] = 128
      image.data[i + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

const supportsBend = (win: BendWindow): boolean => {
  if (!/Android/.test(win.navigator.userAgent)) return false
  if (typeof win.SVGFEDisplacementMapElement !== 'function') return false
  const supports = win.CSS?.supports
  if (!supports) return false
  return (
    supports('backdrop-filter: url(#a)') === true ||
    supports('-webkit-backdrop-filter: url(#a)') === true
  )
}

export const initGlassBend = (deps: GlassBendDeps = {}): GlassBendReport => {
  const report = {
    supported: false,
    enabled: false,
    degraded: false,
    segmented: false,
    baselineMs: null as number | null,
  }
  const win = deps.win ?? (typeof window === 'undefined' ? undefined : (window as unknown as BendWindow))
  const doc = deps.doc ?? (typeof document === 'undefined' ? undefined : document)
  if (!win?.navigator || !doc) return report
  const root = doc.documentElement

  if (!supportsBend(win) || !win.requestAnimationFrame || !win.matchMedia) {
    return report
  }
  report.supported = true

  const url = (deps.mapUrl ?? canvasDisplacementMap)(doc)
  if (!url) return report

  const segmentQueries = SEGMENT_QUERIES.map((query) => win.matchMedia!(query))
  const isSegmented = () => segmentQueries.some((mql) => mql.matches)

  // The filter lives in the document — backdrop-filter url() resolves
  // fragment ids against the element's own document.
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
  svg.innerHTML =
    `<filter id="${BEND_FILTER_ID}" x="-5%" y="-5%" width="110%" height="110%">` +
    `<feImage href="${url}" xlink:href="${url}" preserveAspectRatio="none" result="map"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${DISPLACEMENT_SCALE}" ` +
    `xChannelSelector="R" yChannelSelector="G"/>` +
    `</filter>`
  // documentElement — not body — because the Workers ambient types this
  // repo compiles against give `body` the fetch mixin, not an Element.
  doc.documentElement.appendChild(svg as unknown as Node)

  const apply = () => {
    report.segmented = isSegmented()
    // The marker stays off until the no-bend baseline is measured, so the
    // baseline is never contaminated by the paint it is compared against.
    report.enabled = report.baselineMs !== null && !report.segmented && !report.degraded
    if (report.enabled) root.dataset[MARKER] = '1'
    else delete root.dataset[MARKER]
  }

  // Session-scoped degradation: a frame over max(20ms, 120% of the
  // same-session no-bend baseline) is over budget; three continuous
  // seconds of that while bend is mounted trips the session off. All
  // timestamps share the rAF clock.
  let last = 0
  let baselineEnd: number | null = null
  let baselineSum = 0
  let baselineCount = 0
  let overSince: number | null = null

  const trip = () => {
    report.degraded = true
    apply()
    if (win.cancelAnimationFrame) win.cancelAnimationFrame(rafId)
  }

  const tick = (time: number) => {
    if (report.degraded) return
    baselineEnd ??= time + BASELINE_MS
    if (last > 0) {
      const delta = time - last
      if (report.baselineMs === null) {
        baselineSum += delta
        baselineCount += 1
        if (time >= baselineEnd) {
          report.baselineMs = baselineCount > 0 ? baselineSum / baselineCount : 0
          apply()
        }
      } else if (report.enabled) {
        const budget = Math.max(FRAME_BUDGET_MS, report.baselineMs * 1.2)
        if (delta > budget) {
          overSince ??= time
          if (time - overSince >= SUSTAINED_MS) {
            trip()
            return
          }
        } else {
          overSince = null
        }
      }
    }
    last = time
    rafId = win.requestAnimationFrame!(tick)
  }
  let rafId = win.requestAnimationFrame(tick)

  // Fold yields to the flat tier while the viewport is segmented and
  // bends again when it unfolds — unless the session already degraded.
  const onSegmentChange = () => {
    if (!report.degraded) apply()
  }
  for (const mql of segmentQueries) {
    if (mql.addEventListener) mql.addEventListener('change', onSegmentChange)
    else mql.addListener?.(onSegmentChange)
  }

  return report
}

// The report object is refreshed in place; callers keep the snapshot the
// init returned, so there is no module-global state to leak across tests.
