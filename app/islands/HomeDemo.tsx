import { useEffect, useRef, useState } from 'hono/jsx'
import { effectiveImageDpr } from '../lib/image-staging'
import { DEMO_PHOTOS, demoRenditionPath, type DemoFormat, type DemoRenditionSize } from '../components/home/demo/manifest'
import { DEMO_PRESETS, DEMO_STAGE, demoPresetById, type DemoPresetId } from '../components/home/demo/presets'
import {
  captureAnchor,
  contentWidth,
  frameInnerBox,
  layoutStrip,
  restoreOffset,
  travelBounds,
  type StagedPhoto,
} from '../components/home/demo/geometry'
import { advanceElapsed, cycleState, DEFAULT_SETTINGS } from '../components/home/demo/playback'

/**
 * The homepage photo demo: a gallery travelling slowly out and back inside a
 * reserved stage, with one visitor control — the screen shape — plus a
 * Pause/Resume for motion accessibility.
 *
 * It is a simulation, not a mini-application: no dragging, swiping, wheel or
 * arrow navigation, no picker, no account state. It never captures scrolling.
 * Photographs are staged by the production viewer's own sizing helper and are
 * never cropped, stretched or enlarged past their served pixels.
 *
 * The strip's transform is written straight to the DOM in a single animation
 * loop; React state changes only for shape, readiness, pause and failures, so
 * the UI does not re-render per frame.
 */

const PREPARE_AHEAD = 3
const MAX_CONCURRENT_LOADS = 2
const RESIZE_DEBOUNCE_MS = 150

type LoadState = 'idle' | 'loading' | 'loaded' | 'failed'

