import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import Viewer, { type ViewerDemoHandle } from './Viewer'
import { GalleryCurtain } from '../components/GalleryShell'
import { defaultGallerySettings, type ViewerMode } from '../lib/gallery-settings'
import type { GalleryImage } from '../lib/imagesource'
import DeviceFrame from '../components/home/demo/DeviceFrame'
import { DEMO_PHOTOS, demoRenditionPath, type DemoFormat } from '../components/home/demo/manifest'
import {
  DEMO_PRESETS,
  demoPresetById,
  fitDeviceFrame,
  type DemoPresetId,
} from '../components/home/demo/presets'
import { DEFAULT_SETTINGS } from '../components/home/demo/playback'

const GALLERY_TITLE = 'italia, amore mio'
const GALLERY_CAPTION = 'family trip to Italy in October 2018'
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
const DEMO_MODES: { id: ViewerMode; label: string }[] = [
  { id: 'strip', label: 'Strip' },
  { id: 'vertical', label: 'Scroll' },
  { id: 'single', label: 'One by one' },
]

type LoadState = 'loaded' | 'failed'
type DemoPhase = 'curtain' | 'travel' | 'end' | 'rewind'

export default function HomeDemo() {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const deviceRef = useRef<HTMLDivElement>(null)
  const staticFirstRef = useRef<HTMLImageElement>(null)
  const demoRef = useRef<ViewerDemoHandle | null>(null)
  const demoDisplayScaleRef = useRef(1)

  const [presetId, setPresetId] = useState<DemoPresetId>('desktop')
  const [mode, setMode] = useState<ViewerMode>('strip')
  const [ready, setReady] = useState(false)
  const [userPaused, setUserPaused] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [failedIds, setFailedIds] = useState<string[]>([])
  const [entered, setEntered] = useState(false)
  const [phase, setPhase] = useState<DemoPhase>('curtain')
  const [cycle, setCycle] = useState(0)

  const loadStateRef = useRef<Map<string, LoadState>>(new Map())
  const formatRef = useRef<DemoFormat>('avif')
  const positionRef = useRef(0)
  const onScreenRef = useRef(true)
  const visibleRef = useRef(true)
  const readyRef = useRef(false)
  const pausedRef = useRef(false)
  const reducedRef = useRef(false)
  const presetRef = useRef<DemoPresetId>('desktop')

  pausedRef.current = userPaused
  reducedRef.current = reducedMotion
  presetRef.current = presetId
  readyRef.current = ready

  const allFailed = failedIds.length >= DEMO_PHOTOS.length
  const playbackActive = () =>
    readyRef.current &&
    visibleRef.current &&
    onScreenRef.current &&
    !pausedRef.current &&
    !reducedRef.current

  const syncActivity = () => {
    demoRef.current?.setPaused(!playbackActive())
  }

  const relayout = () => {
    const stage = stageRef.current
    const measure = measureRef.current
    const device = deviceRef.current
    if (!stage || !measure || !device) return

    const preset = demoPresetById(presetRef.current)
    // The Viewer's density budget caps at 2. Keep displayScale × device DPR
    // inside that budget so the outer transform can never upscale a source.
    const maxScale = Math.min(2, 2 / Math.max(1, window.devicePixelRatio || 1))
    const fit = fitDeviceFrame(preset, { width: stage.clientWidth, height: stage.clientHeight }, maxScale)
    if (!(fit.scale > 0)) return
    measure.style.width = `${fit.width}px`
    measure.style.height = `${fit.height}px`
    device.style.transform = `scale(${fit.scale})`
    demoDisplayScaleRef.current = fit.scale
    if (rootRef.current) {
      rootRef.current.dataset.demoFitted = 'true'
      rootRef.current.dataset.demoScale = String(fit.scale)
    }
    demoRef.current?.measure()
  }

  const images = useMemo<GalleryImage[]>(() => DEMO_PHOTOS
    .filter((photo) => loadStateRef.current.get(photo.id) !== 'failed')
    .map((photo) => ({
      id: photo.id,
      filename: `${photo.id}.jpg`,
      src: demoRenditionPath(photo.id, 'lg', formatRef.current),
      width: photo.lg.width,
      height: photo.lg.height,
      alt: photo.alt,
      c2pa: false,
      placeholder: PLACEHOLDER,
    })), [ready, failedIds])
  const settings = useMemo(() => ({
    ...defaultGallerySettings({
      slug: 'home-demo',
      title: GALLERY_TITLE,
      caption: GALLERY_CAPTION,
      date: '',
      images,
    }),
    defaultMode: mode,
  }), [images, mode])

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

    let cancelled = false
    const first = staticFirstRef.current
    const settleFirst = () => {
      const src = first?.currentSrc || first?.src || ''
      const match = /\.(avif|webp|jpg)(?:$|\?)/.exec(src)
      if (match) formatRef.current = match[1] as DemoFormat
      void Promise.all(DEMO_PHOTOS.map((photo) => new Promise<LoadState>((resolve) => {
        const image = new Image()
        image.onload = () => resolve('loaded')
        image.onerror = () => resolve('failed')
        image.src = demoRenditionPath(photo.id, 'lg', formatRef.current)
      }))).then((states) => {
        if (cancelled) return
        const failed: string[] = []
        states.forEach((state, index) => {
          const id = DEMO_PHOTOS[index]!.id
          loadStateRef.current.set(id, state)
          if (state === 'failed') failed.push(id)
        })
        setFailedIds(failed)
        readyRef.current = true
        setReady(true)
      })
    }
    if (first) {
      if (first.complete) settleFirst()
      else {
        first.addEventListener('load', settleFirst, { once: true })
        first.addEventListener('error', settleFirst, { once: true })
      }
    }

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = () => {
      reducedRef.current = mq.matches
      setReducedMotion(mq.matches)
      syncActivity()
    }
    onMotion()
    mq.addEventListener('change', onMotion)

    const onVisibility = () => {
      visibleRef.current = document.visibilityState === 'visible'
      syncActivity()
    }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()

    const io = new IntersectionObserver((entries) => {
      onScreenRef.current = entries.some((entry) => entry.isIntersecting)
      syncActivity()
    }, { threshold: 0.1 })
    io.observe(root)

    const ro = new ResizeObserver(() => {
      if (readyRef.current) relayout()
    })
    ro.observe(stage)

    return () => {
      cancelled = true
      mq.removeEventListener('change', onMotion)
      document.removeEventListener('visibilitychange', onVisibility)
      io.disconnect()
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (readyRef.current) relayout()
    syncActivity()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, presetId, mode, cycle, userPaused, reducedMotion])

  useEffect(() => {
    if (!ready || allFailed) return
    let cancelled = false

    const nextFrame = () => new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => resolve(!cancelled))
    })
    const wait = (durationMs: number) => new Promise<boolean>((resolve) => {
      let elapsed = 0
      let previous: number | null = null
      const tick = (now: number) => {
        if (cancelled) { resolve(false); return }
        if (previous !== null && playbackActive()) elapsed += now - previous
        previous = now
        if (elapsed >= durationMs) { resolve(true); return }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const waitForHandle = async () => {
      while (!cancelled) {
        if (demoRef.current) return demoRef.current
        if (!await nextFrame()) return null
      }
      return null
    }

    void (async () => {
      const handle = await waitForHandle()
      if (!handle || cancelled) return
      relayout()
      handle.setPaused(!playbackActive())

      if (reducedMotion) {
        setPhase('travel')
        handle.showChrome()
        return
      }

      setPhase('curtain')
      if (!await wait(DEFAULT_SETTINGS.curtainHoldMs)) return
      await handle.enter()
      if (cancelled) return
      setEntered(true)
      setPhase('travel')
      if (!await wait(DEFAULT_SETTINGS.holdStartMs)) return

      while (!cancelled) {
        const result = await handle.advance()
        if (cancelled) return
        if (result === 'end') {
          setPhase('end')
          handle.showChrome()
          if (!await wait(DEFAULT_SETTINGS.holdEndMs)) return
          setPhase('rewind')
          setEntered(false)
          await handle.rewind()
          if (cancelled) return
          positionRef.current = 0
          setCycle((value) => value + 1)
          return
        }
        if (!await wait(DEFAULT_SETTINGS.restMs)) return
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, allFailed, presetId, mode, reducedMotion, cycle])

  const first = DEMO_PHOTOS[0]!
  const preset = demoPresetById(presetId)

  return (
    <div
      class="home-demo"
      data-demo-stage
      data-demo-ready={ready ? 'true' : 'false'}
      data-demo-fitted="false"
      data-demo-preset={presetId}
      data-demo-phase={phase}
      ref={(el: HTMLDivElement | null) => { rootRef.current = el }}
    >
      <div
        class="home-demo-stage"
        data-demo-viewport
        ref={(el: HTMLDivElement | null) => { stageRef.current = el }}
        role="img"
        aria-label="A self-running Manorama gallery of Italy photographs inside a device frame, with an opening curtain, temporary controls, and an end card."
        onMouseMove={() => demoRef.current?.showChrome()}
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
        ) : allFailed ? (
          <div class="home-demo-static" aria-hidden="true" />
        ) : (
          <div
            class="home-demo-device-measure"
            ref={(el: HTMLDivElement | null) => { measureRef.current = el }}
          >
            <DeviceFrame
              preset={preset}
              deviceRef={(el) => { deviceRef.current = el }}
              viewerRef={() => {}}
            >
              <div class="home-demo-viewer-stage">
                <GalleryCurtain
                  settings={settings}
                  mediaCount={{ stills: images.length, videos: 0 }}
                  hidden={entered || reducedMotion}
                />
                <Viewer
                  key={`${presetId}-${mode}-${cycle}-${reducedMotion ? 'reduced' : 'motion'}`}
                  slug="home-demo"
                  galleryTitle={GALLERY_TITLE}
                  images={images}
                  settings={settings}
                  plate={null}
                  encryptedResolver={null}
                  initialEdit={false}
                  allowFullscreen={false}
                  initialIndex={positionRef.current}
                  embedded
                  demoRef={demoRef}
                  demoDisplayScaleRef={demoDisplayScaleRef}
                  onReturnToGalleries={() => {}}
                  onPositionChange={(position) => { positionRef.current = position.index }}
                />
              </div>
            </DeviceFrame>
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
        <div class="home-demo-modes" role="group" aria-label="Display mode">
          {DEMO_MODES.map((displayMode) => (
            <button
              key={displayMode.id}
              type="button"
              class="home-demo-mode"
              data-mode={displayMode.id}
              aria-pressed={displayMode.id === mode ? 'true' : 'false'}
              onClick={() => setMode(displayMode.id)}
            >
              {displayMode.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="home-demo-pause"
          data-demo-pause
          aria-pressed={userPaused || reducedMotion ? 'true' : 'false'}
          disabled={reducedMotion}
          onClick={() => {
            const paused = !pausedRef.current
            pausedRef.current = paused
            demoRef.current?.setPaused(!playbackActive())
            setUserPaused(paused)
          }}
        >
          {reducedMotion ? 'Paused' : userPaused ? 'Resume' : 'Pause'}
        </button>
      </div>
    </div>
  )
}
