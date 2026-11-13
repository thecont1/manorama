import { useEffect, useRef, useState } from 'hono/jsx'
import { effectiveImageDpr } from '../lib/image-staging'
import { DEMO_PHOTOS, demoRenditionPath, type DemoFormat } from '../components/home/demo/manifest'
import {
  DEMO_PRESETS,
  demoPresetById,
  deviceFrameSize,
  fitDeviceFrame,
  type DemoPresetId,
} from '../components/home/demo/presets'
import {
  captureAnchor,
  contentWidth,
  endCardWidth,
  layoutStrip,
  positionIndex,
  restStops,
  restoreOffset,
  travelBounds,
  type DemoViewport,
  type StagedPhoto,
} from '../components/home/demo/geometry'
import {
  advancePlayback,
  chromeIsVisible,
  curtainPresentation,
  initialPlayback,
  rebasePlayback,
  DEFAULT_SETTINGS,
  type PlaybackState,
} from '../components/home/demo/playback'

const PREPARE_AHEAD = 3
const MAX_CONCURRENT_LOADS = 2
const GALLERY_TITLE = 'italia, amore mio'
const GALLERY_CAPTION = 'family trip to Italy in October 2018'

type LoadState = 'idle' | 'loading' | 'loaded' | 'failed'

export default function HomeDemo() {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const deviceRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const endCardRef = useRef<HTMLDivElement>(null)
  const curtainRef = useRef<HTMLElement>(null)
  const curtainContentRef = useRef<HTMLDivElement>(null)
  const topChromeRef = useRef<HTMLElement>(null)
  const bottomChromeRef = useRef<HTMLElement>(null)
  const positionRef = useRef<HTMLSpanElement>(null)
  const staticFirstRef = useRef<HTMLImageElement>(null)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const imgRefs = useRef<Map<string, HTMLImageElement>>(new Map())

  const [presetId, setPresetId] = useState<DemoPresetId>('desktop')
  const [ready, setReady] = useState(false)
  const [userPaused, setUserPaused] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [failedIds, setFailedIds] = useState<string[]>([])

  const layoutRef = useRef<StagedPhoto[]>([])
  const viewportSizeRef = useRef<DemoViewport>({ width: 0, height: 0 })
  const boundsRef = useRef(0)
  const stopsRef = useRef<number[]>([0])
  const playbackRef = useRef<PlaybackState>(initialPlayback())
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const loadStateRef = useRef<Map<string, LoadState>>(new Map())
  const inFlightRef = useRef(0)
  const formatRef = useRef<DemoFormat>('avif')
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

  const applyPlayback = (state: PlaybackState) => {
    playbackRef.current = state
    if (stripRef.current) stripRef.current.style.transform = `translate3d(${-state.offset}px,0,0)`

    const presentation = curtainPresentation(state)
    const curtain = curtainRef.current
    if (curtain) {
      curtain.hidden = reducedRef.current || state.phase !== 'curtain'
      curtain.style.opacity = String(presentation.veilOpacity)
      curtain.style.backdropFilter = `blur(${28 * presentation.veilOpacity}px) saturate(${1 + presentation.veilOpacity * 0.1})`
    }
    if (curtainContentRef.current) {
      curtainContentRef.current.style.opacity = String(presentation.wordsOpacity)
    }

    const chromeVisible = chromeIsVisible(state, reducedRef.current)
    topChromeRef.current?.classList.toggle('is-visible', chromeVisible)
    bottomChromeRef.current?.classList.toggle('is-visible', chromeVisible)
    if (positionRef.current && layoutRef.current.length) {
      const index = positionIndex(layoutRef.current, state.offset, viewportSizeRef.current.width)
      positionRef.current.textContent = `${index + 1} of ${layoutRef.current.length}`
    }
    if (rootRef.current) {
      rootRef.current.dataset.demoPhase = state.phase
      rootRef.current.dataset.demoChrome = chromeVisible ? 'visible' : 'hidden'
    }
  }

  const ensurePrepared = () => {
    const viewport = viewportSizeRef.current.width
    const { offset, direction } = playbackRef.current
    const from = direction === 1 ? offset - viewport : offset - viewport * PREPARE_AHEAD
    const to = direction === 1 ? offset + viewport * (PREPARE_AHEAD + 1) : offset + viewport * 2
    for (const photo of layoutRef.current) {
      if (photo.x + photo.slotWidth < from || photo.x > to) continue
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
      img.src = demoRenditionPath(photo.id, 'lg', formatRef.current)
    }
  }

  const tick = (ts: number) => {
    rafRef.current = null
    if (!running()) {
      lastTsRef.current = null
      return
    }
    const last = lastTsRef.current ?? ts
    lastTsRef.current = ts
    const next = advancePlayback(
      playbackRef.current,
      ts - last,
      stopsRef.current,
      boundsRef.current,
      DEFAULT_SETTINGS,
    )
    applyPlayback(next)
    ensurePrepared()
    rafRef.current = requestAnimationFrame(tick)
  }

  const syncLoop = () => {
    applyPlayback(playbackRef.current)
    if (running() && rafRef.current === null) {
      lastTsRef.current = null
      rafRef.current = requestAnimationFrame(tick)
    } else if (!running() && rafRef.current !== null) {
      stopLoop()
    }
  }

  const relayout = () => {
    const stage = stageRef.current
    const measure = measureRef.current
    const device = deviceRef.current
    const viewportElement = viewportRef.current
    const strip = stripRef.current
    if (!stage || !measure || !device || !viewportElement || !strip) return

    const previousLayout = layoutRef.current
    const previousViewport = viewportSizeRef.current
    const anchor = previousLayout.length && previousViewport.width
      ? captureAnchor(previousLayout, playbackRef.current.offset, previousViewport.width)
      : null

    const preset = demoPresetById(presetRef.current)
    const fit = fitDeviceFrame(preset, { width: stage.clientWidth, height: stage.clientHeight })
    if (!(fit.scale > 0)) return
    measure.style.width = `${fit.width}px`
    measure.style.height = `${fit.height}px`
    device.style.transform = `scale(${fit.scale})`

    const viewport = { ...preset.screen }
    const displayedDpr = effectiveImageDpr(window.devicePixelRatio) * fit.scale
    const sources = DEMO_PHOTOS.filter((p) => loadStateRef.current.get(p.id) !== 'failed').map((p) => ({
      id: p.id,
      naturalWidth: p.lg.width,
      naturalHeight: p.lg.height,
    }))
    const layout = layoutStrip(sources, viewport, displayedDpr)
    const finalCardWidth = endCardWidth(viewport)
    const totalWidth = contentWidth(layout) + finalCardWidth
    const bounds = travelBounds(totalWidth, viewport.width)

    for (const photo of layout) {
      const item = itemRefs.current.get(photo.id)
      const img = imgRefs.current.get(photo.id)
      if (item) item.style.width = `${photo.slotWidth}px`
      if (!img) continue
      img.style.width = `${photo.width}px`
      img.style.height = `${photo.height}px`
    }
    if (endCardRef.current) endCardRef.current.style.width = `${finalCardWidth}px`
    strip.style.width = `${totalWidth}px`

    const phase = playbackRef.current.phase
    const restored = phase === 'curtain'
      ? 0
      : phase === 'end'
        ? bounds
        : restoreOffset(layout, anchor, viewport.width, bounds)
    layoutRef.current = layout
    viewportSizeRef.current = viewport
    boundsRef.current = bounds
    stopsRef.current = restStops(layout, viewport.width, finalCardWidth)
    const rebased = rebasePlayback(playbackRef.current, restored, stopsRef.current)
    if (rootRef.current) {
      rootRef.current.dataset.demoFitted = 'true'
      rootRef.current.dataset.demoScale = String(fit.scale)
    }
    applyPlayback(rebased)
    ensurePrepared()
    syncLoop()
  }

  useEffect(() => {
    const root = rootRef.current
    const stage = stageRef.current
    if (!root || !stage) return

    const initial: DemoPresetId = window.innerWidth < 640
      ? 'phone'
      : window.innerWidth < 1024
        ? 'tablet'
        : 'desktop'
    presetRef.current = initial
    setPresetId(initial)

    const first = staticFirstRef.current
    const settleFirst = () => {
      const src = first?.currentSrc || first?.src || ''
      const match = /\.(avif|webp|jpg)(?:$|\?)/.exec(src)
      if (match) formatRef.current = match[1] as DemoFormat
      if (first && first.complete && first.naturalWidth > 0) {
        loadStateRef.current.set(DEMO_PHOTOS[0]!.id, 'loaded')
      }
      readyRef.current = true
      setReady(true)
    }
    if (first) {
      if (first.complete) settleFirst()
      else {
        first.addEventListener('load', settleFirst, { once: true })
        first.addEventListener('error', () => {
          loadStateRef.current.set(DEMO_PHOTOS[0]!.id, 'failed')
          setFailedIds((prev) => [...prev, DEMO_PHOTOS[0]!.id])
          settleFirst()
        }, { once: true })
      }
    }

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = () => {
      reducedRef.current = mq.matches
      setReducedMotion(mq.matches)
      syncLoop()
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
      onScreenRef.current = entries.some((entry) => entry.isIntersecting)
      syncLoop()
    }, { threshold: 0.1 })
    io.observe(root)

    const ro = new ResizeObserver(() => {
      if (readyRef.current) relayout()
    })
    ro.observe(stage)

    return () => {
      stopLoop()
      mq.removeEventListener('change', onMotion)
      document.removeEventListener('visibilitychange', onVisibility)
      io.disconnect()
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (readyRef.current) relayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, presetId, failedIds])

  useEffect(() => {
    syncLoop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, userPaused, reducedMotion])

  const first = DEMO_PHOTOS[0]!
  const preset = demoPresetById(presetId)
  const frame = deviceFrameSize(preset)

  return (
    <div
      class="home-demo"
      data-demo-stage
      data-demo-ready={ready ? 'true' : 'false'}
      data-demo-fitted="false"
      data-demo-preset={presetId}
      ref={(el: HTMLDivElement | null) => { rootRef.current = el }}
    >
      <div
        class="home-demo-stage"
        data-demo-viewport
        ref={(el: HTMLDivElement | null) => { stageRef.current = el }}
        role="img"
        aria-label="A self-running Manorama gallery of Italy photographs inside a device frame, with an opening curtain, temporary controls, and an end card."
      >
        {!ready ? (
          <div class="home-demo-static">
            <picture>
              <source type="image/avif" srcSet={demoRenditionPath(first.id, 'lg', 'avif')} />
              <source type="image/webp" srcSet={demoRenditionPath(first.id, 'lg', 'webp')} />
              <img
                ref={(el: HTMLImageElement | null) => { staticFirstRef.current = el }}
                src={demoRenditionPath(first.id, 'lg', 'jpg')}
                alt=""
                width={first.lg.width}
                height={first.lg.height}
                loading="eager"
                decoding="sync"
                fetchpriority="high"
              />
            </picture>
          </div>
        ) : (
          <div
            class="home-demo-device-measure"
            ref={(el: HTMLDivElement | null) => { measureRef.current = el }}
          >
            <div
              class={`home-demo-device home-demo-device--${preset.id}`}
              data-demo-device
              ref={(el: HTMLDivElement | null) => { deviceRef.current = el }}
              style={`width:${frame.width}px;height:${frame.height}px`}
            >
              <div
                class="home-demo-device-body"
                style={`left:${preset.baseOverhang}px;top:0;width:${preset.screen.width + preset.bezel * 2}px;height:${preset.screen.height + preset.bezel * 2}px;border-radius:${preset.radius}px`}
              />
              {preset.id === 'desktop' ? <div class="home-demo-laptop-base" style={`height:${preset.baseHeight}px`} /> : null}
              <div
                class="home-demo-screen viewer-stage mode-strip bg-dark"
                data-demo-screen
                ref={(el: HTMLDivElement | null) => { viewportRef.current = el }}
                style={`left:${preset.baseOverhang + preset.bezel}px;top:${preset.bezel}px;width:${preset.screen.width}px;height:${preset.screen.height}px`}
                aria-hidden="true"
                inert
              >
                <div class="home-demo-strip viewer-track" data-demo-strip ref={(el: HTMLDivElement | null) => { stripRef.current = el }}>
                  {DEMO_PHOTOS.map((photo, index) => (
                    <div
                      class="home-demo-item viewer-frame"
                      key={photo.id}
                      data-photo-id={photo.id}
                      hidden={failedIds.includes(photo.id)}
                      ref={(el: HTMLDivElement | null) => { if (el) itemRefs.current.set(photo.id, el) }}
                    >
                      {index === 0 ? (
                        <picture>
                          <source type="image/avif" srcSet={demoRenditionPath(photo.id, 'lg', 'avif')} />
                          <source type="image/webp" srcSet={demoRenditionPath(photo.id, 'lg', 'webp')} />
                          <img
                            ref={(el: HTMLImageElement | null) => { if (el) imgRefs.current.set(photo.id, el) }}
                            src={demoRenditionPath(photo.id, 'lg', 'jpg')}
                            alt=""
                            width={photo.lg.width}
                            height={photo.lg.height}
                            loading="eager"
                            decoding="sync"
                            fetchpriority="high"
                            draggable={false}
                          />
                        </picture>
                      ) : (
                        <img
                          ref={(el: HTMLImageElement | null) => { if (el) imgRefs.current.set(photo.id, el) }}
                          alt=""
                          width={photo.lg.width}
                          height={photo.lg.height}
                          loading="eager"
                          decoding="async"
                          draggable={false}
                        />
                      )}
                    </div>
                  ))}
                  <div
                    class="viewer-endcap home-demo-endcap"
                    data-demo-endcard
                    ref={(el: HTMLDivElement | null) => { endCardRef.current = el }}
                  >
                    <span class="endcap-line">The End.</span>
                    <div class="endcap-actions"><span class="endcap-reset">Rewind</span></div>
                  </div>
                </div>

                <section class="curtain home-demo-curtain" data-demo-curtain ref={(el: HTMLElement | null) => { curtainRef.current = el }} hidden>
                  <div class="curtain-content" ref={(el: HTMLDivElement | null) => { curtainContentRef.current = el }}>
                    <img src="/manorama-merged-logo.png" alt="" width="140" height="47" class="curtain-mark" />
                    <h2 class="curtain-title">{GALLERY_TITLE}</h2>
                    <p class="curtain-caption">{GALLERY_CAPTION}</p>
                    <p class="curtain-count">{DEMO_PHOTOS.length} photographs</p>
                  </div>
                </section>

                <header class="m-chrome m-chrome--top home-demo-chrome" data-demo-chrome-top ref={(el: HTMLElement | null) => { topChromeRef.current = el }}>
                  <span class="m-chrome-pill"><span aria-hidden="true">‹</span> Library</span>
                  <span class="m-chrome-pill" data-demo-position ref={(el: HTMLSpanElement | null) => { positionRef.current = el }}>1 of {DEMO_PHOTOS.length}</span>
                </header>
                <nav class="m-chrome m-chrome--bottom home-demo-chrome" data-demo-chrome-bottom ref={(el: HTMLElement | null) => { bottomChromeRef.current = el }}>
                  <span class="m-chrome-pill">Settings</span>
                  <span class="m-chrome-pill">Info</span>
                </nav>
              </div>
            </div>
          </div>
        )}
      </div>

      <div class="home-demo-controls" data-demo-controls hidden={!ready || allFailed}>
        <div class="home-demo-shapes" role="group" aria-label="Screen shape">
          {DEMO_PRESETS.map((shape) => (
            <button
              key={shape.id}
              type="button"
              class="home-demo-shape"
              data-shape={shape.id}
              aria-pressed={shape.id === presetId ? 'true' : 'false'}
              onClick={() => setPresetId(shape.id)}
            >
              {shape.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="home-demo-pause"
          data-demo-pause
          aria-pressed={userPaused || reducedMotion ? 'true' : 'false'}
          disabled={reducedMotion}
          onClick={() => setUserPaused((paused) => !paused)}
        >
          {reducedMotion ? 'Paused' : userPaused ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  )
}