export default function HomeDemo() {
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  // Keyed by photograph id, not array position: dropping a failed frame must
  // not shift every later image onto the wrong element.
  const imgRefs = useRef<Map<string, HTMLImageElement>>(new Map())

  const [presetId, setPresetId] = useState<DemoPresetId>('desktop')
  const [ready, setReady] = useState(false)
  const [userPaused, setUserPaused] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [failedIds, setFailedIds] = useState<string[]>([])

  const layoutRef = useRef<StagedPhoto[]>([])
  const boundsRef = useRef(0)
  const offsetRef = useRef(0)
  const elapsedRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const loadStateRef = useRef<Map<string, LoadState>>(new Map())
  const inFlightRef = useRef(0)
  const formatRef = useRef<DemoFormat>('avif')
  const sizeRef = useRef<DemoRenditionSize>('lg')
  const onScreenRef = useRef(true)
  const visibleRef = useRef(true)
  const readyRef = useRef(false)
  const pausedRef = useRef(false)
  const reducedRef = useRef(false)
  const presetRef = useRef<DemoPresetId>('desktop')

  pausedRef.current = userPaused
  reducedRef.current = reducedMotion
  presetRef.current = presetId

  const allFailed = failedIds.length >= DEMO_PHOTOS.length

  const running = () =>
    readyRef.current &&
    visibleRef.current &&
    onScreenRef.current &&
    !pausedRef.current &&
    !reducedRef.current &&
    boundsRef.current > 0

  const stopLoop = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    lastTsRef.current = null
  }

  const applyOffset = (offset: number) => {
    offsetRef.current = offset
    if (stripRef.current) stripRef.current.style.transform = `translate3d(${-offset}px,0,0)`
  }

  const ensurePrepared = () => {
    const layout = layoutRef.current
    const viewport = frameRef.current?.clientWidth ?? 0
    const from = offsetRef.current - viewport
    const to = offsetRef.current + viewport * (PREPARE_AHEAD + 1)
    for (const photo of layout) {
      if (photo.x + photo.width < from || photo.x > to) continue
      const state = loadStateRef.current.get(photo.id) ?? 'idle'
      if (state !== 'idle') continue
      if (inFlightRef.current >= MAX_CONCURRENT_LOADS) return
      const img = imgRefs.current.get(photo.id)
      if (!img) continue
      loadStateRef.current.set(photo.id, 'loading')
      inFlightRef.current += 1
      img.onload = () => {
        inFlightRef.current -= 1
        loadStateRef.current.set(photo.id, 'loaded')
        ensurePrepared()
      }
      img.onerror = () => {
        inFlightRef.current -= 1
        loadStateRef.current.set(photo.id, 'failed')
        setFailedIds((prev) => (prev.includes(photo.id) ? prev : [...prev, photo.id]))
        ensurePrepared()
      }
      img.src = demoRenditionPath(photo.id, sizeRef.current, formatRef.current)
    }
  }

  const relayout = (anchorOffset?: number) => {
    const stage = stageRef.current
    const frame = frameRef.current
    const strip = stripRef.current
    if (!stage || !frame || !strip) return
    const preset = demoPresetById(presetRef.current)
    const stageBox = { width: stage.clientWidth, height: stage.clientHeight }
    const inner = frameInnerBox(preset, stageBox)
    frame.style.width = `${inner.outerWidth}px`
    frame.style.height = `${inner.outerHeight}px`
    frame.style.borderWidth = `${preset.bezel}px`
    frame.style.borderRadius = `${preset.radius}px`

    const dpr = effectiveImageDpr(window.devicePixelRatio)
    const sources = DEMO_PHOTOS.filter((p) => loadStateRef.current.get(p.id) !== 'failed').map((p) => {
      const rendition = p[sizeRef.current]
      return { id: p.id, naturalWidth: rendition.width, naturalHeight: rendition.height }
    })
    const layout = layoutStrip(sources, inner.height, dpr)
    layoutRef.current = layout
    const viewport = inner.width
    const bounds = travelBounds(contentWidth(layout), viewport)
    boundsRef.current = bounds

    for (const photo of layout) {
      const img = imgRefs.current.get(photo.id)
      if (!img) continue
      img.style.width = `${photo.width}px`
      img.style.height = `${photo.height}px`
    }
    strip.style.width = `${contentWidth(layout)}px`
    strip.style.height = `${inner.height}px`

    const anchor = captureAnchor(layout, anchorOffset ?? offsetRef.current, viewport)
    applyOffset(restoreOffset(layout, anchor, viewport, bounds))
    ensurePrepared()
    syncLoop()
  }

  const tick = (ts: number) => {
    rafRef.current = requestAnimationFrame(tick)
    const last = lastTsRef.current ?? ts
    lastTsRef.current = ts
    // elapsedRef is milliseconds (advanceElapsed clamps ms); cycleState takes seconds.
    elapsedRef.current = advanceElapsed(elapsedRef.current, ts - last, running())
    const state = cycleState(elapsedRef.current / 1000, boundsRef.current, DEFAULT_SETTINGS)
    applyOffset(state.offset)
    ensurePrepared()
  }

  const syncLoop = () => {
    if (running() && rafRef.current === null) {
      lastTsRef.current = null
      rafRef.current = requestAnimationFrame(tick)
    } else if (!running() && rafRef.current !== null) {
      stopLoop()
    }
  }

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    // Match the visitor's own screen on first load; the reserved outer box
    // keeps this from shifting the page.
    const initial: DemoPresetId = window.innerWidth < 640 ? 'phone' : 'desktop'
    presetRef.current = initial
    setPresetId(initial)

    const dpr = effectiveImageDpr(window.devicePixelRatio)
    sizeRef.current = dpr > 1 ? 'lg' : 'sm'

    // Reuse whatever the server-rendered <picture> already chose, so the first
    // photograph is never refetched and later frames match its format/size.
    const first = imgRefs.current.get(DEMO_PHOTOS[0]!.id)
    const settleFirst = () => {
      const src = first?.currentSrc || first?.src || ''
      const match = /\.(avif|webp|jpg)(?:$|\?)/.exec(src)
      if (match) formatRef.current = match[1] as DemoFormat
      if (first && first.complete && first.naturalWidth > 0) {
        loadStateRef.current.set(DEMO_PHOTOS[0]!.id, 'loaded')
        readyRef.current = true
        setReady(true)
      }
      relayout(0)
    }
    if (first) {
      if (first.complete && first.naturalWidth > 0) settleFirst()
      else {
        first.addEventListener('load', settleFirst, { once: true })
        first.addEventListener('error', () => {
          loadStateRef.current.set(DEMO_PHOTOS[0]!.id, 'failed')
          setFailedIds((prev) => [...prev, DEMO_PHOTOS[0]!.id])
          relayout(0)
        }, { once: true })
      }
    }

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = () => {
      reducedRef.current = mq.matches
      setReducedMotion(mq.matches)
      if (mq.matches) stopLoop()
      else syncLoop()
    }
    onMotion()
    mq.addEventListener('change', onMotion)

    const onVisibility = () => {
      visibleRef.current = document.visibilityState === 'visible'
      syncLoop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()

    const io = new IntersectionObserver((entries) => {
      onScreenRef.current = entries.some((e) => e.isIntersecting)
      syncLoop()
    }, { threshold: 0.1 })
    io.observe(stage)

    let resizeTimer: number | undefined
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => relayout(), RESIZE_DEBOUNCE_MS)
    }
    window.addEventListener('resize', onResize)

    return () => {
      stopLoop()
      mq.removeEventListener('change', onMotion)
      document.removeEventListener('visibilitychange', onVisibility)
      io.disconnect()
      window.removeEventListener('resize', onResize)
      window.clearTimeout(resizeTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shape change or a dropped frame: capture the anchor, relayout, restore and
  // clamp. Direction and any explicit pause survive; the latest selection wins.
  useEffect(() => {
    if (!readyRef.current) return
    relayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId, failedIds])

  const first = DEMO_PHOTOS[0]!

  return (
    <div
      class="home-demo"
      data-demo-stage
      ref={(el: HTMLDivElement | null) => { stageRef.current = el }}
      role="img"
      aria-label="A sample gallery of photographs from Italy, shown whole, travelling slowly across the screen."
      style={{ aspectRatio: `${DEMO_STAGE.aspect}`, maxWidth: `${DEMO_STAGE.maxWidth}px` }}
    >
      <div class="home-demo-frame" data-demo-frame ref={(el: HTMLDivElement | null) => { frameRef.current = el }}>
        <div class="home-demo-viewport">
          <div class="home-demo-strip" data-demo-strip ref={(el: HTMLDivElement | null) => { stripRef.current = el }} aria-hidden="true">
            {DEMO_PHOTOS.map((photo, index) =>
              index === 0 ? (
                <picture key={photo.id}>
                  <source type="image/avif" srcSet={`${demoRenditionPath(photo.id, 'lg', 'avif')} ${photo.lg.width}w, ${demoRenditionPath(photo.id, 'sm', 'avif')} ${photo.sm.width}w`} sizes="(min-width: 640px) 540px, 92vw" />
                  <source type="image/webp" srcSet={`${demoRenditionPath(photo.id, 'lg', 'webp')} ${photo.lg.width}w, ${demoRenditionPath(photo.id, 'sm', 'webp')} ${photo.sm.width}w`} sizes="(min-width: 640px) 540px, 92vw" />
                  <img
                    ref={(el: HTMLImageElement | null) => { if (el) imgRefs.current.set(photo.id, el) }}
                    src={demoRenditionPath(photo.id, 'lg', 'jpg')}
                    alt={photo.alt}
                    width={photo.lg.width}
                    height={photo.lg.height}
                    loading="eager"
                    decoding="sync"
                    fetchpriority="high"
                  />
                </picture>
              ) : (
                <img
                  key={photo.id}
                  ref={(el: HTMLImageElement | null) => { if (el) imgRefs.current.set(photo.id, el) }}
                  alt=""
                  width={photo.lg.width}
                  height={photo.lg.height}
                  loading="eager"
                  decoding="async"
                />
              ),
            )}
          </div>
        </div>
      </div>

      <div class="home-demo-controls" data-demo-controls hidden={!ready || allFailed}>
        <div class="home-demo-shapes" role="group" aria-label="Screen shape">
          {DEMO_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              class="home-demo-shape"
              data-shape={p.id}
              aria-pressed={p.id === presetId ? 'true' : 'false'}
              onClick={() => setPresetId(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="home-demo-pause"
          data-demo-pause
          aria-pressed={userPaused ? 'true' : 'false'}
          onClick={() => setUserPaused((p) => !p)}
        >
          {userPaused ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  )
}