import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'hono/jsx'
import { isVideoItem, type GalleryImage, type GalleryMediaItem, type VideoItem } from '../lib/imagesource'
import { imageWithSettings, loadStoredGallerySettings, type GallerySettings } from '../lib/gallery-settings'
import { attachMagnifier, magnifierSupported, type MagnifierHandle } from '../lib/magnifier'
import { effectiveImageDpr, imageStageSize } from '../lib/image-staging'
import VideoSlide, { formatDuration } from './VideoSlide'

type Mode = 'strip' | 'vertical' | 'single'
type SeamMode = 'light' | 'dark' | 'none'
type DragSample = { x: number; time: number }
type Props = {
  slug: string
  images: readonly GalleryMediaItem[]
  settings: GallerySettings
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** Newton–Raphson solver for CSS cubic-bezier(x1,y1,x2,y2): given x (time),
 *  returns y (progress) exactly as a browser transition would compute it. */
const makeBezier = (x1: number, y1: number, x2: number, y2: number) => {
  const coeffA = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1
  const coeffB = (a1: number, a2: number) => 3 * a2 - 6 * a1
  const evalAt = (t: number, a1: number, a2: number) =>
    ((coeffA(a1, a2) * t + coeffB(a1, a2)) * t + 3 * a1) * t
  const slopeAt = (t: number, a1: number, a2: number) =>
    3 * coeffA(a1, a2) * t * t + 2 * coeffB(a1, a2) * t + 3 * a1
  return (x: number) => {
    let t = x
    for (let i = 0; i < 4; i += 1) {
      const slope = slopeAt(t, x1, x2)
      if (slope === 0) break
      t -= (evalAt(t, x1, x2) - x) / slope
    }
    return evalAt(t, y1, y2)
  }
}

/** The app's signature ease — same curve the curtain lift and the
 *  single-mode crossfade use — so a JS-driven glide feels identical to
 *  the CSS-animated surfaces. */
const glideEase = makeBezier(0.22, 1, 0.36, 1)

/** The standalone C2PA viewer is a sibling homebrand: `I` deep-links the
 *  current photograph into it (`?uri=<absolute url>`), where the full
 *  EXIF/IPTC/C2PA readout lives without interrupting the strip. */
const C2PA_VIEWER_URL = 'https://c2pa.thecontrarian.in/'

/** Touch-primary devices hide the nav buttons by default; the settings
 *  toggle still brings them back. SSR cannot know the pointer — the gate
 *  runs in the mount effect, never in initial state, so hydration and
 *  server markup agree. */
const coarsePointer = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches

/** In vertical mode, frames beyond the viewport stay active only up to this
 *  many past the visible set — enough to not thrash on small scrolls, bounded
 *  so decoded HEIC blobs get revoked as frames scroll away. */
const VERTICAL_RETAIN = 6

/** Anonymous per-gallery viewing preferences: mode + background choice are
 *  remembered in localStorage keyed by gallery slug, so a link recipient
 *  keeps their own preference without an account. */
type ViewPrefs = { mode?: Mode; seamMode?: SeamMode }
const readViewPrefs = (slug: string): ViewPrefs => {
  try {
    const stored = JSON.parse(localStorage.getItem(`manorama:view:${slug}`) ?? '{}') as ViewPrefs
    return {
      mode: stored.mode && ['strip', 'vertical', 'single'].includes(stored.mode) ? stored.mode : undefined,
      seamMode: stored.seamMode && ['light', 'dark', 'none'].includes(stored.seamMode) ? stored.seamMode : undefined,
    }
  } catch {
    return {}
  }
}

/** Renders a gallery in strip, vertical, or single-image mode. Still images
 *  preserve their aspect ratio, fit height-first in strip mode, width-first in
 *  vertical mode, and within both axes in single mode without upscaling. */
export default function Viewer({ slug, images: sourceImages, settings: initialSettings }: Props) {
  const [settings, setSettings] = useState<GallerySettings>(initialSettings)
  const images = useMemo(() => sourceImages.map((image) => imageWithSettings(image, settings)), [sourceImages, settings])
  const viewPrefs = useMemo(() => (typeof localStorage === 'undefined' ? {} : readViewPrefs(slug)), [slug])
  const [mode, setMode] = useState<Mode>(viewPrefs.mode ?? initialSettings.defaultMode)
  const [index, setIndex] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [showArrows, setShowArrows] = useState(initialSettings.defaultShowArrows)
  const [seamMode, setSeamMode] = useState<SeamMode>(viewPrefs.seamMode ?? 'none')
  const [showCaptions, setShowCaptions] = useState(initialSettings.defaultShowCaptions)
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false)
  const [fullscreenActive, setFullscreenActive] = useState(false)
  const [credentialState, setCredentialState] = useState<Record<string, 'idle' | 'loading' | 'verified' | 'unavailable'>>({})
  const [credentialStores, setCredentialStores] = useState<Record<string, unknown>>({})
  const [heicSrc, setHeicSrc] = useState<Record<string, string>>({})
  // One-at-a-time sweep: the outgoing frame stays mounted and fully
  // opaque while the incoming frame wipes over it behind an opaque
  // canvas card — no transparency ever lands on the striped field.
  const [leavingIndex, setLeavingIndex] = useState<number | null>(null)
  const [sweepDir, setSweepDir] = useState<'fwd' | 'back'>('fwd')
  const sweepTimerRef = useRef<number | null>(null)
  // Decoded pixel truth for frames whose stored dims were wrong (4:3
  // fallbacks, stale scans). Held in state because hono/jsx rewrites
  // style.cssText on every render — an imperative aspectRatio write gets
  // reverted by the next state change unless the prop itself carries it.
  const [healedDims, setHealedDims] = useState<Record<string, { w: number; h: number }>>({})
  // Image watchdog bookkeeping: a mounted original that stays undecoded
  // past the stall window gets re-requested (cache-busted) instead of
  // sitting blank. Bounded per image; the retry rewrites src directly.
  const watchdogSeenRef = useRef(new WeakMap<HTMLImageElement, number>())
  const watchdogAttemptsRef = useRef<Record<string, number>>({})
  const [stageSize, setStageSize] = useState({ width: 0, height: 0, dpr: effectiveImageDpr(typeof window === 'undefined' ? 1 : window.devicePixelRatio) })
  // Viewer-level sound: once a visitor unmutes, every subsequently
  // activated video starts audible. Deliberately NOT persisted — it
  // resets when the viewer unmounts, so a fresh visit is always quiet.
  const [soundOn, setSoundOn] = useState(false)
  const [magnifierActive, setMagnifierActive] = useState(false)
  const [magnifierAvailable, setMagnifierAvailable] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  // Playback is gated by the opening curtain. Without React state here,
  // adding a body class does not rerender the active VideoSlide, so a
  // video-first gallery would remain mounted and autoplay behind the
  // curtain (or never start after entry, depending on mount timing).
  const [galleryEntered, setGalleryEntered] = useState(() =>
    typeof document !== 'undefined' && document.body.classList.contains('gallery-entered'))
  const magnifierRef = useRef<MagnifierHandle | null>(null)
  const heicPendingRef = useRef(new Set<string>())
  const heicUrlsRef = useRef(new Map<string, string>())
  const unmountedRef = useRef(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const modalRef = useRef<HTMLDivElement | null>(null)
  const infoModalRef = useRef<HTMLDivElement | null>(null)
  const dotRef = useRef<HTMLButtonElement | null>(null)
  const nextArrowRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  // "A modal is open" for always-on window key handlers: hono/jsx applies
  // the state write synchronously but commits the render later, so both
  // closures and render-synced values lag a setState call. The open/close
  // helpers write this at event time; the render line is the backstop.
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = modalOpen || infoOpen
  const openDisplaySettings = () => { anyModalOpenRef.current = true; setModalOpen(true) }
  const openImageInfo = () => { anyModalOpenRef.current = true; setInfoOpen(true) }
  const closeModals = () => { anyModalOpenRef.current = false; setModalOpen(false); setInfoOpen(false) }
  const draggingRef = useRef(false)
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const dragSamplesRef = useRef<DragSample[]>([])
  const dragTargetXRef = useRef(0)
  const dragFrameRef = useRef<number | null>(null)
  const momentumRef = useRef<number | null>(null)
  const c2paRef = useRef<any>(null)
  const currentXRef = useRef(0)
  // The strip X an in-flight button navigation is heading for. Rapid taps
  // anchor their advance at this pending destination, so N clicks carry
  // the strip N photos instead of collapsing into a single hop.
  const navDestXRef = useRef<number | null>(null)
  const indexRef = useRef(index)
  const modeRef = useRef(mode)
  const reportedIndexRef = useRef(index)
  // Seed a small window so the first vertical paint isn't placeholder-only;
  // the IntersectionObserver takes over immediately after mount.
  const [verticalActive, setVerticalActive] = useState<ReadonlySet<number>>(() => new Set([0, 1, 2]))
  const verticalMruRef = useRef<number[]>([])
  const positionFrameRef = useRef<number | null>(null)
  const viewportFrameRef = useRef<number | null>(null)
  const boundsRef = useRef({ min: 0, max: 0 })
  const boundsDirtyRef = useRef(true)

  const currentImage = images[index] ?? images[0]
  // The info panel speaks about whichever medium is on screen, and EXIF
  // only exists on photographs — narrow once here rather than at each use.
  const currentVideo = currentImage && isVideoItem(currentImage) ? currentImage : null
  const currentIsVideo = Boolean(currentVideo)
  const currentExif = currentImage && !isVideoItem(currentImage) ? currentImage.exif : undefined

  useEffect(() => { indexRef.current = index }, [index])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => {
    try {
      localStorage.setItem(`manorama:view:${slug}`, JSON.stringify({ mode, seamMode }))
    } catch {
      // Storage can be unavailable (private mode) — preferences are best-effort.
    }
  }, [slug, mode, seamMode])

  useEffect(() => {
    const loaded = loadStoredGallerySettings(slug, initialSettings)
    setSettings(loaded)
    setMode(viewPrefs.mode ?? loaded.defaultMode)
    setShowArrows(loaded.defaultShowArrows && !coarsePointer())
    setShowCaptions(loaded.defaultShowCaptions)
    const curtain = document.querySelector<HTMLElement>('[data-curtain]')
    const updateText = (selector: string, value: string) => {
      const element = curtain?.querySelector<HTMLElement>(selector)
      if (element) element.textContent = value
    }
    updateText('[data-curtain-kicker]', loaded.curtainKicker)
    updateText('[data-curtain-title]', loaded.title)
    updateText('[data-curtain-caption]', loaded.caption)
    updateText('[data-curtain-date]', loaded.date)
    updateText('[data-curtain-prompt]', loaded.curtainPrompt)
  }, [slug, initialSettings, viewPrefs])

  useEffect(() => {
    const clearPositionHash = () => {
      if (window.location.hash || window.location.search) history.replaceState(null, '', window.location.pathname)
    }
    clearPositionHash()
    window.addEventListener('hashchange', clearPositionHash)
    return () => window.removeEventListener('hashchange', clearPositionHash)
  }, [])

  useEffect(() => {
    const updateFullscreenState = () => {
      setFullscreenAvailable(Boolean(document.fullscreenEnabled && stageRef.current?.requestFullscreen))
      setFullscreenActive(Boolean(document.fullscreenElement))
    }
    updateFullscreenState()
    document.addEventListener('fullscreenchange', updateFullscreenState)
    return () => document.removeEventListener('fullscreenchange', updateFullscreenState)
  }, [])

  useEffect(() => {
    const preventButtonFocus = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('button')) event.preventDefault()
    }
    document.addEventListener('mousedown', preventButtonFocus)
    return () => document.removeEventListener('mousedown', preventButtonFocus)
  }, [])

  const hasMultiple = images.length > 1
  const arrowsVisible = showArrows && mode !== 'vertical' && hasMultiple

  const getBounds = () => {
    if (!boundsDirtyRef.current) return boundsRef.current
    const viewport = stageRef.current?.clientWidth ?? window.innerWidth
    const content = trackRef.current?.scrollWidth ?? 0
    boundsRef.current = { min: 0, max: Math.max(0, content - viewport) }
    boundsDirtyRef.current = false
    return boundsRef.current
  }

  // "Active" is the frame holding the stage's left edge — the docked
  // image under the left-align rule. Nearest-center reporting drifts:
  // a narrow docked portrait loses to a wide successor's center, which
  // then makes the next advance skip a frame.
  const leftmostFrameIndex = (leftEdge: number) => {
    const frames = trackRef.current?.querySelectorAll<HTMLElement>('[data-index]') ?? []
    let nearest = 0
    for (const frame of frames) {
      const frameIndex = Number(frame.dataset.index ?? 1) - 1
      if (frame.offsetLeft <= leftEdge + 1) nearest = frameIndex
      else break
    }
    return nearest
  }

  const reportStripPosition = () => {
    if (positionFrameRef.current !== null) return
    positionFrameRef.current = requestAnimationFrame(() => {
      positionFrameRef.current = null
      const stage = stageRef.current
      const track = trackRef.current
      if (!stage || !track) return
      const nearest = leftmostFrameIndex(-currentXRef.current)
      if (reportedIndexRef.current !== nearest) {
        reportedIndexRef.current = nearest
        setIndex(nearest)
      }
      // The navigation this report settles is over — drop the pending
      // destination so the next tap anchors at the real position.
      navDestXRef.current = null
    })
  }

  const cancelPositionReport = () => {
    if (positionFrameRef.current !== null) {
      cancelAnimationFrame(positionFrameRef.current)
      positionFrameRef.current = null
    }
  }

  const renderX = (next: number, shouldReport = true) => {
    const bounds = getBounds()
    const value = clamp(next, -bounds.max, 0)
    currentXRef.current = value
    trackRef.current?.style.setProperty('transform', `translate3d(${value}px, 0, 0)`)
    if (shouldReport) reportStripPosition()
    return value
  }

  const flushDragTarget = () => {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current)
      dragFrameRef.current = null
    }
    renderX(dragTargetXRef.current)
  }

  const scheduleDragTarget = () => {
    if (dragFrameRef.current !== null) return
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null
      renderX(dragTargetXRef.current)
    })
  }

  const stopMomentum = () => {
    if (momentumRef.current !== null) {
      cancelAnimationFrame(momentumRef.current)
      momentumRef.current = null
    }
  }

  const settleTo = (target: number, instant = false, reportOnComplete = false) => {
    stopMomentum()
    const from = currentXRef.current
    const bounds = getBounds()
    const destination = clamp(target, -bounds.max, 0)
    if (instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      renderX(destination, false)
      if (reportOnComplete) reportStripPosition()
      return
    }
    const started = performance.now()
    // Ease-out, not ease-in-out: a symmetric curve's motionless first
    // third reads as the tap being ignored — the "isn't smooth" complaint.
    // cubic-bezier(0.22, 1, 0.36, 1) is the app's signature ease (curtain,
    // single-mode fade): the glide launches on the frame the tap lands and
    // settles with a long, gentle deceleration. Duration scales with
    // travel distance — a full-gallery rewind still glides back
    // deliberately instead of covering tens of thousands of px in a blur.
    const duration = clamp(Math.abs(destination - from) / 10, 650, 2800)
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      const eased = glideEase(progress)
      // Chase navDestX live: a mid-flight retarget (queued taps, or a
      // healed frame shifting the destination's offset) is absorbed into
      // the remaining travel instead of cancelling the navigation.
      const liveDest = navDestXRef.current ?? destination
      const next = from + (liveDest - from) * eased
      renderX(next, false)
      if (progress < 1) momentumRef.current = requestAnimationFrame(tick)
      else {
        momentumRef.current = null
        if (reportOnComplete) reportStripPosition()
      }
    }
    momentumRef.current = requestAnimationFrame(tick)
  }

  const imageStart = (imageIndex: number) => {
    if (imageIndex <= 0) return 0
    return trackRef.current?.querySelector<HTMLElement>(`[data-index="${imageIndex + 1}"]`)?.offsetLeft ?? 0
  }

  const goTo = (nextIndex: number, instant = false) => {
    const next = clamp(nextIndex, 0, images.length - 1)
    cancelPositionReport()
    reportedIndexRef.current = next
    if (mode === 'single' && next !== index && !instant) {
      const dir = next > index ? 'fwd' : 'back'
      const beginSweep = () => {
        if (unmountedRef.current) return
        setLeavingIndex(index)
        setIndex(next)
        if (sweepTimerRef.current !== null) window.clearTimeout(sweepTimerRef.current)
        sweepTimerRef.current = window.setTimeout(() => { sweepTimerRef.current = null; setLeavingIndex(null) }, 800)
      }
      if (dir !== sweepDir) {
        // Hidden frames carry the sweep's start clip. A direction change
        // must reach the DOM a commit before the entering frame begins
        // its transition — transitions interpolate from the previously
        // resolved style, so a same-commit flip would wipe backwards.
        setSweepDir(dir)
        requestAnimationFrame(beginSweep)
      } else {
        beginSweep()
      }
    } else {
      setIndex(next)
    }
    if (mode === 'strip') {
      navDestXRef.current = -imageStart(next)
      settleTo(navDestXRef.current, instant)
    }
    if (mode === 'vertical') {
      requestAnimationFrame(() => document.querySelector(`[data-image-id="${images[next]?.id}"]`)?.scrollIntoView({ block: 'start', behavior: instant ? 'auto' : 'smooth' }))
    }
  }

  const step = (direction: -1 | 1) => {
    if (!hasMultiple) return
    if (mode === 'strip') {
      const next = clamp(index + direction, 0, images.length - 1)
      goTo(next)
    } else {
      goTo(index + direction)
    }
  }

  const advanceStripByViewport = (direction: -1 | 1) => {
    if (mode !== 'strip') { step(direction); return }
    // Wrap: right arrow at the last image returns to the first, left
    // arrow at the first image jumps to the last.
    const bounds = getBounds()
    // Rapid taps accumulate: anchor each advance at the pending in-flight
    // destination (or the real position when idle), so the tap count
    // becomes the photo count travelled.
    const base = -(navDestXRef.current ?? currentXRef.current)
    if (direction === 1 && base >= bounds.max - 1) { goTo(0); return }
    if (direction === -1 && base <= 1) { goTo(images.length - 1); return }
    const viewportWidth = stageRef.current?.clientWidth ?? window.innerWidth
    let frame = trackRef.current?.querySelector<HTMLElement>(`[data-index="${leftmostFrameIndex(base) + 1}"]`) ?? null
    let advance: number
    if (direction === 1) {
      // Dock the next image: scroll until the following frame's left edge
      // reaches the stage's left edge. Inside images wider than the stage
      // that distance exceeds a viewport, so it pages through in viewport
      // chunks and docks the next frame on the final step.
      const target = frame?.nextElementSibling as HTMLElement | null
      advance = Math.min(viewportWidth, Math.max(0, (target?.offsetLeft ?? base + viewportWidth) - base))
    } else {
      // Moving left: cover the lesser of the viewport width or the part of the
      // active image still hidden to the left of the stage edge. When the
      // active image's left edge is already at the stage edge, the remaining
      // width belongs to the frame before it.
      let remaining = frame ? base - frame.offsetLeft : 0
      while (remaining <= 0 && frame) {
        frame = frame.previousElementSibling as HTMLElement | null
        remaining = frame ? base - frame.offsetLeft : 0
      }
      advance = Math.min(viewportWidth, Math.max(0, remaining))
    }
    navDestXRef.current = clamp(-(base + direction * advance), -bounds.max, 0)
    settleTo(navDestXRef.current, false, true)
  }

  useEffect(() => {
    if (!currentImage) return
    const state = credentialState[currentImage.id]
    if (state === 'verified' || state === 'unavailable') return
    if (!currentImage.c2pa) {
      setCredentialState((previous) => ({ ...previous, [currentImage.id]: 'unavailable' }))
    }
  }, [currentImage?.id, currentImage?.c2pa])

  useEffect(() => {
    const curtain = document.querySelector<HTMLElement>('[data-curtain]')
    if (!curtain) return
    let finishTimer: number | undefined
    let pointerStart: { x: number; y: number; id: number } | null = null
    let ignoreClick = false
    const dismiss = () => {
      if (curtain.hidden || curtain.classList.contains('is-lifting')) return
      curtain.setAttribute('aria-hidden', 'true')
      curtain.classList.add('is-lifting')
      document.body.classList.add('gallery-entered')
      setGalleryEntered(true)
      const focusTarget = nextArrowRef.current && !nextArrowRef.current.disabled ? nextArrowRef.current : dotRef.current
      focusTarget?.focus({ preventScroll: true })
      const finish = () => {
        curtain.removeEventListener('transitionend', onLiftEnd)
        if (finishTimer) window.clearTimeout(finishTimer)
        curtain.classList.remove('is-lifting')
        curtain.hidden = true
      }
      const onLiftEnd = (event: TransitionEvent) => {
        if (event.target === curtain && event.propertyName === 'transform') finish()
      }
      curtain.addEventListener('transitionend', onLiftEnd)
      finishTimer = window.setTimeout(finish, 980)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        dismiss()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }
      curtain.setPointerCapture?.(event.pointerId)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!pointerStart || pointerStart.id !== event.pointerId) return
      curtain.releasePointerCapture?.(event.pointerId)
      const horizontal = Math.abs(event.clientX - pointerStart.x)
      const upward = pointerStart.y - event.clientY
      ignoreClick = horizontal > 12 || Math.abs(upward) > 12
      pointerStart = null
      if (upward >= 48 && upward > horizontal * 1.25) dismiss()
    }
    const onPointerCancel = (event: PointerEvent) => {
      if (pointerStart?.id === event.pointerId) pointerStart = null
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!pointerStart) return
      const touch = event.touches[0]
      if (touch && pointerStart.y - touch.clientY >= 32) dismiss()
    }
    const onClick = () => {
      if (ignoreClick) { ignoreClick = false; return }
      dismiss()
    }
    curtain.addEventListener('click', onClick)
    curtain.addEventListener('keydown', onKey)
    curtain.addEventListener('pointerdown', onPointerDown)
    curtain.addEventListener('pointerup', onPointerUp)
    curtain.addEventListener('pointercancel', onPointerCancel)
    curtain.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      curtain.removeEventListener('click', onClick)
      curtain.removeEventListener('keydown', onKey)
      curtain.removeEventListener('pointerdown', onPointerDown)
      curtain.removeEventListener('pointerup', onPointerUp)
      curtain.removeEventListener('pointercancel', onPointerCancel)
      curtain.removeEventListener('touchmove', onTouchMove)
      if (finishTimer) window.clearTimeout(finishTimer)
    }
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    boundsDirtyRef.current = true
    const target = mode === 'strip' ? -imageStart(index) : 0
    renderX(target, false)
    if (mode === 'vertical') requestAnimationFrame(() => document.querySelector(`[data-image-id="${currentImage?.id}"]`)?.scrollIntoView({ block: 'start', behavior: 'auto' }))
  }, [mode])

  const applyStageMetrics = () => {
    const stage = stageRef.current
    if (!stage) return
    const visibleHeight = Math.max(1, Math.round(window.visualViewport?.height ?? window.innerHeight))
    stage.style.setProperty('--viewer-stage-height', `${visibleHeight}px`)
    const measured = { width: stage.clientWidth, height: stage.clientHeight, dpr: effectiveImageDpr(window.devicePixelRatio) }
    setStageSize((previous) => previous.width === measured.width && previous.height === measured.height && previous.dpr === measured.dpr ? previous : measured)
    boundsDirtyRef.current = true
    if (modeRef.current === 'strip') settleTo(-imageStart(indexRef.current), true)
  }

  useLayoutEffect(() => {
    applyStageMetrics()
  }, [])

  useEffect(() => {
    const stageElement = stageRef.current
    const onResize = () => {
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current)
      viewportFrameRef.current = requestAnimationFrame(() => {
        viewportFrameRef.current = null
        applyStageMetrics()
      })
    }
    const visualViewport = window.visualViewport
    const stageObserver = stageElement && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
    if (stageElement) stageObserver?.observe(stageElement)
    onResize()
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    visualViewport?.addEventListener('resize', onResize)
    visualViewport?.addEventListener('scroll', onResize)
    return () => {
      stageObserver?.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      visualViewport?.removeEventListener('resize', onResize)
      visualViewport?.removeEventListener('scroll', onResize)
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current)
    }
  }, [])

  useEffect(() => {
    boundsDirtyRef.current = true
    if (modeRef.current !== 'strip') return
    const frame = requestAnimationFrame(() => settleTo(-imageStart(indexRef.current), true, true))
    return () => cancelAnimationFrame(frame)
  }, [stageSize, seamMode])

  useEffect(() => () => {
    cancelPositionReport()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && anyModalOpenRef.current) {
        event.preventDefault()
        closeModals()
        return
      }
      if (anyModalOpenRef.current || !document.body.classList.contains('gallery-entered')) return
      if (event.key === 'ArrowRight') { event.preventDefault(); advanceStripByViewport(1) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); advanceStripByViewport(-1) }
      if (event.key === 'Home') { event.preventDefault(); goTo(0, true) }
      if (event.key === 'End') { event.preventDefault(); goTo(images.length - 1, true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // modalOpen/infoOpen deliberately absent: hono/jsx removes the old
    // listener at commit and re-arms it in a later async flush, so every
    // modal transition would unplug the handler for a few frames. The
    // gate reads anyModalOpenRef (written at event time) instead.
  }, [index, mode, images.length])

  // Magnifier availability is a media-query question, answered on the
  // client only: the server cannot know the pointer type, so the shortcut
  // row and the key binding appear after mount.
  useEffect(() => {
    setMagnifierAvailable(magnifierSupported())
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReducedMotion(query.matches)
    sync()
    query.addEventListener?.('change', sync)
    return () => query.removeEventListener?.('change', sync)
  }, [])

  useEffect(() => {
    if (!magnifierAvailable) return
    const handle = attachMagnifier(stageRef.current)
    magnifierRef.current = handle
    return () => {
      handle?.destroy()
      magnifierRef.current = null
    }
  }, [magnifierAvailable])

  // Opening either modal dismisses the lens: a loupe floating over a
  // dialog is both confusing and unreachable.
  useEffect(() => {
    if (!modalOpen && !infoOpen) return
    magnifierRef.current?.deactivate()
    setMagnifierActive(false)
  }, [modalOpen, infoOpen])

  useEffect(() => () => {
    magnifierRef.current?.destroy()
    magnifierRef.current = null
  }, [])

  // `M` toggles the lens under exactly the same gates as the nav keys.
  // Esc closes it when no modal is open (a modal's own Esc handler wins).
  useEffect(() => {
    if (!magnifierAvailable) return
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      // Never steal a keystroke from a text field.
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return
      if (event.key === 'Escape') {
        if (anyModalOpenRef.current) return
        if (!magnifierRef.current?.isActive()) return
        event.preventDefault()
        magnifierRef.current.deactivate()
        setMagnifierActive(false)
        return
      }
      if (event.key !== 'm' && event.key !== 'M') return
      if (anyModalOpenRef.current || !document.body.classList.contains('gallery-entered')) return
      event.preventDefault()
      const handle = magnifierRef.current
      if (!handle) return
      if (handle.isActive()) { handle.deactivate(); setMagnifierActive(false) }
      else { handle.activate(); setMagnifierActive(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // Same deliberate omission as the nav handler: re-arming on modal
    // transitions would leave a window where M/Esc presses vanish.
  }, [magnifierAvailable])

  // `I` is the magnifier's companion key: the stage keeps no button for it.
  // Same gates as the nav keys — no repeat spam (each press is a new tab),
  // never stolen from a text field, inert behind the curtain or a modal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return
      if (event.key !== 'i' && event.key !== 'I') return
      if (anyModalOpenRef.current || !document.body.classList.contains('gallery-entered')) return
      event.preventDefault()
      // ⇧I skips the external viewer and opens the in-gallery sheet
      // directly — it stays the fallback for sources the viewer can't
      // fetch, and a deliberate choice for everything else.
      if (event.shiftKey) openImageProvenance()
      else openCurrentImageInfo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      if (mode === 'vertical') return
      event.preventDefault()
      const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      if (mode === 'single') {
        if (Math.abs(delta) > 8) step(delta > 0 ? 1 : -1)
        return
      }
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientWidth : 1
      renderX(currentXRef.current + delta * factor * -1)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [mode, index])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage || mode !== 'single') return
    let startX = 0
    let swiping = false
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('button')) return
      startX = event.clientX
      swiping = true
      stage.setPointerCapture(event.pointerId)
    }
    const onPointerUp = (event: PointerEvent) => {
      // Only a pointerdown that armed a swipe may step — a pointerup that
      // bubbles up from a button click would otherwise read startX = 0
      // and fire a phantom back-step.
      if (!swiping) return
      swiping = false
      stage.releasePointerCapture?.(event.pointerId)
      const distance = event.clientX - startX
      if (Math.abs(distance) > 42) step(distance < 0 ? 1 : -1)
    }
    stage.addEventListener('pointerdown', onPointerDown)
    stage.addEventListener('pointerup', onPointerUp)
    stage.addEventListener('pointercancel', onPointerUp)
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown)
      stage.removeEventListener('pointerup', onPointerUp)
      stage.removeEventListener('pointercancel', onPointerUp)
    }
  }, [mode, index])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onPointerDown = (event: PointerEvent) => {
      if (mode !== 'strip' || (event.target as HTMLElement).closest('button')) return
      stopMomentum()
      draggingRef.current = true
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      dragTargetXRef.current = currentXRef.current
      dragSamplesRef.current = [{ x: 0, time: performance.now() }]
      stage.setPointerCapture(event.pointerId)
      stage.classList.add('is-dragging')
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return
      // Vertical thumb scroll counts toward the strip: swipe up slides
      // images right-to-left, swipe down slides them left-to-right.
      const move = event.clientX - lastPointerRef.current.x + event.clientY - lastPointerRef.current.y
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      dragTargetXRef.current += move
      const now = performance.now()
      const previous = dragSamplesRef.current.at(-1)?.x ?? 0
      dragSamplesRef.current.push({ x: previous + move, time: now })
      dragSamplesRef.current = dragSamplesRef.current.filter((sample) => now - sample.time < 100)
      scheduleDragTarget()
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!draggingRef.current) return
      flushDragTarget()
      draggingRef.current = false
      stage.releasePointerCapture?.(event.pointerId)
      stage.classList.remove('is-dragging')
      if (event.type === 'pointercancel' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const samples = dragSamplesRef.current
      const first = samples[0]
      const last = samples.at(-1)
      if (!first || !last) return
      const velocity = (last.x - first.x) / Math.max(16, last.time - first.time)
      const isTouch = event.pointerType === 'touch'
      let velocityPx = clamp(velocity * (isTouch ? 42 : 14), isTouch ? -42 : -18, isTouch ? 42 : 18)
      if (Math.abs(velocityPx) < 0.7) return
      let previousTime = performance.now()
      const glide = (now: number) => {
        const frameScale = clamp((now - previousTime) / (1000 / 60), 0.5, 2)
        previousTime = now
        velocityPx *= Math.pow(isTouch ? 0.9 : 0.8, frameScale)
        const next = renderX(currentXRef.current + velocityPx * frameScale)
        const bounds = getBounds()
        const atEdge = next === 0 || next === -bounds.max
        if (Math.abs(velocityPx) > (isTouch ? 0.18 : 0.25) && !atEdge) momentumRef.current = requestAnimationFrame(glide)
        else momentumRef.current = null
      }
      momentumRef.current = requestAnimationFrame(glide)
    }
    stage.addEventListener('pointerdown', onPointerDown)
    stage.addEventListener('pointermove', onPointerMove)
    stage.addEventListener('pointerup', onPointerUp)
    stage.addEventListener('pointercancel', onPointerUp)
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown)
      stage.removeEventListener('pointermove', onPointerMove)
      stage.removeEventListener('pointerup', onPointerUp)
      stage.removeEventListener('pointercancel', onPointerUp)
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current)
      stopMomentum()
    }
  }, [mode])

  // Escape and the Tab trap live on the dialog element itself — attached
  // at commit — while a render-synced ref lets the always-on window key
  // handler cover keys pressed with focus anywhere (e.g. Escape in the
  // first frames after opening, before a passive effect could attach a
  // document listener).
  const onModalKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); closeModals(); return }
    if (event.key !== 'Tab') return
    const modal = event.currentTarget as HTMLElement
    const focusable = [...modal.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  useEffect(() => {
    if (!modalOpen && !infoOpen) return
    const modal = modalOpen ? modalRef.current : infoModalRef.current
    // Settings → info is a nested open: keep the first invoker so closing
    // the sheet returns focus to the logo, not a now-hidden panel button.
    if (previousFocusRef.current === null) previousFocusRef.current = document.activeElement as HTMLElement
    requestAnimationFrame(() => {
      modal?.querySelector<HTMLElement>('[data-c2pa-panel]')?.scrollIntoView({ block: 'start' })
      modal?.querySelector<HTMLElement>('[data-close]')?.focus({ preventScroll: true })
    })
  }, [modalOpen, infoOpen])

  useEffect(() => {
    if (modalOpen || infoOpen) return
    if (previousFocusRef.current) {
      previousFocusRef.current.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [modalOpen, infoOpen])

  const openCredentials = async () => {
    if (!currentImage) return
    if (!currentImage.c2pa) {
      setCredentialState((previous) => ({ ...previous, [currentImage.id]: 'unavailable' }))
      return
    }
    setCredentialState((previous) => ({ ...previous, [currentImage.id]: 'loading' }))
    try {
      const [{ createC2pa }, _webComponents] = await Promise.all([
        import('@contentauth/c2pa-web') as Promise<{ createC2pa: (config: { wasmSrc: string }) => Promise<any> }>,
        import('c2pa-wc'),
      ])
      if (!c2paRef.current) c2paRef.current = await createC2pa({ wasmSrc: '/vendor/c2pa_bg.wasm' })
      const response = await fetch(currentImage.src, { cache: 'force-cache' })
      const blob = await response.blob()
      const c2paReader = await c2paRef.current.reader.fromBlob(blob.type, blob)
      const store = await c2paReader.manifestStore()
      const hasManifest = Boolean(store && JSON.stringify(store).length > 2)
      await c2paReader.free()
      if (hasManifest) setCredentialStores((previous) => ({ ...previous, [currentImage.id]: store }))
      setCredentialState((previous) => ({ ...previous, [currentImage.id]: hasManifest ? 'verified' : 'unavailable' }))
    } catch {
      setCredentialState((previous) => ({ ...previous, [currentImage.id]: 'unavailable' }))
    }
  }

  const openImageProvenance = () => {
    openImageInfo()
    if (currentImage?.c2pa && credentialState[currentImage.id] === 'idle') void openCredentials()
  }

  /** The external viewer fetches the file itself, so only absolute http(s)
   *  sources can travel — data/blob stubs and local files keep the
   *  in-gallery sheet, and so do videos (the viewer speaks stills). */
  const openCurrentImageInfo = () => {
    if (!currentImage) return
    const absolute = new URL(currentImage.src, window.location.href).href
    if (currentIsVideo || !/^https?:/i.test(absolute)) { openImageProvenance(); return }
    window.open(`${C2PA_VIEWER_URL}?uri=${encodeURIComponent(absolute)}`, '_blank', 'noopener')
  }

  // HEIC originals can't render in a browser, so decode them at full
  // resolution via libheif WASM — lazily, only when a frame enters the
  // active window. The 256px JPEG variant shows while decoding.
  // Videos never take the HEIC path: their src is an MP4 proxy URL and
  // their filename is a caption, which could otherwise end in ".heic".
  const isHeic = (image: GalleryMediaItem) => !isVideoItem(image) && /\.hei[cf]$/i.test(image.filename)
  const storeHeicSrc = (id: string, url: string) => {
    // A decode finishing after teardown must not retain the blob.
    if (unmountedRef.current) {
      URL.revokeObjectURL(url)
      return
    }
    heicUrlsRef.current.set(id, url)
    setHeicSrc((previous) => ({ ...previous, [id]: url }))
  }

  const decodeHeic = async (image: GalleryMediaItem) => {
    if (heicPendingRef.current.has(image.id)) return
    heicPendingRef.current.add(image.id)
    let blob: Blob | undefined
    try {
      const { default: heic2any } = await import('heic2any')
      const response = await fetch(image.src)
      if (!response.ok) throw new Error(`HEIC fetch failed: ${response.status}`)
      blob = await response.blob()
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
      // Older gallery records still point at JPEG renditions — a 'ftyp' box
      // means real HEIC; anything else (JPEG, WebP) renders directly.
      const isHeicBlob = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
      if (!isHeicBlob) {
        storeHeicSrc(image.id, URL.createObjectURL(blob))
        return
      }
      const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.95 })
      const out = Array.isArray(converted) ? converted[0] : converted
      storeHeicSrc(image.id, URL.createObjectURL(out))
    } catch {
      // libheif rejects some real HEIFs (10-bit, non-HEVC codecs, truncated
      // files). Hand the untouched bytes to the browser — Safari renders
      // HEIC natively; elsewhere the img's onError drops to the preview.
      storeHeicSrc(image.id, blob ? URL.createObjectURL(blob) : image.src)
    } finally {
      // Clear pending so a pruned entry can decode again on re-entry.
      heicPendingRef.current.delete(image.id)
    }
  }

  // Vertical mode stacks every frame in document flow, so index windows
  // mean nothing there — track the real viewport with an observer and keep
  // only what intersects (with a viewport of preload margin) plus a small
  // MRU tail of recently visible frames.
  useEffect(() => {
    if (mode !== 'vertical' || typeof IntersectionObserver === 'undefined') return
    const track = trackRef.current
    if (!track) return
    const visible = new Set<number>()
    const observer = new IntersectionObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const frameIndex = Number((entry.target as HTMLElement).dataset.index ?? 0) - 1
        if (frameIndex < 0) continue
        if (entry.isIntersecting) {
          if (!visible.has(frameIndex)) { visible.add(frameIndex); changed = true }
        } else if (visible.delete(frameIndex)) changed = true
      }
      if (!changed) return
      const tail = verticalMruRef.current.filter((i) => !visible.has(i))
      verticalMruRef.current = [...visible, ...tail].slice(0, visible.size + VERTICAL_RETAIN)
      setVerticalActive(new Set(verticalMruRef.current))
    }, { rootMargin: '100% 0px' })
    track.querySelectorAll<HTMLElement>('[data-index]').forEach((frame) => observer.observe(frame))
    return () => {
      observer.disconnect()
      verticalMruRef.current = []
      setVerticalActive(new Set())
    }
  }, [mode, images])

  /**
   * The ONE frame that may own a media element. `isFrameActive` is a
   * window (±3 in strip mode) — correct for images, wrong for video: it
   * would mount up to seven <video> elements, each fetching metadata.
   * A video mounts only on the current slide; every other frame, adjacent
   * or not, is its poster image alone.
   */
  const isVideoSlideActive = (imageIndex: number) =>
    galleryEntered && !modalOpen && !infoOpen && imageIndex === index && isFrameActive(imageIndex)

  const isFrameActive = (imageIndex: number) => {
    if (mode === 'vertical') {
      return typeof IntersectionObserver === 'undefined'
        ? Math.abs(imageIndex - index) <= 3
        : verticalActive.has(imageIndex)
    }
    return mode === 'strip' ? Math.abs(imageIndex - index) <= 3 : imageIndex === index
  }

  useEffect(() => {
    const keep = new Set<string>()
    images.forEach((image, imageIndex) => {
      if (!isFrameActive(imageIndex)) return
      keep.add(image.id)
      if (isHeic(image) && !heicSrc[image.id]) void decodeHeic(image)
    })
    // Decoded blobs are megabytes each — drop entries that leave the
    // window and revoke their object URLs.
    setHeicSrc((previous) => {
      const entries = Object.entries(previous)
      if (entries.every(([id]) => keep.has(id))) return previous
      const next: Record<string, string> = {}
      for (const [id, url] of entries) {
        if (keep.has(id)) next[id] = url
        else {
          heicUrlsRef.current.delete(id)
          URL.revokeObjectURL(url)
        }
      }
      return next
    })
  }, [index, mode, images, heicSrc, verticalActive])

  useEffect(() => () => {
    unmountedRef.current = true
    if (sweepTimerRef.current !== null) window.clearTimeout(sweepTimerRef.current)
    for (const url of heicUrlsRef.current.values()) URL.revokeObjectURL(url)
    heicUrlsRef.current.clear()
  }, [])

  // The watchdog's job: a mounted image that still hasn't decoded well
  // after it should have arrived is stalled or broken — re-request it
  // rather than leaving a blank frame. Two bounds keep it honest:
  // MAX_ATTEMPTS per image, and never while bytes are still moving
  // (Resource Timing exposes an in-flight fetch — a slow original is a
  // download, not a stall). data:/blob: bytes are final — nothing to
  // re-fetch — and lazy images are skipped until the browser asks.
  useEffect(() => {
    if (!galleryEntered) return
    const STALL_MS = 9000
    const MAX_ATTEMPTS = 2
    const tick = () => {
      const track = trackRef.current
      if (!track || navigator.onLine === false) return
      const now = performance.now()
      track.querySelectorAll<HTMLImageElement>('img.frame-img, img.frame-ph').forEach((img) => {
        if (img.loading === 'lazy') return
        if (img.complete && img.naturalWidth > 0) {
          watchdogSeenRef.current.delete(img)
          return
        }
        const seen = watchdogSeenRef.current.get(img)
        if (seen === undefined) {
          watchdogSeenRef.current.set(img, now)
          return
        }
        if (now - seen < STALL_MS) return
        const href = img.currentSrc || img.src
        const entries = performance.getEntriesByName(href) as PerformanceResourceTiming[]
        const latest = entries[entries.length - 1]
        if (latest && latest.responseStart > 0 && latest.responseEnd === 0) return
        const id = img.closest<HTMLElement>('.viewer-frame')?.dataset.imageId
        const src = img.getAttribute('src') ?? ''
        const retryable = /^https?:\/\//i.test(src) || src.startsWith('/')
        const attempts = id ? (watchdogAttemptsRef.current[id] ?? 0) : MAX_ATTEMPTS
        if (!id || !retryable || attempts >= MAX_ATTEMPTS) {
          // Park it — a permanently dead image shouldn't re-arm forever.
          watchdogSeenRef.current.set(img, Number.POSITIVE_INFINITY)
          return
        }
        watchdogAttemptsRef.current[id] = attempts + 1
        watchdogSeenRef.current.delete(img)
        // Re-request imperatively: a bumped prop would route through the
        // vnode diff, but the stash can point at a detached node after
        // remounts — the live element is what needs the new fetch.
        const clean = src.replace(/([?&])mreload=\d+&?/, '$1').replace(/[?&]$/, '')
        img.src = `${clean}${clean.includes('?') ? '&' : '?'}mreload=${attempts + 1}`
      })
    }
    const interval = window.setInterval(tick, 2500)
    return () => window.clearInterval(interval)
  }, [galleryEntered])

  useEffect(() => {
    if (!currentImage || credentialState[currentImage.id] !== 'verified') return
    const summary = document.querySelector('cai-manifest-summary') as HTMLElement & { manifestStore?: unknown } | null
    if (summary && credentialStores[currentImage.id]) summary.manifestStore = credentialStores[currentImage.id]
  }, [credentialState, credentialStores, currentImage?.id])

  const recallCurtain = () => {
    const curtain = document.querySelector<HTMLElement>('[data-curtain]')
    if (curtain) {
      curtain.classList.remove('is-lifting')
      curtain.hidden = false
      curtain.removeAttribute('aria-hidden')
      document.body.classList.remove('gallery-entered')
      setGalleryEntered(false)
    }
    closeModals()
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch {
      // Some mobile browsers intentionally do not allow element fullscreen.
    }
  }

  const seamInset = seamMode === 'none' ? 0 : mode === 'strip' ? 20 : mode === 'vertical' ? 10 : 0
  const seamTop = seamMode === 'none' || mode === 'single' ? 0 : 10

  return (
    <>
      <div
        ref={stageRef}
        class={`viewer-stage mode-${mode} seam-${seamMode}`}
        data-stage
        aria-label={`${slug} photograph viewer`}
        tabIndex={-1}
      >
        <div
          ref={trackRef}
          class={`viewer-track ${mode === 'vertical' ? 'viewer-track--vertical' : ''} ${mode === 'single' ? 'viewer-track--single' : ''}`}
          data-track
          data-sweep-dir={mode === 'single' ? sweepDir : undefined}
        >
          {images.map((image, imageIndex) => {
            const isActive = isFrameActive(imageIndex)
            // Single mode also keeps the outgoing frame's media mounted
            // through the sweep, and pre-mounts the immediate neighbours
            // so a step starts from decoded pixels, not a fetch.
            const mountsMedia = isActive || (mode === 'single' && (imageIndex === leavingIndex || Math.abs(imageIndex - index) <= 1))
            const healed = healedDims[image.id]
            const frameW = healed?.w ?? image.width
            const frameH = healed?.h ?? image.height
            const isPortrait = frameH > frameW
            const video = isVideoItem(image) ? image : null
            const staged = video ? null : imageStageSize({
              mode,
              naturalWidthPx: frameW,
              naturalHeightPx: frameH,
              stageWidthCssPx: stageSize.width - (mode === 'strip' ? 0 : seamInset),
              stageHeightCssPx: stageSize.height - (mode === 'vertical' ? 0 : seamInset),
              dpr: stageSize.dpr,
            })
            const stagedStyle = staged && staged.width > 0 && staged.height > 0 ? { width: `${staged.width}px`, height: `${staged.height}px` } : undefined
            return (
              <figure
                class={`viewer-frame ${isPortrait ? 'viewer-frame--portrait' : 'viewer-frame--landscape'} ${mode === 'single' ? (imageIndex === index ? (leavingIndex === null ? '' : 'viewer-frame--entering') : imageIndex === leavingIndex ? 'viewer-frame--leaving' : 'viewer-frame--hidden') : ''} ${video ? 'viewer-frame--video' : ''}`}
                data-image-id={image.id}
                data-index={imageIndex + 1}
                data-orientation={isPortrait ? 'portrait' : 'landscape'}
                data-media-type={video ? 'video' : 'image'}
                aria-current={imageIndex === index ? 'true' : undefined}
                aria-hidden={mode === 'single' && imageIndex !== index ? 'true' : undefined}
                style={mode === 'strip' ? staged && staged.width > 0 && (healed || staged.height >= stageSize.height - seamInset - 0.5) ? { width: `${staged.width + seamTop}px` } : { aspectRatio: `${frameW} / ${frameH}` } : mode === 'vertical' && !video ? staged && staged.height > 0 ? { width: '100%', height: `${staged.height + seamTop}px` } : { width: '100%', aspectRatio: `${frameW} / ${frameH}` } : undefined}
              >
                {video ? (
                  <>
                    {/* The poster is the whole frame until the video is the
                        active slide: adjacent frames cost one image, and
                        non-adjacent frames mount no media element at all. */}
                    <img
                      class="frame-ph"
                      src={video.poster.src}
                      alt={isVideoSlideActive(imageIndex) ? '' : video.alt}
                      aria-hidden={isVideoSlideActive(imageIndex) ? 'true' : undefined}
                      width={frameW}
                      height={frameH}
                      decoding="async"
                      loading={isActive ? 'eager' : 'lazy'}
                    />
                    {isVideoSlideActive(imageIndex) ? (
                      <VideoSlide
                        item={video}
                        isActive
                        soundOn={soundOn}
                        prefersReducedMotion={reducedMotion}
                        onToggleSound={setSoundOn}
                      />
                    ) : null}
                  </>
                ) : (
                <>
                <img
                  class="frame-ph"
                  src={isActive && isHeic(image) ? image.variants?.[0]?.src ?? image.placeholder : image.placeholder}
                  alt=""
                  aria-hidden="true"
                  width={frameW}
                  height={frameH}
                  decoding="async"
                  loading={isActive ? 'eager' : 'lazy'}
                />
                {mountsMedia && (isHeic(image) ? heicSrc[image.id] : image.src) ? (
                  <img
                    class="frame-img"
                    src={isHeic(image) ? heicSrc[image.id] : image.src}
                    data-full-src={image.src}
                    data-active={isActive ? 'true' : undefined}
                    alt={image.alt}
                    width={frameW}
                    height={frameH}
                    style={stagedStyle}
                    decoding="async"
                    loading="eager"
                    onError={(event: Event) => {
                      // A hard failure is already "stuck" — flag it so
                      // the watchdog re-requests on its next pass rather
                      // than waiting out the full stall window.
                      watchdogSeenRef.current.set(event.currentTarget as HTMLImageElement, 0)
                      if (!isHeic(image)) return
                      // The browser couldn't decode the fallback HEIC bytes
                      // either — swap to the JPEG preview so the frame still
                      // shows a full-size image, not just the stretched thumb.
                      const preview = image.variants?.[0]?.src ?? image.placeholder
                      if (preview && heicSrc[image.id] !== preview) storeHeicSrc(image.id, preview)
                    }}
                    onLoad={(event: Event) => {
                      const img = event.currentTarget as HTMLImageElement
                      img.classList.add('is-loaded')
                      // Records can carry guessed dims (4:3 fallback, stale
                      // scans): once the real pixels decode, reshape the
                      // frame so geometry always matches the photograph.
                      if (img.naturalWidth && img.naturalHeight && (img.naturalWidth !== frameW || img.naturalHeight !== frameH)) {
                        const frame = img.closest<HTMLElement>('.viewer-frame')
                        if (frame) {
                          const healed = { w: img.naturalWidth, h: img.naturalHeight }
                          setHealedDims((previous) => previous[image.id]?.w === healed.w && previous[image.id]?.h === healed.h ? previous : { ...previous, [image.id]: healed })
                          if (mode === 'strip') {
                            const oldWidth = frame.offsetWidth
                            frame.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
                            // The strip frame hugs the staged image, so the
                            // heal must land the new width now — before the
                            // rAF delta measures the track shift.
                            const restaged = imageStageSize({
                              mode: 'strip',
                              naturalWidthPx: img.naturalWidth,
                              naturalHeightPx: img.naturalHeight,
                              stageWidthCssPx: stageSize.width,
                              stageHeightCssPx: stageSize.height - seamInset,
                              dpr: stageSize.dpr,
                            })
                            if (restaged.width > 0) frame.style.width = `${restaged.width + seamTop}px`
                            // A corrected frame changes track geometry —
                            // drop the cached bounds, then once layout
                            // settles either carry an in-flight nav across
                            // the shift or dock on the frame holding the
                            // stage's left edge.
                            boundsDirtyRef.current = true
                            requestAnimationFrame(() => {
                              const delta = frame.offsetWidth - oldWidth
                              if (delta !== 0 && momentumRef.current !== null && navDestXRef.current !== null && frame.offsetLeft < -navDestXRef.current) {
                                navDestXRef.current -= delta
                              }
                              // An in-flight navigation chases navDestX
                              // live, so the shift is already absorbed.
                              // When nothing is animating — idle, or the
                              // stale window between animation end and the
                              // position report clearing navDestX — dock
                              // on the frame actually holding the left
                              // edge, or the strip is left delta-px off.
                              if (momentumRef.current !== null && navDestXRef.current !== null) return
                              navDestXRef.current = null
                              const docked = leftmostFrameIndex(-currentXRef.current)
                              reportedIndexRef.current = docked
                              setIndex(docked)
                              settleTo(-imageStart(docked), true, true)
                            })
                          }
                          frame.classList.toggle('viewer-frame--portrait', img.naturalHeight > img.naturalWidth)
                          frame.classList.toggle('viewer-frame--landscape', img.naturalHeight <= img.naturalWidth)
                        }
                      }
                    }}
                  />
                ) : null}
                </>
                )}
              </figure>
            )
          })}
        </div>
        {/* data-magnifier-ignore: the lens mirrors photographs, not the
            page's own controls. */}
        {arrowsVisible ? (
          <div class="stage-arrows" data-magnifier-ignore role="group" aria-label="Image navigation">
            <button data-nav-arrow aria-label="Previous photograph" onClick={() => advanceStripByViewport(-1)} disabled={mode === 'single' && index === 0}>←</button>
            <button ref={nextArrowRef} data-nav-arrow aria-label="Next photograph" onClick={() => advanceStripByViewport(1)} disabled={mode === 'single' && index === images.length - 1}>→</button>
          </div>
        ) : null}
      </div>

      <button ref={dotRef} class="control-logo" aria-label="Display settings" title="Display settings" onClick={openDisplaySettings}><span class="brand-mark-wrap"><img src="/manorama-merged-logo.png" alt="" aria-hidden="true" /><span class="brand-tld" aria-hidden="true">.xyz</span></span></button>

      <div
        ref={modalRef}
        class="controls-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Display settings"
        hidden={!modalOpen}
        onClick={(event) => { if (event.target === event.currentTarget) closeModals() }}
        onKeyDown={onModalKeyDown}
      >
        <div class="controls-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">{slug.replaceAll('-', ' ')}</p>
              <h2>Display settings</h2>
            </div>
            <button data-close class="quiet-button" aria-label="Close display settings" onClick={() => closeModals()}>Close</button>
          </div>

          <section class="panel-section" aria-labelledby="view-mode-heading">
            <h3 id="view-mode-heading">View mode</h3>
            <div class="mode-options" role="radiogroup" aria-label="View mode">
              <label><input type="radio" name="view-mode" value="strip" checked={mode === 'strip'} onChange={() => { setMode('strip'); closeModals() }} /> <span>Horizontal Strip</span><small>full-height, continuous</small></label>
              <label><input type="radio" name="view-mode" value="vertical" checked={mode === 'vertical'} onChange={() => { setMode('vertical'); closeModals() }} /> <span>Vertical scroll</span><small>landscapes to width, portraits to height</small></label>
              <label><input type="radio" name="view-mode" value="single" checked={mode === 'single'} onChange={() => { setMode('single'); closeModals() }} /> <span>One at a time</span><small>advance per gesture</small></label>
            </div>
          </section>

          <section class="panel-section" aria-labelledby="background-heading">
            <h3 id="background-heading">Background</h3>
            <div class="mode-options" role="radiogroup" aria-label="Background behind photographs">
              <label><input type="radio" name="seam-mode" value="dark" checked={seamMode === 'dark'} onChange={() => setSeamMode('dark')} /> <span>Dark</span><small>light stripes on black</small></label>
              <label><input type="radio" name="seam-mode" value="light" checked={seamMode === 'light'} onChange={() => setSeamMode('light')} /> <span>Light</span><small>black stripes on light</small></label>
              <label><input type="radio" name="seam-mode" value="none" checked={seamMode === 'none'} onChange={() => setSeamMode('none')} /> <span>None</span><small>photographs sit flush</small></label>
            </div>
          </section>

          <section class="panel-section compact-section" aria-label="Display options">
            <div class="panel-actions">
              {mode === 'vertical' ? null : <button type="button" class="panel-action" onClick={() => { setShowArrows(!showArrows); closeModals() }}>{showArrows ? 'Hide navigation arrows' : 'Show navigation arrows'}</button>}
              {fullscreenAvailable ? <button type="button" class="panel-action" onClick={() => { toggleFullscreen(); closeModals() }}>{fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'}</button> : null}
              {galleryEntered ? <button type="button" class="panel-action" onClick={recallCurtain}>Recall the opening curtain</button> : null}
            </div>
          </section>

          <section class="panel-section" aria-labelledby="about-heading" hidden>
            <h3 id="about-heading">About this gallery</h3>
            <p class="about-copy">This single-album gallery is shared as one quiet sequence. Its images are served as originals where possible; non-credentialed responsive derivatives preserve the embedded colour profile.</p>
          </section>

          <section class="panel-section shortcuts" aria-labelledby="shortcuts-heading">
            <h3 id="shortcuts-heading">Keyboard shortcuts</h3>
            <p><kbd>←</kbd><kbd>→</kbd> move between photographs</p>
            <p><kbd>Home</kbd><kbd>End</kbd> jump to the ends</p>
            {/* Pointer-gated: a loupe replacing the cursor means nothing
                on a touch device, so the row only exists where the key
                actually works. */}
            {magnifierAvailable ? <p><kbd>M</kbd> magnify under the cursor{magnifierActive ? ' (on)' : ''}</p> : null}
            <p><kbd>I</kbd> image info in the c2pa viewer (new tab) — <kbd>⇧I</kbd> opens the in-gallery sheet</p>
            <p><kbd>Esc</kbd> close controls</p>
          </section>
        </div>
      </div>

      <div
        ref={infoModalRef}
        class="controls-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Image information and Content Credentials"
        hidden={!infoOpen}
        onClick={(event) => { if (event.target === event.currentTarget) closeModals() }}
        onKeyDown={onModalKeyDown}
      >
        <div class="controls-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">{slug.replaceAll('-', ' ')}</p>
              <h2>{currentIsVideo ? 'Current video' : 'Current photograph'}</h2>
            </div>
            <button data-close class="quiet-button" aria-label="Close image information" onClick={() => closeModals()}>Close</button>
          </div>

          <section class="panel-section" aria-labelledby="position-heading">
            <div class="section-heading"><h3 id="position-heading">Position</h3><span class="position-value">{index + 1} / {images.length}</span></div>
            <p class="quiet-copy">{currentIsVideo ? 'Video' : 'Photograph'} {index + 1} of {images.length}</p>
          </section>

          <section class="panel-section" aria-labelledby="info-heading">
            <h3 id="info-heading">{currentIsVideo ? 'Video info' : 'Image info'}</h3>
            <dl class="info-grid">
              <div><dt>File</dt><dd>{currentImage?.filename}</dd></div>
              <div><dt>Dimensions</dt><dd>{currentImage?.width} × {currentImage?.height}</dd></div>
              {currentVideo ? <div><dt>Type</dt><dd>Video ({currentVideo.mimeType})</dd></div> : null}
              {currentVideo?.durationSeconds ? <div><dt>Duration</dt><dd>{formatDuration(currentVideo.durationSeconds)}</dd></div> : null}
              {currentExif?.camera ? <div><dt>Camera</dt><dd>{currentExif.camera}</dd></div> : null}
              {currentExif?.lens ? <div><dt>Lens</dt><dd>{currentExif.lens}</dd></div> : null}
              {currentExif?.aperture ? <div><dt>Aperture</dt><dd>{currentExif.aperture}</dd></div> : null}
              {currentExif?.iso ? <div><dt>ISO</dt><dd>{currentExif.iso}</dd></div> : null}
              {currentExif?.dateOriginal ? <div><dt>Captured</dt><dd>{currentExif.dateOriginal}</dd></div> : null}
            </dl>
          </section>

          <section class="panel-section" data-c2pa-panel aria-labelledby="credentials-heading">
            <div class="section-heading"><h3 id="credentials-heading">Content Credentials</h3><span class="credential-mark" aria-hidden="true">C2PA</span></div>
            {!currentImage?.c2pa ? <p class="quiet-copy">{currentIsVideo ? 'This video carries no Content Credentials.' : 'This photograph carries no Content Credentials.'}</p> : credentialState[currentImage.id] === 'loading' ? <p class="quiet-copy">Checking Content Credentials locally…</p> : credentialState[currentImage.id] === 'verified' ? <><p class="quiet-copy credential-success">Content Credentials verified in this browser.</p><cai-manifest-summary manifestStore={credentialStores[currentImage.id]}></cai-manifest-summary></> : credentialState[currentImage.id] === 'unavailable' ? <><p class="quiet-copy">Content Credentials are present, but could not be validated in this browser session.</p><button class="text-button" onClick={openCredentials}>Try verification again</button></> : <><p class="quiet-copy">This photograph carries embedded Content Credentials.</p><button class="text-button" onClick={openCredentials}>Verify in this browser</button></>}
          </section>
        </div>
      </div>
    </>
  )
}
