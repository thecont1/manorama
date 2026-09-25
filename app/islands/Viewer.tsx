import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'hono/jsx'
import { isVideoItem, type GalleryImage, type GalleryMediaItem, type VideoItem } from '../lib/imagesource'
import { imageWithSettings, loadStoredGallerySettings, type GallerySettings } from '../lib/gallery-settings'
import { attachMagnifier, magnifierSupported, type MagnifierHandle } from '../lib/magnifier'
import { effectiveImageDpr, imageStageSize, videoStageSize } from '../lib/image-staging'
import VideoSlide, { formatDuration } from './VideoSlide'
import { connectionOf, videoMountsFor, type ConnectionLike } from '../lib/video-playback'
import SeededDoodleBackground from './SeededDoodleBackground'
import { BACKGROUND_EVENT, backgroundPreferenceFromEvent, loadBackgroundPreference, saveBackgroundPreference, type BackgroundPreference } from '../lib/background-preference'
import { AD_BANNER_HEIGHT, AD_BANNER_WIDTH, plateIndexFor, type AdFrame } from '../lib/adframe'
import { clamp, glideEase } from '../lib/sizing'
import type { FoldLayout, FoldSegment } from '../../packages/core/fold'

type Mode = 'strip' | 'vertical' | 'single'
type DragSample = { x: number; time: number }
type Props = {
  slug: string
  images: readonly GalleryMediaItem[]
  settings: GallerySettings
  plate?: AdFrame | null
  /** Mount-time frame entry — the global grid lands the stage on the tapped
   *  frame instead of the first photograph. Applied once; later navigation
   *  belongs to the viewer. */
  initialIndex?: number
  foldLayout?: FoldLayout | null
  foldRenderer?: (props: {
    frames: readonly GalleryMediaItem[]
    activeIndex: number
    segments: readonly FoldSegment[]
    dpr: number
  }) => unknown
}

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

/** The video size caps are a desktop rule: a phone keeps the full-bleed
 *  clip. "Desktop" here means a real pointer on a screen wide enough for
 *  the restraint to read as composition rather than a bug — the same
 *  720px line the stylesheet already treats as the mobile breakpoint. */
const DESKTOP_VIDEO_QUERY = '(min-width: 721px) and (pointer: fine)'

/** Keystrokes belong to the viewer unless focus sits in a text-entry
 *  field. Non-text inputs (radio, checkbox, range, …) never receive
 *  typed characters, so letting shortcuts through keeps I/M/Esc alive
 *  right after a mode radio is clicked. */
const isTypingTarget = (el: HTMLElement | null) =>
  !!el && (el.isContentEditable || /^(textarea|select)$/i.test(el.tagName) ||
    (/^input$/i.test(el.tagName) &&
      !/^(button|checkbox|radio|range|file|image|submit|reset|color|hidden)$/i.test((el as HTMLInputElement).type)))

/** In vertical mode, frames beyond the viewport stay active only up to this
 *  many past the visible set — enough to not thrash on small scrolls, bounded
 *  so decoded HEIC blobs get revoked as frames scroll away. */
const VERTICAL_RETAIN = 6

/** Strip mode's decoded window: frames within this many of the leftmost
 *  visible frame mount eagerly. */
const STRIP_WINDOW = 3

/** Frames that just left the strip window stay mounted for this many more
 *  index changes — panning back and forth doesn't re-mount and re-fetch —
 *  bounded so decoded HEIC blobs still get revoked once out of play. */
const STRIP_RETAIN = 6

/** Anonymous per-gallery viewing preferences: the view mode is
 *  remembered in localStorage keyed by gallery slug, so a link recipient
 *  keeps their own preference without an account. The doodle background
 *  is deliberately NOT here — it is app-wide chrome, stored globally in
 *  lib/background-preference.ts alongside the theme. */
type ViewPrefs = { mode?: Mode }
const readViewPrefs = (slug: string): ViewPrefs => {
  try {
    const stored = JSON.parse(localStorage.getItem(`manorama:view:${slug}`) ?? '{}') as ViewPrefs
    return {
      mode: stored.mode && ['strip', 'vertical', 'single'].includes(stored.mode) ? stored.mode : undefined,
    }
  } catch {
    return {}
  }
}

/** Renders a gallery in strip, vertical, or single-image mode. Still images
 *  preserve their aspect ratio, fit height-first in strip mode, width-first in
 *  vertical mode, and within both axes in single mode without upscaling. */
