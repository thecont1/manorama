import { useEffect, useMemo, useState } from 'hono/jsx'
import {
  CANVAS_SCALE,
  DEFAULT_MAX_ICONS,
  DOODLE_ICONS,
  buildDoodleLayout,
  quantizeViewport,
  responsiveCell,
  seedFromUrl,
} from '../lib/doodle-background'

/**
 * The scattered-doodle background layer.
 *
 * Renders one absolutely-positioned SVG behind everything: a single
 * <defs> sprite of <symbol>s plus one <use> per placement, so fourteen
 * path definitions serve two hundred glyphs. The layer is inert —
 * pointer-events: none and aria-hidden — so it can never intercept a tap
 * on a photograph or leak into the accessibility tree.
 *
 * Determinism comes from app/lib/doodle-background.ts: URL -> FNV-1a ->
 * mulberry32 -> layout. This component only decides *when* to recompute.
 */

type Props = {
  /** Explicit seed URL. Defaults to the live location on the client. */
  url?: string
  /** Render nothing when false — the flat background shows through. */
  enabled?: boolean
  maxIcons?: number
}

/** Resize settle window: long enough to skip the whole drag, short
 *  enough that a finished resize repaints without feeling stuck. */
const RESIZE_DEBOUNCE_MS = 180

const viewportNow = () => ({
  width: typeof window === 'undefined' ? 0 : window.innerWidth,
  height: typeof window === 'undefined' ? 0 : window.innerHeight,
})

export default function SeededDoodleBackground({ url, enabled = true, maxIcons = DEFAULT_MAX_ICONS }: Props) {
  // Zero until mounted: the server cannot know the viewport, so SSR emits
  // an empty layer and the first client effect fills it in. That keeps
  // hydration from diffing a server grid against a client one.
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? { width: 0, height: 0 } : viewportNow()))
  const [href, setHref] = useState(url ?? '')

  // Track the URL without a router: history navigation in this app swaps
  // the whole document, but a pushState-based transition (or a future
  // client route) must repaint the field too.
  useEffect(() => {
    if (url !== undefined) { setHref(url); return }
    if (typeof window === 'undefined') return
    const sync = () => setHref(window.location.pathname + window.location.search)
    sync()
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hashchange', sync)
    }
  }, [url])

  // Debounced resize. Comparison happens against the *quantized* size, so
  // a URL-bar collapse or a one-pixel nudge never triggers a rebuild.
  useEffect(() => {
    if (typeof window === 'undefined') return
    setViewport(viewportNow())
    let timer: number | undefined
    const onResize = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const next = viewportNow()
        setViewport((prev) =>
          quantizeViewport(prev.width) === quantizeViewport(next.width) &&
          quantizeViewport(prev.height) === quantizeViewport(next.height)
            ? prev
            : next)
      }, RESIZE_DEBOUNCE_MS)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  const seed = useMemo(() => seedFromUrl(href), [href])
  // Quantized dimensions are the real memo keys: the layout is rebuilt
  // only when the seed or a material size bucket changes, never on an
  // unrelated parent re-render.
  const cols = quantizeViewport(viewport.width)
  const rowsPx = quantizeViewport(viewport.height) * CANVAS_SCALE
  const layout = useMemo(
    () => (enabled ? buildDoodleLayout(seed, { width: cols, height: rowsPx, cell: responsiveCell(viewport.width), maxIcons }) : null),
    [enabled, seed, cols, rowsPx, maxIcons],
  )

  if (!enabled || !layout || layout.placements.length === 0) return null

  return (
    <svg
      class="doodle-bg"
      data-doodle-bg
      data-doodle-seed={String(layout.seed)}
      data-doodle-count={String(layout.placements.length)}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      // The canvas is taller than the viewport (scroll headroom), so the
      // SVG must fill its box and crop the overflow rather than
      // letter-box itself to fit — plain `meet` scales the field down and
      // leaves bare gutters left and right.
      preserveAspectRatio="xMidYMin slice"
      aria-hidden="true"
      role="presentation"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* One definition per icon; every placement is a cheap <use>. */}
      <defs>
        {DOODLE_ICONS.map((icon) => (
          <symbol key={icon.id} id={icon.id} viewBox="0 0 24 24">
            <path
              d={icon.path}
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </symbol>
        ))}
      </defs>
      {layout.placements.map((placement, i) => (
        <use
          key={`${placement.icon}-${i}`}
          href={`#${placement.icon}`}
          x={-placement.size / 2}
          y={-placement.size / 2}
          width={placement.size}
          height={placement.size}
          opacity={placement.opacity}
          transform={`translate(${placement.x} ${placement.y}) rotate(${placement.rotation})`}
        />
      ))}
    </svg>
  )
}
