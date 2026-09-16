import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { GalleryImage } from '../lib/imagesource'
import { imageWithSettings, loadStoredGallerySettings, type GallerySettings } from '../lib/gallery-settings'

/**
 * Strip invariant: each frame derives its width from the source aspect ratio at
 * full stage height. Vertical mode complements it by fitting landscapes to
 * width and portraits to visible height; no mode changes a source aspect ratio.
 * above or below a photograph. Its height follows the visible browser viewport
 * after orientation or browser-chrome changes. Pointer input is coalesced once per frame into one continuous canvas; Strip-only release glide is brief and never snaps to an image.
 */

type Mode = 'strip' | 'vertical' | 'single'
type SeamMode = 'light' | 'dark' | 'none'
type DragSample = { x: number; time: number }
type Props = {
  slug: string
  images: readonly GalleryImage[]
  settings: GallerySettings
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** Anonymous per-gallery viewing preferences: mode + border choice are
 *  remembered in localStorage keyed by gallery slug, so a link recipient
 *  keeps their own preference without an account. */
type RevealMode = 'cross' | 'fade'
type ViewPrefs = { mode?: Mode; seamMode?: SeamMode; reveal?: RevealMode }
const readViewPrefs = (slug: string): ViewPrefs => {
  try {
    const stored = JSON.parse(localStorage.getItem(`manorama:view:${slug}`) ?? '{}') as ViewPrefs
    return {
      mode: stored.mode && ['strip', 'vertical', 'single'].includes(stored.mode) ? stored.mode : undefined,
      seamMode: stored.seamMode && ['light', 'dark', 'none'].includes(stored.seamMode) ? stored.seamMode : undefined,
      reveal: stored.reveal && ['cross', 'fade'].includes(stored.reveal) ? stored.reveal : undefined,
    }
  } catch {
    return {}
  }
}

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
  const [reveal, setReveal] = useState<RevealMode>(viewPrefs.reveal ?? 'cross')
  const [showCaptions, setShowCaptions] = useState(initialSettings.defaultShowCaptions)
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false)
  const [fullscreenActive, setFullscreenActive] = useState(false)
  const [credentialState, setCredentialState] = useState<Record<string, 'idle' | 'loading' | 'verified' | 'unavailable'>>({})
  const [credentialStores, setCredentialStores] = useState<Record<string, unknown>>({})
  const [heicSrc, setHeicSrc] = useState<Record<string, string>>({})
  const heicPendingRef = useRef(new Set<string>())
  const stageRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const modalRef = useRef<HTMLDivElement | null>(null)
  const infoModalRef = useRef<HTMLDivElement | null>(null)
  const dotRef = useRef<HTMLButtonElement | null>(null)
  const nextArrowRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const draggingRef = useRef(false)
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const dragSamplesRef = useRef<DragSample[]>([])
  const dragTargetXRef = useRef(0)
  const dragFrameRef = useRef<number | null>(null)
  const momentumRef = useRef<number | null>(null)
  const c2paRef = useRef<any>(null)
  const currentXRef = useRef(0)
  const indexRef = useRef(index)
  const modeRef = useRef(mode)
  const reportedIndexRef = useRef(index)
  const positionFrameRef = useRef<number | null>(null)
  const viewportFrameRef = useRef<number | null>(null)
  const boundsRef = useRef({ min: 0, max: 0 })
  const boundsDirtyRef = useRef(true)

  const currentImage = images[index] ?? images[0]

  useEffect(() => { indexRef.current = index }, [index])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => {
    try {
      localStorage.setItem(`manorama:view:${slug}`, JSON.stringify({ mode, seamMode, reveal }))
    } catch {
      // Storage can be unavailable (private mode) — preferences are best-effort.
    }
  }, [slug, mode, seamMode, reveal])

  useEffect(() => {
    const loaded = loadStoredGallerySettings(slug, initialSettings)
    setSettings(loaded)
    setMode(loaded.defaultMode)
    setShowArrows(loaded.defaultShowArrows)
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
  }, [slug, initialSettings])

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

  const reportStripPosition = () => {
    if (positionFrameRef.current !== null) return
    positionFrameRef.current = requestAnimationFrame(() => {
      positionFrameRef.current = null
    const stage = stageRef.current
    const track = trackRef.current
    if (!stage || !track) return
      const midpoint = -currentXRef.current + stage.clientWidth / 2
    const frames = [...track.querySelectorAll<HTMLElement>('[data-index]')]
    let nearest = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const frame of frames) {
      const frameIndex = Number(frame.dataset.index ?? 1) - 1
      const center = frame.offsetLeft + frame.offsetWidth / 2
      const distance = Math.abs(center - midpoint)
      if (distance < nearestDistance) {
        nearest = frameIndex
        nearestDistance = distance
      }
    }
      if (reportedIndexRef.current !== nearest) {
        reportedIndexRef.current = nearest
        setIndex(nearest)
      }
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
    const duration = 900
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      const eased = 1 - Math.pow(1 - progress, 5)
      const next = from + (destination - from) * eased
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
    setIndex(next)
    if (mode === 'strip') settleTo(-imageStart(next), instant)
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
    const scrollX = -currentXRef.current
    const bounds = getBounds()
    if (direction === 1 && scrollX >= bounds.max - 1) { goTo(0); return }
    if (direction === -1 && scrollX <= 1) { goTo(images.length - 1); return }
    const viewportWidth = stageRef.current?.clientWidth ?? window.innerWidth
    let frame = trackRef.current?.querySelector<HTMLElement>(`[data-index="${indexRef.current + 1}"]`) ?? null
    let advance: number
    if (direction === 1) {
      advance = Math.min(viewportWidth, frame?.offsetWidth ?? viewportWidth)
    } else {
      // Moving left: cover the lesser of the viewport width or the part of the
      // active image still hidden to the left of the stage edge. When the
      // active image's left edge is already at the stage edge, the remaining
      // width belongs to the frame before it.
      const scrollX = -currentXRef.current
      let remaining = frame ? scrollX - frame.offsetLeft : 0
      while (remaining <= 0 && frame) {
        frame = frame.previousElementSibling as HTMLElement | null
        remaining = frame ? scrollX - frame.offsetLeft : 0
      }
      advance = Math.min(viewportWidth, Math.max(0, remaining))
    }
    settleTo(currentXRef.current - direction * advance, false, true)
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

  useEffect(() => {
    const onResize = () => {
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current)
      viewportFrameRef.current = requestAnimationFrame(() => {
        viewportFrameRef.current = null
        const stage = stageRef.current
        if (!stage) return
        const visibleHeight = Math.max(1, Math.round(window.visualViewport?.height ?? window.innerHeight))
        stage.style.setProperty('--viewer-stage-height', `${visibleHeight}px`)
        boundsDirtyRef.current = true
        if (modeRef.current === 'strip') settleTo(-imageStart(indexRef.current), true)
      })
    }
    const visualViewport = window.visualViewport
    onResize()
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    visualViewport?.addEventListener('resize', onResize)
    visualViewport?.addEventListener('scroll', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      visualViewport?.removeEventListener('resize', onResize)
      visualViewport?.removeEventListener('scroll', onResize)
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current)
    }
  }, [])

  useEffect(() => () => {
    cancelPositionReport()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modalOpen || infoOpen || !document.body.classList.contains('gallery-entered')) return
      if (event.key === 'ArrowRight') { event.preventDefault(); advanceStripByViewport(1) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); advanceStripByViewport(-1) }
      if (event.key === 'Home') { event.preventDefault(); goTo(0, true) }
      if (event.key === 'End') { event.preventDefault(); goTo(images.length - 1, true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, mode, modalOpen, infoOpen, images.length])

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
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest('button')) return
      startX = event.clientX
      stage.setPointerCapture(event.pointerId)
    }
    const onPointerUp = (event: PointerEvent) => {
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

  useEffect(() => {
    if (!modalOpen && !infoOpen) return
    const modal = modalOpen ? modalRef.current : infoModalRef.current
    previousFocusRef.current = document.activeElement as HTMLElement
    requestAnimationFrame(() => {
      modal?.querySelector<HTMLElement>('[data-c2pa-panel]')?.scrollIntoView({ block: 'start' })
      modal?.querySelector<HTMLElement>('[data-close]')?.focus({ preventScroll: true })
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setModalOpen(false); setInfoOpen(false); return }
      if (event.key !== 'Tab' || !modal) return
      const focusable = [...modal.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
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
    setInfoOpen(true)
    if (currentImage?.c2pa && credentialState[currentImage.id] === 'idle') void openCredentials()
  }

  // HEIC originals can't render in a browser, so decode them at full
  // resolution via libheif WASM — lazily, only when a frame enters the
  // active window. The 256px JPEG variant shows while decoding.
  const isHeic = (image: GalleryImage) => /\.hei[cf]$/i.test(image.filename)
  const decodeHeic = async (image: GalleryImage) => {
    if (heicPendingRef.current.has(image.id)) return
    heicPendingRef.current.add(image.id)
    try {
      const { default: heic2any } = await import('heic2any')
      const response = await fetch(image.src)
      if (!response.ok) throw new Error(`HEIC fetch failed: ${response.status}`)
      const blob = await response.blob()
      const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
      // Older gallery records still point at JPEG renditions — a 'ftyp' box
      // means real HEIC; anything else (JPEG, WebP) renders directly.
      const isHeicBlob = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
      if (!isHeicBlob) {
        setHeicSrc((previous) => ({ ...previous, [image.id]: URL.createObjectURL(blob) }))
        return
      }
      const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.95 })
      const out = Array.isArray(converted) ? converted[0] : converted
      setHeicSrc((previous) => ({ ...previous, [image.id]: URL.createObjectURL(out) }))
    } catch {
      heicPendingRef.current.delete(image.id)
    }
  }

  useEffect(() => {
    images.forEach((image, imageIndex) => {
      const active = mode === 'vertical' || (mode === 'strip' ? Math.abs(imageIndex - index) <= 3 : imageIndex === index)
      if (active && isHeic(image) && !heicSrc[image.id]) void decodeHeic(image)
    })
  }, [index, mode, images, heicSrc])

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
    }
    setModalOpen(false)
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch {
      // Some mobile browsers intentionally do not allow element fullscreen.
    }
  }

  return (
    <>
      <div
        ref={stageRef}
        class={`viewer-stage mode-${mode} seam-${seamMode} reveal-${reveal}`}
        data-stage
        aria-label={`${slug} photograph viewer`}
        tabIndex={-1}
      >
        <div
          ref={trackRef}
          class={`viewer-track ${mode === 'vertical' ? 'viewer-track--vertical' : ''} ${mode === 'single' ? 'viewer-track--single' : ''}`}
          data-track
        >
          {images.map((image, imageIndex) => {
            const isActive = mode === 'vertical' || (mode === 'strip' ? Math.abs(imageIndex - index) <= 3 : imageIndex === index)
            const isPortrait = image.height > image.width
            return (
              <figure
                class={`viewer-frame ${isPortrait ? 'viewer-frame--portrait' : 'viewer-frame--landscape'} ${mode === 'single' && imageIndex !== index ? 'viewer-frame--hidden' : ''}`}
                data-image-id={image.id}
                data-index={imageIndex + 1}
                data-orientation={isPortrait ? 'portrait' : 'landscape'}
                style={mode === 'strip' ? { aspectRatio: `${image.width} / ${image.height}` } : undefined}
              >
                <img
                  class="frame-ph"
                  src={isActive && isHeic(image) ? image.variants?.[0]?.src ?? image.placeholder : image.placeholder}
                  alt=""
                  aria-hidden="true"
                  width={image.width}
                  height={image.height}
                  decoding="async"
                  loading={isActive ? 'eager' : 'lazy'}
                />
                {isActive && (isHeic(image) ? heicSrc[image.id] : image.src) ? (
                  <img
                    class="frame-img"
                    src={isHeic(image) ? heicSrc[image.id] : image.src}
                    data-full-src={image.src}
                    data-active="true"
                    alt={image.alt}
                    width={image.width}
                    height={image.height}
                    decoding="async"
                    loading="eager"
                    onLoad={(event: Event) => (event.currentTarget as HTMLImageElement).classList.add('is-loaded')}
                  />
                ) : null}
              </figure>
            )
          })}
        </div>
        <div class="stage-arrows" aria-label="Image navigation and information">
          {arrowsVisible ? (
            <>
              <button data-nav-arrow aria-label="Previous photograph" onClick={() => advanceStripByViewport(-1)} disabled={mode === 'single' && index === 0}>←</button>
              <button ref={nextArrowRef} data-nav-arrow aria-label="Next photograph" onClick={() => advanceStripByViewport(1)} disabled={mode === 'single' && index === images.length - 1}>→</button>
            </>
          ) : null}
          <button class="stage-info" aria-label="Image information and Content Credentials" title="Image information" onClick={openImageProvenance}>i</button>
        </div>
      </div>

      <button ref={dotRef} class="control-logo" aria-label="Display settings" title="Display settings" onClick={() => setModalOpen(true)}><span class="brand-mark-wrap"><img src="/manorama-merged-logo.png" alt="" aria-hidden="true" /><span class="brand-tld" aria-hidden="true">.xyz</span></span></button>

      <div
        ref={modalRef}
        class="controls-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Display settings"
        hidden={!modalOpen}
        onClick={(event) => { if (event.target === event.currentTarget) setModalOpen(false) }}
      >
        <div class="controls-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">{slug.replaceAll('-', ' ')}</p>
              <h2>Display settings</h2>
            </div>
            <button data-close class="quiet-button" aria-label="Close display settings" onClick={() => setModalOpen(false)}>Close</button>
          </div>

          <section class="panel-section" aria-labelledby="view-mode-heading">
            <h3 id="view-mode-heading">View mode</h3>
            <div class="mode-options" role="radiogroup" aria-label="View mode">
              <label><input type="radio" name="view-mode" value="strip" checked={mode === 'strip'} onChange={() => { setMode('strip'); setModalOpen(false) }} /> <span>Horizontal Strip</span><small>full-height, continuous</small></label>
              <label><input type="radio" name="view-mode" value="vertical" checked={mode === 'vertical'} onChange={() => { setMode('vertical'); setModalOpen(false) }} /> <span>Vertical scroll</span><small>landscapes to width, portraits to height</small></label>
              <label><input type="radio" name="view-mode" value="single" checked={mode === 'single'} onChange={() => { setMode('single'); setModalOpen(false) }} /> <span>One at a time</span><small>advance per gesture</small></label>
            </div>
          </section>

          <section class="panel-section" aria-labelledby="border-heading">
            <h3 id="border-heading">Borders</h3>
            <div class="mode-options" role="radiogroup" aria-label="Borders around photographs">
              <label><input type="radio" name="seam-mode" value="light" checked={seamMode === 'light'} onChange={() => setSeamMode('light')} /> <span>Light</span><small>light border, dark stripes</small></label>
              <label><input type="radio" name="seam-mode" value="dark" checked={seamMode === 'dark'} onChange={() => setSeamMode('dark')} /> <span>Dark</span><small>dark border, light stripes</small></label>
              <label><input type="radio" name="seam-mode" value="none" checked={seamMode === 'none'} onChange={() => setSeamMode('none')} /> <span>None</span><small>photographs sit flush</small></label>
            </div>
          </section>

          <section class="panel-section" aria-labelledby="reveal-heading">
            <h3 id="reveal-heading">Image reveal</h3>
            <div class="mode-options" role="radiogroup" aria-label="How photographs appear when loaded">
              <label><input type="radio" name="reveal-mode" value="cross" checked={reveal === 'cross'} onChange={() => setReveal('cross')} /> <span>Crossfade</span><small>new image blends over the last</small></label>
              <label><input type="radio" name="reveal-mode" value="fade" checked={reveal === 'fade'} onChange={() => setReveal('fade')} /> <span>Fade</span><small>a quiet dip, then the image</small></label>
            </div>
          </section>

          <section class="panel-section compact-section" aria-label="Display options">
            <div class="panel-actions">
              {mode === 'vertical' ? null : <button type="button" class="panel-action" onClick={() => { setShowArrows(!showArrows); setModalOpen(false) }}>{showArrows ? 'Hide navigation arrows' : 'Show navigation arrows'}</button>}
              {fullscreenAvailable ? <button type="button" class="panel-action" onClick={() => { toggleFullscreen(); setModalOpen(false) }}>{fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'}</button> : null}
            </div>
          </section>

          <section class="panel-section" aria-labelledby="about-heading" hidden>
            <h3 id="about-heading">About this gallery</h3>
            <p class="about-copy">This single-album gallery is shared as one quiet sequence. Its images are served as originals where possible; non-credentialed responsive derivatives preserve the embedded colour profile.</p>
            <button class="text-button" onClick={recallCurtain}>Recall the opening curtain</button>
          </section>

          <section class="panel-section shortcuts" aria-labelledby="shortcuts-heading">
            <h3 id="shortcuts-heading">Keyboard shortcuts</h3>
            <p><kbd>←</kbd><kbd>→</kbd> move between photographs</p>
            <p><kbd>Home</kbd><kbd>End</kbd> jump to the ends</p>
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
        onClick={(event) => { if (event.target === event.currentTarget) setInfoOpen(false) }}
      >
        <div class="controls-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">{slug.replaceAll('-', ' ')}</p>
              <h2>Current photograph</h2>
            </div>
            <button data-close class="quiet-button" aria-label="Close image information" onClick={() => setInfoOpen(false)}>Close</button>
          </div>

          <section class="panel-section" aria-labelledby="position-heading">
            <div class="section-heading"><h3 id="position-heading">Position</h3><span class="position-value">{index + 1} / {images.length}</span></div>
            <p class="quiet-copy">Photograph {index + 1} of {images.length}</p>
          </section>

          <section class="panel-section" aria-labelledby="info-heading">
            <h3 id="info-heading">Image info</h3>
            <dl class="info-grid">
              <div><dt>File</dt><dd>{currentImage?.filename}</dd></div>
              <div><dt>Dimensions</dt><dd>{currentImage?.width} × {currentImage?.height}</dd></div>
              {currentImage?.exif?.camera ? <div><dt>Camera</dt><dd>{currentImage.exif.camera}</dd></div> : null}
              {currentImage?.exif?.lens ? <div><dt>Lens</dt><dd>{currentImage.exif.lens}</dd></div> : null}
              {currentImage?.exif?.aperture ? <div><dt>Aperture</dt><dd>{currentImage.exif.aperture}</dd></div> : null}
              {currentImage?.exif?.iso ? <div><dt>ISO</dt><dd>{currentImage.exif.iso}</dd></div> : null}
              {currentImage?.exif?.dateOriginal ? <div><dt>Captured</dt><dd>{currentImage.exif.dateOriginal}</dd></div> : null}
            </dl>
          </section>

          <section class="panel-section" data-c2pa-panel aria-labelledby="credentials-heading">
            <div class="section-heading"><h3 id="credentials-heading">Content Credentials</h3><span class="credential-mark" aria-hidden="true">C2PA</span></div>
            {!currentImage?.c2pa ? <p class="quiet-copy">This photograph carries no Content Credentials.</p> : credentialState[currentImage.id] === 'loading' ? <p class="quiet-copy">Checking Content Credentials locally…</p> : credentialState[currentImage.id] === 'verified' ? <><p class="quiet-copy credential-success">Content Credentials verified in this browser.</p><cai-manifest-summary manifestStore={credentialStores[currentImage.id]}></cai-manifest-summary></> : credentialState[currentImage.id] === 'unavailable' ? <><p class="quiet-copy">Content Credentials are present, but could not be validated in this browser session.</p><button class="text-button" onClick={openCredentials}>Try verification again</button></> : <><p class="quiet-copy">This photograph carries embedded Content Credentials.</p><button class="text-button" onClick={openCredentials}>Verify in this browser</button></>}
          </section>
        </div>
      </div>
    </>
  )
}