export default function Viewer({ slug, images: sourceImages, settings: initialSettings, plate = null, initialIndex = 0, foldLayout = null, foldRenderer }: Props) {
  const [settings, setSettings] = useState<GallerySettings>(initialSettings)
  const images = useMemo(() => sourceImages.map((image) => imageWithSettings(image, settings)), [sourceImages, settings])
  const viewPrefs = useMemo(() => (typeof localStorage === 'undefined' ? {} : readViewPrefs(slug)), [slug])
  const [mode, setMode] = useState<Mode>(viewPrefs.mode ?? initialSettings.defaultMode)
  const [index, setIndex] = useState(() => clamp(initialIndex, 0, Math.max(0, sourceImages.length - 1)))
  const [modalOpen, setModalOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [gridOpen, setGridOpen] = useState(false)
  const [gridSel, setGridSel] = useState(index)
  const [gridClosing, setGridClosing] = useState(false)
  const gridOpenRef = useRef(false)
  const [showArrows, setShowArrows] = useState(initialSettings.defaultShowArrows)
  // Vertical scroll keeps arrows off by default regardless of the
  // gallery-wide setting — the feed scrolls natively, so they're only
  // ever an opt-in.
  const [showArrowsVertical, setShowArrowsVertical] = useState(false)
  // Background: an app-wide preference. 'none' (the default) keeps
  // photographs abutting on the bare dark canvas; light and dark wake
  // the doodle field and give every image a 10px margin. Read as 'none'
  // for SSR, then reconciled on mount so server and client markup agree
  // during hydration.
  const [background, setBackground] = useState<BackgroundPreference>('none')
  const [showCaptions, setShowCaptions] = useState(initialSettings.defaultShowCaptions)
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false)
  const [fullscreenActive, setFullscreenActive] = useState(false)
  const [credentialState, setCredentialState] = useState<Record<string, 'idle' | 'loading' | 'verified' | 'unavailable'>>({})
  const [credentialStores, setCredentialStores] = useState<Record<string, unknown>>({})
  const [heicSrc, setHeicSrc] = useState<Record<string, string>>({})
  // One-at-a-time sweep: the outgoing frame stays mounted and fully
  // opaque while the incoming frame wipes over it behind an opaque
  // canvas card — no transparency ever lands on the background field.
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
  // Under a visible background (Light/Dark) every image carries a 10px
  // margin: strip frames stage against a stage 20px shorter so height-fit
  // images get 10px bands top and bottom, vertical rows against a stage
  // 20px narrower for 10px rails left and right. The trailing gutter —
  // right in strip, bottom in vertical — is frame margin in CSS. 'none'
  // stages against the raw stage, so photographs abut edge to edge.
  const imageMarginPx = background !== 'none' ? 10 : 0
  const stagingWidth = Math.max(0, stageSize.width - (mode === 'vertical' ? imageMarginPx * 2 : 0))
  const stagingHeight = Math.max(0, stageSize.height - (mode === 'strip' ? imageMarginPx * 2 : 0))
  // Viewer-level sound: once a visitor unmutes, every subsequently
  // activated video starts audible. Deliberately NOT persisted — it
  // resets when the viewer unmounts, so a fresh visit is always quiet.
  const [soundOn, setSoundOn] = useState(false)
  const [magnifierActive, setMagnifierActive] = useState(false)
  const [magnifierAvailable, setMagnifierAvailable] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  // Desktop gates the video size caps. False during SSR and the hydration
  // render so server and client markup agree; the mount effect reconciles.
  const [isDesktop, setIsDesktop] = useState(false)
  // Network quality, for the "stay a still image on a poor connection"
  // rule. Starts undefined so SSR and the hydration render agree (the
  // server has no navigator); the mount effect reconciles it.
  const [connection, setConnection] = useState<ConnectionLike | undefined>(undefined)
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
  const gridModalRef = useRef<HTMLDivElement | null>(null)
  const filmstripFrameRef = useRef<HTMLDivElement | null>(null)
  const filmstripPanRef = useRef<{ pointerId: number; x: number; scrollLeft: number } | null>(null)
  const scrollLeftAtDownRef = useRef(0)
  const gridSuppressClickRef = useRef(false)
  const gridCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dotRef = useRef<HTMLButtonElement | null>(null)
  const seqRef = useRef<HTMLButtonElement | null>(null)
  const nextArrowRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  // "A modal is open" for always-on window key handlers: hono/jsx applies
  // the state write synchronously but commits the render later, so both
  // closures and render-synced values lag a setState call. The open/close
  // helpers write this at event time; the render line is the backstop.
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = modalOpen || infoOpen || gridOpen
  const openDisplaySettings = () => { anyModalOpenRef.current = true; setModalOpen(true) }
  const openImageInfo = () => { anyModalOpenRef.current = true; setInfoOpen(true) }
  const openGrid = () => {
    if (gridCloseTimerRef.current) {
      clearTimeout(gridCloseTimerRef.current)
      gridCloseTimerRef.current = null
    }
    anyModalOpenRef.current = true
    gridOpenRef.current = true
    setGridSel(indexRef.current)
    setGridClosing(false)
    setGridOpen(true)
  }
  const closeModals = () => {
    anyModalOpenRef.current = false
    gridOpenRef.current = false
    setModalOpen(false)
    setInfoOpen(false)
    setGridOpen(false)
    setGridClosing(false)
  }
  const requestCloseModals = () => {
    if (!gridOpenRef.current) { closeModals(); return }
    if (gridCloseTimerRef.current) return
    setGridClosing(true)
    gridCloseTimerRef.current = setTimeout(() => {
      gridCloseTimerRef.current = null
      closeModals()
    }, 180)
  }
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
  const foldActiveRef = useRef(false)
  // The fold index an in-flight step is heading for. Rapid wheel ticks and
  // key repeats land before the next render commits, so each step anchors
  // at this pending destination — the fold twin of navDestXRef.
  const pendingFoldIndexRef = useRef<number | null>(null)
  const reportedIndexRef = useRef(index)
  // Seed a small window so the first vertical paint isn't placeholder-only;
  // the IntersectionObserver takes over immediately after mount.
  const [verticalActive, setVerticalActive] = useState<ReadonlySet<number>>(() => new Set([0, 1, 2]))
  const verticalMruRef = useRef<number[]>([])
  const [stripActive, setStripActive] = useState<ReadonlySet<number>>(() => new Set([0, 1, 2, 3]))
  const stripMruRef = useRef<number[]>([])
  const positionFrameRef = useRef<number | null>(null)
  const viewportFrameRef = useRef<number | null>(null)
  const plateActionFrameRef = useRef<number | null>(null)
  const plateActionableRef = useRef(false)
  const boundsRef = useRef({ min: 0, max: 0 })
  const boundsDirtyRef = useRef(true)
  // The "The End." card is mounted in the track but excluded from the
  // pan range until the visitor pushes past the last photograph — then
  // it joins the bounds and stays reachable for the session.
  const endcapRevealedRef = useRef(false)
  // Mirrored into state purely so the card's "Back to Start" link can
  // join the tab order only while it is on screen — bounds math keeps
  // reading the ref synchronously.
  const [endcapRevealed, setEndcapRevealed] = useState(false)
  const [plateActionable, setPlateActionable] = useState(false)

  const currentImage = images[index] ?? images[0]
  const plateIndex = plateIndexFor(images.length)
  // Fold presentation is a native enhancement of strip mode. Ad plates retain
  // the ordinary strip so the one-plate policy is never bypassed by a layout
  // change; Pro galleries can use both physical segments without extra chrome.
  const foldActive = mode === 'strip' && !plate && foldLayout?.mode === 'diptych' && Boolean(foldRenderer)
  foldActiveRef.current = foldActive
  // The info panel speaks about whichever medium is on screen, and EXIF
  // only exists on photographs — narrow once here rather than at each use.
  const currentVideo = currentImage && isVideoItem(currentImage) ? currentImage : null
  const currentIsVideo = Boolean(currentVideo)
  const currentExif = currentImage && !isVideoItem(currentImage) ? currentImage.exif : undefined

  const plateIsCentered = () => {
    if (!plate || mode !== 'strip' || draggingRef.current || momentumRef.current !== null) return false
    const stage = stageRef.current
    const mount = trackRef.current?.querySelector<HTMLElement>('[data-ad-frame]')
    if (!stage || !mount) return false
    const stageRect = stage.getBoundingClientRect()
    const mountRect = mount.getBoundingClientRect()
    return Math.abs((mountRect.left + mountRect.width / 2) - (stageRect.left + stageRect.width / 2)) < 2
  }

  // Transform writes happen outside the render cycle. Re-measure after the
  // browser has committed that transform so the CTA can enter the tab order
  // when the plate actually settles, not only when some unrelated state change
  // happens to re-render the island.
  const queuePlateActionability = () => {
    if (plateActionFrameRef.current !== null) return
    plateActionFrameRef.current = requestAnimationFrame(() => {
      plateActionFrameRef.current = null
      const actionable = plateIsCentered()
      plateActionableRef.current = actionable
      setPlateActionable(actionable)
    })
  }

  const setPlateActionability = (actionable: boolean) => {
    plateActionableRef.current = actionable
    setPlateActionable(actionable)
  }

  const plateCanActivate = () => plateActionableRef.current && !draggingRef.current && momentumRef.current === null

  useEffect(() => {
    queuePlateActionability()
    return () => {
      if (plateActionFrameRef.current !== null) cancelAnimationFrame(plateActionFrameRef.current)
      plateActionFrameRef.current = null
    }
  }, [plate, mode, images.length])

  useLayoutEffect(() => { indexRef.current = index; pendingFoldIndexRef.current = null }, [index])
  useEffect(() => { modeRef.current = mode }, [mode])

  // Background preference is global chrome: adopt the stored value after
  // mount (SSR cannot read localStorage), then stay in sync with other
  // tabs and with any other island that changes it.
  useEffect(() => {
    setBackground(loadBackgroundPreference())
    const syncFromStorage = () => setBackground(loadBackgroundPreference())
    const syncFromEvent = (event: Event) => setBackground(backgroundPreferenceFromEvent(event as CustomEvent<unknown>))
    window.addEventListener('storage', syncFromStorage)
    window.addEventListener(BACKGROUND_EVENT, syncFromEvent)
    return () => {
      window.removeEventListener('storage', syncFromStorage)
      window.removeEventListener(BACKGROUND_EVENT, syncFromEvent)
    }
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(`manorama:view:${slug}`, JSON.stringify({ mode }))
    } catch {
      // Storage can be unavailable (private mode) — preferences are best-effort.
    }
  }, [slug, mode])

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
  const arrowsOn = mode === 'vertical' ? showArrowsVertical : showArrows
  const arrowsVisible = arrowsOn && hasMultiple

  const getBounds = () => {
    if (!boundsDirtyRef.current) return boundsRef.current
    const viewport = stageRef.current?.clientWidth ?? window.innerWidth
    const content = trackRef.current?.scrollWidth ?? 0
    let max = Math.max(0, content - viewport)
    // The "The End." card stays out of the pan range until the visitor
    // pushes past the last photograph — subtract its footprint (width
    // plus its trailing margin) while it is unrevealed.
    if (!endcapRevealedRef.current) {
      const cap = trackRef.current?.querySelector<HTMLElement>('.viewer-endcap')
      if (cap) max = Math.max(0, max - cap.offsetWidth - imageMarginPx)
    }
    boundsRef.current = { min: 0, max }
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

  // The endcard joins the pan range the first time a gesture pushes past
  // the last photograph, and is disarmed by its own "Back to Start" link
  // so a return visit earns the reveal again.
  const revealEndcap = () => {
    if (endcapRevealedRef.current) return
    endcapRevealedRef.current = true
    setEndcapRevealed(true)
    boundsDirtyRef.current = true
  }

  const backToStart = () => {
    endcapRevealedRef.current = false
    setEndcapRevealed(false)
    boundsDirtyRef.current = true
    goTo(0)
  }

  const reportStripPosition = () => {
    if (positionFrameRef.current !== null) return
    positionFrameRef.current = requestAnimationFrame(() => {
      positionFrameRef.current = null
      const stage = stageRef.current
      const track = trackRef.current
      if (!stage || !track) return
      // Docked at the strip's end the last photograph owns the position:
      // a frame narrower than the viewport never reaches the left edge,
      // so leftmost-frame reporting would stall the counter one short.
      const x = -currentXRef.current
      const max = getBounds().max
      const nearest = max > 0 && x >= max - 1 ? images.length - 1 : leftmostFrameIndex(x)
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
    let bounds = getBounds()
    // Pushing past the last photograph — drag, flick, or wheel — wakes
    // the endcard: its footprint rejoins the bounds and the gesture
    // carries straight into the reveal.
    if (mode === 'strip' && !foldActiveRef.current && !endcapRevealedRef.current && next < -bounds.max - 1) {
      revealEndcap()
      bounds = getBounds()
    }
    const value = clamp(next, -bounds.max, 0)
    currentXRef.current = value
    trackRef.current?.style.setProperty('transform', `translate3d(${value}px, 0, 0)`)
    if (mode === 'strip' && !foldActiveRef.current) {
      setPlateActionability(false)
      queuePlateActionability()
    }
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
      // the remaining travel instead of cancelling the navigation. The
      // chase is re-clamped every tick — a programmatic destination past
      // the bound (e.g. End docking a photo narrower than the stage)
      // must never read as the visitor pushing into the endcard.
      const liveDest = clamp(navDestXRef.current ?? destination, -getBounds().max, 0)
      const next = from + (liveDest - from) * eased
      renderX(next, false)
      if (progress < 1) momentumRef.current = requestAnimationFrame(tick)
      else {
        momentumRef.current = null
        queuePlateActionability()
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
    if (mode === 'strip' && !foldActiveRef.current) {
      navDestXRef.current = -imageStart(next)
      settleTo(navDestXRef.current, instant)
    }
    if (mode === 'vertical') {
      requestAnimationFrame(() => document.querySelector(`[data-image-id="${images[next]?.id}"]`)?.scrollIntoView({ block: 'start', behavior: instant ? 'auto' : 'smooth' }))
    }
  }

  // Vertical arrows step relative to what is actually on screen — free
  // scrolling leaves `index` stale, so measure the frames directly.
  // Down docks the first frame starting below the top edge; up docks the
  // straddling frame (or the one before it when already aligned).
  const verticalStep = (direction: -1 | 1) => {
    const stageTop = stageRef.current?.getBoundingClientRect().top ?? 0
    const frames = [...(trackRef.current?.querySelectorAll<HTMLElement>('[data-index]') ?? [])]
    if (direction === 1) {
      const next = frames.find((f) => f.getBoundingClientRect().top > stageTop + 8)
      goTo(next ? Number(next.dataset.index) - 1 : images.length - 1)
      return
    }
    const above = frames.filter((f) => f.getBoundingClientRect().top < stageTop - 8)
    goTo(above.length ? Number(above[above.length - 1].dataset.index) - 1 : 0)
  }

  const step = (direction: -1 | 1) => {
    if (!hasMultiple) return
    if (foldActiveRef.current) {
      const next = clamp((pendingFoldIndexRef.current ?? index) + direction, 0, images.length - 1)
      pendingFoldIndexRef.current = next
      goTo(next)
    } else if (mode === 'strip') {
      const next = clamp(index + direction, 0, images.length - 1)
      goTo(next)
    } else if (mode === 'vertical') {
      verticalStep(direction)
    } else {
      goTo(index + direction)
    }
  }

  const advanceStripByViewport = (direction: -1 | 1) => {
    if (foldActiveRef.current) { step(direction); return }
    if (mode !== 'strip') { step(direction); return }
    // The strip is bounded: forward at the end rests on the "The End."
    // card rather than wrapping; left arrow at the first image still
    // jumps to the last.
    const bounds = getBounds()
    // Rapid taps accumulate: anchor each advance at the pending in-flight
    // destination (or the real position when idle), so the tap count
    // becomes the photo count travelled.
    const base = -(navDestXRef.current ?? currentXRef.current)
    if (direction === 1 && base >= bounds.max - 1) {
      // At the last photograph a forward step reveals the endcard — the
      // strip glides it in flush right rather than wrapping to the start.
      if (endcapRevealedRef.current) return
      revealEndcap()
      navDestXRef.current = -getBounds().max
      settleTo(navDestXRef.current, false, true)
      return
    }
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
    if (foldActive) return
    boundsDirtyRef.current = true
    const target = mode === 'strip' ? -imageStart(index) : 0
    renderX(target, false)
    if (mode === 'vertical') requestAnimationFrame(() => document.querySelector(`[data-image-id="${currentImage?.id}"]`)?.scrollIntoView({ block: 'start', behavior: 'auto' }))
  }, [mode, foldActive])

  const applyStageMetrics = () => {
    const stage = stageRef.current
    if (!stage) return
    const visibleHeight = Math.max(1, Math.round(window.visualViewport?.height ?? window.innerHeight))
    stage.style.setProperty('--viewer-stage-height', `${visibleHeight}px`)
    const measured = { width: stage.clientWidth, height: stage.clientHeight, dpr: effectiveImageDpr(window.devicePixelRatio) }
    setStageSize((previous) => previous.width === measured.width && previous.height === measured.height && previous.dpr === measured.dpr ? previous : measured)
    boundsDirtyRef.current = true
    if (modeRef.current === 'strip' && !foldActiveRef.current) settleTo(-imageStart(indexRef.current), true)
  }

  // Enter-at-frame: instant and pre-paint, so the curtain lifts onto the
  // tapped photograph rather than the strip travelling to it in view.
  const entryFrameRef = useRef<number | null>(initialIndex > 0 ? clamp(initialIndex, 0, images.length - 1) : null)
  useLayoutEffect(() => {
    if (entryFrameRef.current === null) return
    const target = entryFrameRef.current
    entryFrameRef.current = null
    goTo(target, true)
  }, [])

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
    if (modeRef.current !== 'strip' || foldActiveRef.current) return
    const frame = requestAnimationFrame(() => settleTo(-imageStart(indexRef.current), true, true))
    return () => cancelAnimationFrame(frame)
  }, [stageSize, foldActive])

  useEffect(() => () => {
    cancelPositionReport()
  }, [])

  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && anyModalOpenRef.current) {
        event.preventDefault()
        requestCloseModals()
        return
      }
      if (isTypingTarget(event.target as HTMLElement | null)) return
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.defaultPrevented) return
      if (isTypingTarget(event.target as HTMLElement | null)) return
      const actions = gridActionsRef.current
      if (gridOpenRef.current) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') { event.preventDefault(); actions.stepGridSel(event.key); return }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.commitGridSel(); return }
      }
      if (event.key === 'Escape' && gridOpenRef.current) { event.preventDefault(); actions.requestCloseModals(); return }
      if (event.key !== 'g' && event.key !== 'G') return
      if (!document.body.classList.contains('gallery-entered')) return
      event.preventDefault()
      if (gridOpenRef.current) actions.requestCloseModals()
      else if (!anyModalOpenRef.current) actions.openGrid()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!gridOpen) return
    setGridSel(indexRef.current)
    const openedFrom = document.activeElement as HTMLElement
    previousFocusRef.current = openedFrom
    const frame = requestAnimationFrame(() => {
      const container = filmstripFrameRef.current
      const active = gridModalRef.current?.querySelector<HTMLElement>('[data-grid-active]')
      if (container && active) container.scrollLeft = active.offsetLeft + active.offsetWidth / 2 - container.clientWidth / 2
      active?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [gridOpen])

  useEffect(() => {
    if (gridOpen || modalOpen || infoOpen) return
    if (previousFocusRef.current) {
      previousFocusRef.current.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [gridOpen, modalOpen, infoOpen])

  useEffect(() => {
    if (!gridOpen) return
    magnifierRef.current?.deactivate()
    setMagnifierActive(false)
  }, [gridOpen])

  const startFilmstripPan = (event: PointerEvent) => {
    const frame = filmstripFrameRef.current
    if (!frame) return
    filmstripPanRef.current = { pointerId: event.pointerId, x: event.clientX, scrollLeft: frame.scrollLeft }
    scrollLeftAtDownRef.current = frame.scrollLeft
    gridSuppressClickRef.current = false
  }
  const moveFilmstripPan = (event: PointerEvent) => {
    const pan = filmstripPanRef.current
    const frame = filmstripFrameRef.current
    if (!pan || !frame || pan.pointerId !== event.pointerId) return
    frame.scrollLeft = pan.scrollLeft - (event.clientX - pan.x)
    if (Math.abs(frame.scrollLeft - scrollLeftAtDownRef.current) > 6) {
      gridSuppressClickRef.current = true
      if (!frame.hasPointerCapture(event.pointerId)) frame.setPointerCapture(event.pointerId)
    }
  }
  const endFilmstripPan = (event: PointerEvent) => {
    const frame = filmstripFrameRef.current
    if (!filmstripPanRef.current || filmstripPanRef.current.pointerId !== event.pointerId) return
    if (frame?.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId)
    filmstripPanRef.current = null
  }
  const wheelFilmstrip = (event: WheelEvent) => {
    const frame = filmstripFrameRef.current
    if (!frame) return
    event.preventDefault()
    const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientWidth : 1
    frame.scrollLeft += delta * factor
  }
  const selectFilmstripImage = (imageIndex: number) => {
    if (gridSuppressClickRef.current) { gridSuppressClickRef.current = false; return }
    if (gridCloseTimerRef.current) return
    setGridSel(imageIndex)
    setGridClosing(true)
    gridCloseTimerRef.current = setTimeout(() => {
      gridCloseTimerRef.current = null
      // Return focus to the selector trigger rather than wherever the
      // gallery happened to focus last (e.g. the next-arrow auto-focused
      // by the curtain dismiss), so a stray Enter after commit re-opens
      // the selector instead of stepping the strip.
      previousFocusRef.current = seqRef.current
      closeModals()
      goTo(imageIndex)
    }, 180)
  }
  // Selection follows the pink box (data-grid-active), never DOM focus —
  // arrows work whether or not a thumbnail has had time to take focus.
  const gridItems = () => [...(gridModalRef.current?.querySelectorAll<HTMLButtonElement>('[data-grid-item]') ?? [])]
  const stepGridSel = (key: string) => {
    const items = gridItems()
    if (!items.length) return
    const current = Math.max(0, items.findIndex((el) => el.hasAttribute('data-grid-active')))
    const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : (current + (key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
    setGridSel(next)
    items[next]?.focus()
    items[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  const commitGridSel = () => {
    const sel = gridItems().findIndex((el) => el.hasAttribute('data-grid-active'))
    if (sel >= 0) selectFilmstripImage(sel)
  }
  // The window key handler subscribes once and reaches these through a ref —
  // deps like [gridOpen] would unplug it for a few frames on every open/close
  // (hono/jsx re-arms passive effects asynchronously) and swallow a fast G.
  const gridActionsRef = useRef({ openGrid, closeModals, requestCloseModals, stepGridSel, commitGridSel })
  gridActionsRef.current = { openGrid, closeModals, requestCloseModals, stepGridSel, commitGridSel }

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

  // Desktop/mobile, tracked live: resizing across the breakpoint (or
  // dragging the window to another display) must re-apply or release the
  // video size caps rather than leave a stale first-paint decision.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(DESKTOP_VIDEO_QUERY)
    const sync = () => setIsDesktop(query.matches)
    sync()
    query.addEventListener?.('change', sync)
    return () => query.removeEventListener?.('change', sync)
  }, [])

  // Network quality, tracked live: a visitor who walks out of wifi onto a
  // weak cell link should see the clips fall back to their stills rather
  // than stall. The API is absent in Safari and Firefox, where the read
  // is simply undefined and video behaves normally.
  useEffect(() => {
    if (typeof navigator === 'undefined') return
    const source = connectionOf(navigator) as (ConnectionLike & {
      addEventListener?: (type: string, listener: () => void) => void
      removeEventListener?: (type: string, listener: () => void) => void
    }) | undefined
    if (!source) return
    // Copy the live object's fields: it mutates in place, so storing the
    // reference itself would never register as a state change.
    const sync = () => setConnection({
      saveData: source.saveData,
      effectiveType: source.effectiveType,
      downlink: source.downlink,
    })
    sync()
    source.addEventListener?.('change', sync)
    return () => source.removeEventListener?.('change', sync)
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
    if (!modalOpen && !infoOpen && !gridOpen) return
    magnifierRef.current?.deactivate()
    setMagnifierActive(false)
  }, [modalOpen, infoOpen, gridOpen])

  useEffect(() => () => {
    if (gridCloseTimerRef.current) clearTimeout(gridCloseTimerRef.current)
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
      if (isTypingTarget(target)) return
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
      if (isTypingTarget(target)) return
      if (event.key !== 'i' && event.key !== 'I') return
      if (anyModalOpenRef.current || !document.body.classList.contains('gallery-entered')) return
      event.preventDefault()
      // I opens the in-gallery info sheet directly; ⇧I jumps to the
      // standalone C2PA viewer instead (falling back to the sheet for
      // sources it cannot fetch).
      if (event.shiftKey) openCurrentImageInfo()
      else openImageProvenance()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      if (mode === 'vertical') return
      event.preventDefault()
      // Normalise to pixels before any threshold or travel math: line- and
      // page-mode wheels emit small deltas that would never reach the fold
      // step threshold otherwise.
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientWidth : 1
      const rawDelta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      const delta = rawDelta * factor
      if (foldActiveRef.current) {
        if (Math.abs(delta) > 8) step(delta > 0 ? 1 : -1)
        return
      }
      if (mode === 'single') {
        if (Math.abs(rawDelta) > 8) step(rawDelta > 0 ? 1 : -1)
        return
      }
      renderX(currentXRef.current + delta * -1)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [mode, index, foldActive])

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

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage || !foldActive) return
    let startX = 0
    let pointerId: number | null = null
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('button')) return
      startX = event.clientX
      pointerId = event.pointerId
      stage.setPointerCapture?.(event.pointerId)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return
      pointerId = null
      stage.releasePointerCapture?.(event.pointerId)
      const distance = event.clientX - startX
      if (Math.abs(distance) > 42) step(distance < 0 ? 1 : -1)
    }
    // A canceled gesture is an interruption, not a swipe — release the
    // tracked pointer without stepping the viewer.
    const onPointerCancel = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return
      pointerId = null
      stage.releasePointerCapture?.(event.pointerId)
    }
    stage.addEventListener('pointerdown', onPointerDown)
    stage.addEventListener('pointerup', onPointerUp)
    stage.addEventListener('pointercancel', onPointerCancel)
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown)
      stage.removeEventListener('pointerup', onPointerUp)
      stage.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [foldActive, index])

  useEffect(() => {
    const stage = stageRef.current
    const logo = dotRef.current
    const seq = seqRef.current
    if (!stage) return
    // A press landing on the brand pill or sequence counter is a drag
    // candidate: the pill floats over the stage, and the counter lives
    // inside the stage's control cluster. Both capture the pointer onto
    // the stage and pan with the strip. A release that never travelled
    // still counts as the button's own click (pointer capture suppresses
    // the native click event, so each press is replayed here).
    let logoPress: { x: number; y: number } | null = null
    let seqPress: { x: number; y: number } | null = null
    const beginDrag = (event: PointerEvent) => {
      stopMomentum()
      setPlateActionability(false)
      draggingRef.current = true
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      dragTargetXRef.current = currentXRef.current
      dragSamplesRef.current = [{ x: 0, time: performance.now() }]
      stage.setPointerCapture(event.pointerId)
      stage.classList.add('is-dragging')
    }
    const onPointerDown = (event: PointerEvent) => {
      if (mode !== 'strip' || foldActiveRef.current || (event.target as HTMLElement).closest('button')) return
      beginDrag(event)
    }
    const onLogoDown = (event: PointerEvent) => {
      if (mode !== 'strip') return
      logoPress = { x: event.clientX, y: event.clientY }
      beginDrag(event)
    }
    const onSeqDown = (event: PointerEvent) => {
      if (mode !== 'strip') return
      seqPress = { x: event.clientX, y: event.clientY }
      beginDrag(event)
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
      if (logoPress) {
        const travelled = Math.hypot(event.clientX - logoPress.x, event.clientY - logoPress.y)
        logoPress = null
        if (event.type === 'pointerup' && travelled < 6) openDisplaySettings()
        return
      }
      if (seqPress) {
        const travelled = Math.hypot(event.clientX - seqPress.x, event.clientY - seqPress.y)
        seqPress = null
        if (event.type === 'pointerup' && travelled < 6) openGrid()
        return
      }
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
        else {
          momentumRef.current = null
          queuePlateActionability()
        }
      }
      momentumRef.current = requestAnimationFrame(glide)
    }
    stage.addEventListener('pointerdown', onPointerDown)
    stage.addEventListener('pointermove', onPointerMove)
    stage.addEventListener('pointerup', onPointerUp)
    stage.addEventListener('pointercancel', onPointerUp)
    logo?.addEventListener('pointerdown', onLogoDown)
    seq?.addEventListener('pointerdown', onSeqDown)
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown)
      stage.removeEventListener('pointermove', onPointerMove)
      stage.removeEventListener('pointerup', onPointerUp)
      stage.removeEventListener('pointercancel', onPointerUp)
      logo?.removeEventListener('pointerdown', onLogoDown)
      seq?.removeEventListener('pointerdown', onSeqDown)
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current)
      stopMomentum()
    }
  }, [mode])

  // Pointer proximity wakes the brand pill — a ~100px box around the
  // strip measured on pointermove, toggled as a class. Deliberately not
  // a CSS hit-extender: inflating the button's box would swallow stage
  // drags and clicks that should belong to the photographs.
  useEffect(() => {
    const button = dotRef.current
    if (!button) return
    const RANGE = 100
    const onMove = (event: PointerEvent) => {
      const r = button.getBoundingClientRect()
      button.classList.toggle(
        'is-near',
        event.clientX > r.left - RANGE && event.clientX < r.right + RANGE &&
        event.clientY > r.top - RANGE && event.clientY < r.bottom + RANGE,
      )
    }
    const off = () => button.classList.remove('is-near')
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', off)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('mouseleave', off)
      window.removeEventListener('blur', off)
    }
  }, [])

  // Vertical mode scrolls natively for touch and wheel; map a mouse or
  // pen drag onto scrollTop so the feed answers a grabbed drag too. The
  // brand pill plays along — a press on it drags the feed, and a
  // release without travel still lands as its click.
  useEffect(() => {
    const stage = stageRef.current
    const logo = dotRef.current
    if (!stage || mode !== 'vertical') return
    let dragging = false
    let lastY = 0
    let logoPress: { x: number; y: number } | null = null
    const beginDrag = (event: PointerEvent) => {
      dragging = true
      lastY = event.clientY
      stage.setPointerCapture(event.pointerId)
      stage.classList.add('is-dragging')
      event.preventDefault()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      if ((event.target as HTMLElement).closest('button')) return
      beginDrag(event)
    }
    const onLogoDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      logoPress = { x: event.clientX, y: event.clientY }
      beginDrag(event)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return
      stage.scrollTop += lastY - event.clientY
      lastY = event.clientY
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) return
      dragging = false
      stage.releasePointerCapture?.(event.pointerId)
      stage.classList.remove('is-dragging')
      if (logoPress) {
        const travelled = Math.hypot(event.clientX - logoPress.x, event.clientY - logoPress.y)
        logoPress = null
        if (event.type === 'pointerup' && travelled < 6) openDisplaySettings()
      }
    }
    stage.addEventListener('pointerdown', onPointerDown)
    stage.addEventListener('pointermove', onPointerMove)
    stage.addEventListener('pointerup', onPointerUp)
    stage.addEventListener('pointercancel', onPointerUp)
    logo?.addEventListener('pointerdown', onLogoDown)
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown)
      stage.removeEventListener('pointermove', onPointerMove)
      stage.removeEventListener('pointerup', onPointerUp)
      stage.removeEventListener('pointercancel', onPointerUp)
      logo?.removeEventListener('pointerdown', onLogoDown)
    }
  }, [mode])

  // Escape and the Tab trap live on the dialog element itself — attached
  // at commit — while a render-synced ref lets the always-on window key
  // handler cover keys pressed with focus anywhere (e.g. Escape in the
  // first frames after opening, before a passive effect could attach a
  // document listener).
  const onModalKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); requestCloseModals(); return }
    if (event.key !== 'Tab') return
    const modal = event.currentTarget as HTMLElement
    const focusable = [...modal.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
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

  // Strip's decoded window slides with `index`; a bounded MRU tail of
  // frames that just left it stays mounted so quick pans back don't
  // re-mount and re-fetch. Bounded so eager media and decoded HEIC blobs
  // still get released once truly out of play.
  useEffect(() => {
    if (mode !== 'strip') {
      stripMruRef.current = []
      return
    }
    const base = new Set<number>()
    for (let i = Math.max(0, index - STRIP_WINDOW); i <= Math.min(images.length - 1, index + STRIP_WINDOW); i += 1) base.add(i)
    const tail = stripMruRef.current.filter((i) => !base.has(i))
    stripMruRef.current = [...base, ...tail].slice(0, base.size + STRIP_RETAIN)
    setStripActive(new Set(stripMruRef.current))
  }, [index, mode, images.length])

  /**
   * Which frames may own a media element. `isFrameActive` is a window
   * (plus retention, in strip mode) — too wide for video, which would
   * mount a `<video>` per retained frame. A video mounts on the current
   * slide and its immediate neighbours, so stepping onto one finds a clip
   * that is ALREADY running rather than one that starts on arrival. On a
   * poor connection nothing mounts and the poster is the whole frame.
   */
  const isVideoSlideActive = (imageIndex: number) =>
    videoMountsFor({
      imageIndex,
      index,
      frameActive: isFrameActive(imageIndex),
      galleryEntered,
      blocked: modalOpen || infoOpen || gridOpen,
      connection,
    })

  const isFrameActive = (imageIndex: number) => {
    if (mode === 'vertical') {
      return typeof IntersectionObserver === 'undefined'
        ? Math.abs(imageIndex - index) <= 3
        : verticalActive.has(imageIndex)
    }
    return mode === 'strip' ? stripActive.has(imageIndex) : imageIndex === index
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
  }, [index, mode, images, heicSrc, verticalActive, stripActive])

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

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch {
      // Some mobile browsers intentionally do not allow element fullscreen.
    }
  }

  const foldStartIndex = Math.min(index % 2 === 0 ? index : index - 1, Math.max(0, images.length - 2))
  // Resolve displayable sources here — heicSrc lives in this component, so
  // the renderer receives frames it can paint without knowing about HEIC.
  // Undecoded HEICs show their 256px variant or placeholder, mirroring the
  // ordinary frame's placeholder layer while libheif works.
  const foldFrames = images.slice(foldStartIndex, foldStartIndex + 2).map((image) =>
    isHeic(image)
      ? { ...image, src: heicSrc[image.id] ?? image.variants?.[0]?.src ?? image.placeholder }
      : image)
  const foldActiveIndex = Math.max(0, index - foldStartIndex)

  return (
    <>
      {/* Behind everything, inert: a deterministic field keyed to this
          gallery's URL. Sits outside the stage so it stays put while the
          track scrolls. */}
      <div
        ref={stageRef}
        class={`viewer-stage mode-${mode} bg-${background}`}
        data-stage
        aria-label={`${slug} photograph viewer`}
        tabIndex={-1}
      >
        {/* A single decorative layer beneath the gallery content. Inside
            the stage's isolated stacking context at z-index 0, it shows
            through only the transparent gaps between tiles and the
            exposed canvas — never over photographs or UI. */}
        <SeededDoodleBackground enabled={background !== 'none'} />
        {foldActive && foldLayout && foldRenderer ? foldRenderer({
          frames: foldFrames,
          activeIndex: foldActiveIndex,
          segments: foldLayout.segments,
          dpr: stageSize.dpr,
        }) : <div
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
              stageWidthCssPx: stagingWidth,
              stageHeightCssPx: stagingHeight,
              dpr: stageSize.dpr,
            })
            // Desktop restrains video: 70% of stage height in the strip,
            // 60% of stage width in vertical scroll. `capped: false` means
            // the rule does not apply (mobile, single mode, unmeasured
            // stage) and the frame keeps its previous full-bleed sizing.
            const stagedVideo = video ? videoStageSize({
              mode,
              naturalWidthPx: frameW,
              naturalHeightPx: frameH,
              stageWidthCssPx: stagingWidth,
              stageHeightCssPx: stagingHeight,
              isDesktop,
            }) : null
            const stagedStyle = staged && staged.width > 0 && staged.height > 0 ? { width: `${staged.width}px`, height: `${staged.height}px` } : undefined
            // A capped video gets an explicit box. Strip frames are laid
            // out edge-to-edge, so the frame keeps full stage height and
            // only the media inside it shrinks — that is what centres the
            // clip vertically instead of leaving it top-aligned above a
            // gap. Vertical frames are full-width rows, so the row height
            // follows the capped media height.
            const cappedVideo = stagedVideo?.capped && stagedVideo.width > 0 && stagedVideo.height > 0 ? stagedVideo : null
            const frameStyle = mode === 'strip'
              ? cappedVideo
                ? { width: `${cappedVideo.width}px`, height: stagingHeight > 0 ? `${stagingHeight}px` : '100%' }
                : staged && staged.width > 0 && staged.height > 0
                  ? { width: `${staged.width}px`, height: `${staged.height}px` }
                  : { aspectRatio: `${frameW} / ${frameH}` }
              : mode === 'vertical'
                ? video
                  ? cappedVideo
                    ? { width: '100%', height: `${cappedVideo.height}px` }
                    : undefined
                  : staged && staged.height > 0
                    ? { width: '100%', height: `${staged.height}px` }
                    : { width: '100%', aspectRatio: `${frameW} / ${frameH}` }
                : undefined
            // The media box inside a capped frame.
            const cappedMediaStyle = cappedVideo ? { width: `${cappedVideo.width}px`, height: `${cappedVideo.height}px` } : undefined
            const photoFrame = (
              <figure
                class={`viewer-frame ${isPortrait ? 'viewer-frame--portrait' : 'viewer-frame--landscape'} ${mode === 'single' ? (imageIndex === index ? (leavingIndex === null ? '' : 'viewer-frame--entering') : imageIndex === leavingIndex ? 'viewer-frame--leaving' : 'viewer-frame--hidden') : ''} ${video ? 'viewer-frame--video' : ''} ${cappedVideo ? 'viewer-frame--video-capped' : ''}`}
                data-image-id={image.id}
                data-index={imageIndex + 1}
                data-orientation={isPortrait ? 'portrait' : 'landscape'}
                data-media-type={video ? 'video' : 'image'}
                aria-current={imageIndex === index ? 'true' : undefined}
                aria-hidden={mode === 'single' && imageIndex !== index ? 'true' : undefined}
                style={frameStyle}
              >
                {video ? (
                  <>
                    {/* The poster holds the frame's aspect-ratio canvas and
                        stays the accessible still for every frame whose
                        video is not mounted — including neighbours that
                        ARE mounted but silently looping behind the active
                        clip. An active slide whose video is unmounted
                        (reduced motion, slow connection, blocked by a
                        modal) keeps its poster exposed with video.alt so
                        the slide is never left without a name. */}
                    {(() => {
                    const videoMounted = isVideoSlideActive(imageIndex)
                    return <>
                    <img
                      class="frame-ph"
                      src={video.poster.src}
                      alt={videoMounted && imageIndex === index ? '' : video.alt}
                      aria-hidden={videoMounted && imageIndex === index ? 'true' : undefined}
                      width={frameW}
                      height={frameH}
                      decoding="async"
                      loading={isActive ? 'eager' : 'lazy'}
                      style={cappedMediaStyle}
                    />
                    {videoMounted ? (
                      <VideoSlide
                        item={video}
                        isActive={imageIndex === index}
                        soundOn={soundOn}
                        prefersReducedMotion={reducedMotion}
                        onToggleSound={setSoundOn}
                        boxStyle={cappedMediaStyle}
                      />
                    ) : null}
                    </>
                    })()}
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
                            // The strip frame hugs the staged image, so the
                            // heal must land the new dims now — before the
                            // rAF delta measures the track shift.
                            const restaged = imageStageSize({
                              mode: 'strip',
                              naturalWidthPx: img.naturalWidth,
                              naturalHeightPx: img.naturalHeight,
                              stageWidthCssPx: stagingWidth,
                              stageHeightCssPx: stagingHeight,
                              dpr: stageSize.dpr,
                            })
                            if (restaged.width > 0) {
                              frame.style.width = `${restaged.width}px`
                              frame.style.height = `${restaged.height}px`
                            }
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
                              if (momentumRef.current !== null && navDestXRef.current !== null) return
                              navDestXRef.current = null
                              // The healed frame sat left of the stage
                              // edge — its growth shoved the held pixels
                              // right. Pull the transform back by the same
                              // delta so the strip stays pixel-stable:
                              // no docking, no snap — idle, dragged, or
                              // gliding alike. A frame still ahead of the
                              // edge shifts nothing held.
                              if (delta === 0 || frame.offsetLeft >= -currentXRef.current) return
                              renderX(currentXRef.current - delta)
                              if (draggingRef.current) dragTargetXRef.current -= delta
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
            if (plate && mode === 'strip' && plateIndex === imageIndex) {
              return <>
                <div
                  class="viewer-frame viewer-ad-frame"
                  data-ad-frame
                  aria-label={`${plate.badge}: ${plate.advertiser}`}
                  style={{ width: `${AD_BANNER_WIDTH + 48}px`, height: '100%', minWidth: `${AD_BANNER_WIDTH + 48}px`, minHeight: '100%', display: 'grid', placeItems: 'center', alignContent: 'center', padding: '24px', boxSizing: 'border-box', background: 'rgb(10, 10, 10)', color: 'rgb(244, 240, 232)', textAlign: 'center' }}
                >
                  <div data-ad-mount style={{ width: `${AD_BANNER_WIDTH}px`, height: `${AD_BANNER_HEIGHT}px`, display: 'grid', gap: '12px', placeItems: 'center', alignContent: 'center' }}>
                    <span style={{ fontSize: '15px', lineHeight: '1', letterSpacing: '.08em', textTransform: 'uppercase' }}>{plate.badge}</span>
                    <strong style={{ fontSize: '18px', lineHeight: '1.2' }}>{plate.headline ?? plate.advertiser}</strong>
                    {plate.cta ? <a href={plate.cta.url} target="_blank" rel="noopener" tabIndex={plateActionable ? 0 : -1} onPointerDown={(event) => { if (!plateCanActivate()) event.preventDefault() }} onClick={(event) => { if (!plateCanActivate()) event.preventDefault() }} onKeyDown={(event) => { if (!plateCanActivate()) event.preventDefault() }} style={{ color: 'inherit', fontSize: '15px' }}>{plate.cta.label}</a> : null}
                  </div>
                </div>
                {photoFrame}
              </>
            }
            return photoFrame
          })}
          {/* The end of the strip: a borderless, full-height faux frame
              that slides in behind the last photograph, so reaching the
              end reads as an ending instead of a jarring wrap to the
              start. `inert` until revealed — it sits past the pan bound
              before then, so its link must not take focus or announce. */}
          {mode === 'strip' ? (
            <div class="viewer-endcap" inert={!endcapRevealed}>
              <span>The</span>
              <span>End.</span>
              <button class="endcap-reset" onClick={backToStart}>Back to Start</button>
            </div>
          ) : null}
        </div>}
        {/* data-magnifier-ignore: the lens mirrors photographs, not the
            page's own controls. The container always renders so the
            sequence bubble keeps its dock when arrows are opted out. */}
        <div class={`stage-arrows ${mode === 'vertical' ? 'stage-arrows--vertical' : ''} ${arrowsVisible ? '' : 'stage-arrows--bare'}`} data-magnifier-ignore role="group" aria-label="Image navigation">
          <button ref={seqRef} type="button" class="stage-seq" aria-label={`Photograph ${index + 1} of ${images.length} — open selector`} onClick={openGrid}>
            <span class="stage-seq-num" aria-hidden="true">{index + 1}</span>
            <span class="stage-seq-detail" aria-hidden="true">
              <span class="stage-seq-tally">{index + 1} of {images.length} items</span>
              <span class="stage-seq-hint">open global</span>
            </span>
          </button>
          {arrowsVisible ? (
            <>
              <button data-nav-arrow aria-label="Previous photograph" onClick={() => advanceStripByViewport(-1)} disabled={mode === 'single' && index === 0}>{mode === 'vertical' ? '↑' : '←'}</button>
              <button ref={nextArrowRef} data-nav-arrow aria-label="Next photograph" onClick={() => advanceStripByViewport(1)} disabled={mode === 'single' && index === images.length - 1}>{mode === 'vertical' ? '↓' : '→'}</button>
            </>
          ) : null}
        </div>
      </div>

      <button ref={dotRef} class="control-logo" aria-label="Display settings" title="Display settings" onClick={openDisplaySettings}><span class="brand-mark-wrap"><img src="/manorama-merged-logo.png" alt="" aria-hidden="true" /><span class="brand-tld" aria-hidden="true">.xyz</span></span></button>

      {gridOpen ? <>
        <div class={`filmstrip-scrim ${gridClosing ? 'is-closing' : ''}`} aria-hidden="true" onPointerDown={requestCloseModals} />
        <div ref={gridModalRef} class={`viewer-filmstrip ${gridClosing ? 'is-closing' : ''}`} role="dialog" aria-modal="true" aria-label="All photographs" onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            stepGridSel(event.key)
            return
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            commitGridSel()
            return
          }
          onModalKeyDown(event)
        }}>
          <div ref={filmstripFrameRef} class="viewer-filmstrip-frame" onPointerDown={startFilmstripPan} onPointerMove={moveFilmstripPan} onPointerUp={endFilmstripPan} onPointerCancel={endFilmstripPan} onWheel={wheelFilmstrip}>
            <div class="viewer-filmstrip-track">
              {images.map((image, imageIndex) => {
                const video = isVideoItem(image)
                const thumb = image.variants?.[0]?.src ?? image.placeholder
                return <button
                  type="button"
                  class={`viewer-filmstrip-item ${imageIndex === gridSel ? 'is-active' : ''}`}
                  data-grid-item
                  data-grid-active={imageIndex === gridSel ? 'true' : undefined}
                  aria-current={imageIndex === gridSel ? 'true' : undefined}
                  aria-label={`${video ? 'Video' : 'Photograph'} ${imageIndex + 1} of ${images.length}`}
                  onPointerMove={() => {
                    if (filmstripPanRef.current || imageIndex === gridSel) return
                    setGridSel(imageIndex)
                  }}
                  onClick={() => selectFilmstripImage(imageIndex)}
                >
                  <img src={thumb} loading="lazy" alt="" draggable={false} style={{ aspectRatio: `${image.width} / ${image.height}` }} onLoad={(event: Event) => (event.currentTarget as HTMLImageElement).classList.add('is-loaded')} />
                  {video ? <span class="viewer-filmstrip-badge">▶{formatDuration(image.durationSeconds) ? ` ${formatDuration(image.durationSeconds)}` : ''}</span> : null}
                </button>
              })}
            </div>
          </div>
        </div>
      </> : null}

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
            {/* 'none' leaves photographs abutting on the bare dark canvas;
                Light and Dark wake the doodle field — keyed to this
                gallery's URL, so the same album always wears the same
                pattern — and give every image a 10px margin on the
                trailing side. */}
            <div class="mode-options" role="radiogroup" aria-label="Background behind photographs">
              <label><input type="radio" name="background-mode" value="light" checked={background === 'light'} onChange={() => { setBackground('light'); saveBackgroundPreference('light'); closeModals() }} /> <span>Light</span><small>dark ink doodles, 10px margins</small></label>
              <label><input type="radio" name="background-mode" value="dark" checked={background === 'dark'} onChange={() => { setBackground('dark'); saveBackgroundPreference('dark'); closeModals() }} /> <span>Dark</span><small>light ink doodles, 10px margins</small></label>
              <label><input type="radio" name="background-mode" value="none" checked={background === 'none'} onChange={() => { setBackground('none'); saveBackgroundPreference('none'); closeModals() }} /> <span>None</span><small>photographs abut on the dark canvas</small></label>
            </div>
          </section>

          <section class="panel-section compact-section" aria-label="Display options">
            <div class="panel-actions">
              <button type="button" class="panel-action" onClick={() => { if (mode === 'vertical') setShowArrowsVertical(!showArrowsVertical); else setShowArrows(!showArrows); closeModals() }}>{arrowsOn ? 'Hide navigation arrows' : 'Show navigation arrows'}</button>
              {fullscreenAvailable ? <button type="button" class="panel-action" onClick={() => { toggleFullscreen(); closeModals() }}>{fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'}</button> : null}
            </div>
          </section>

          <section class="panel-section" aria-labelledby="about-heading" hidden>
            <h3 id="about-heading">About this gallery</h3>
            <p class="about-copy">This single-album gallery is shared as one quiet sequence. Its images are served as originals where possible; non-credentialed responsive derivatives preserve the embedded colour profile.</p>
          </section>

          <section class="panel-section shortcuts" aria-labelledby="shortcuts-heading">
            <h3 id="shortcuts-heading">Keyboard shortcuts</h3>
            <p><kbd>G</kbd> photograph selector</p>
            <p><kbd>←</kbd><kbd>→</kbd> move between photographs</p>
            <p><kbd>Home</kbd><kbd>End</kbd> jump to the ends</p>
            {/* Pointer-gated: a loupe replacing the cursor means nothing
                on a touch device, so the row only exists where the key
                actually works. */}
            {magnifierAvailable ? <p><kbd>M</kbd> magnify under the cursor{magnifierActive ? ' (on)' : ''}</p> : null}
            <p><kbd>I</kbd> image info</p>
            <p><kbd>⇧I</kbd> standalone c2pa viewer (new tab)</p>
            <p><kbd>Esc</kbd> close controls</p>
          </section>

          {/* The one bit of chrome every gallery carries: the privacy
              policy and the copyright line. Docked at the bottom of the
              brand popover — present without ever interrupting the
              photographs. Opens in a new tab so the gallery keeps its
              place. */}
          <footer class="panel-legal">
            <a href="/privacy" target="_blank" rel="noopener" onClick={() => closeModals()}>Privacy policy</a>
            <span aria-hidden="true"> · </span>© 2026 manorama
          </footer>
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
              {currentImage?.caption ? <div><dt>Caption</dt><dd>{currentImage.caption}</dd></div> : null}
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
