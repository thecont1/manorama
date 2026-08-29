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
type DragSample = { x: number; time: number }
type Props = {
  slug: string
  images: readonly GalleryImage[]
  settings: GallerySettings
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export default function Viewer({ slug, images: sourceImages, settings: initialSettings }: Props) {
  const [settings, setSettings] = useState<GallerySettings>(initialSettings)
  const images = useMemo(() => sourceImages.map((image) => imageWithSettings(image, settings)), [sourceImages, settings])
  const [mode, setMode] = useState<Mode>(initialSettings.defaultMode)
  const [index, setIndex] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [showArrows, setShowArrows] = useState(initialSettings.defaultShowArrows)
  const [showCaptions, setShowCaptions] = useState(initialSettings.defaultShowCaptions)
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false)
  const [fullscreenActive, setFullscreenActive] = useState(false)
  const [credentialState, setCredentialState] = useState<Record<string, 'idle' | 'loading' | 'verified' | 'unavailable'>>({})
  const [credentialStores, setCredentialStores] = useState<Record<string, unknown>>({})
  const stageRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const modalRef = useRef<HTMLDivElement | null>(null)
  const dotRef = useRef<HTMLButtonElement | null>(null)
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
    updateText('[data-curtain-title]', loaded.title.replace(/\b\w/g, (c) => c.toUpperCase()))
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

  const hasMultiple = images.length > 1
  const arrowsVisible = showArrows && mode !== 'vertical'

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
    const duration = 300
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
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
    const viewportWidth = stageRef.current?.clientWidth ?? window.innerWidth
    const currentFrame = trackRef.current?.querySelector<HTMLElement>(`[data-index="${indexRef.current + 1}"]`)
    const imageWidth = currentFrame?.offsetWidth ?? viewportWidth
    const advance = Math.min(viewportWidth, imageWidth)
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
      dotRef.current?.focus({ preventScroll: true })
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
    const onClick = () => {
      if (ignoreClick) { ignoreClick = false; return }
      dismiss()
    }
    curtain.addEventListener('click', onClick)
    curtain.addEventListener('keydown', onKey)
    curtain.addEventListener('pointerdown', onPointerDown)
    curtain.addEventListener('pointerup', onPointerUp)
    curtain.addEventListener('pointercancel', onPointerCancel)
    return () => {
      curtain.removeEventListener('click', onClick)
      curtain.removeEventListener('keydown', onKey)
      curtain.removeEventListener('pointerdown', onPointerDown)
      curtain.removeEventListener('pointerup', onPointerUp)
      curtain.removeEventListener('pointercancel', onPointerCancel)
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
      if (modalOpen || !document.body.classList.contains('gallery-entered')) return
      if (event.key === 'ArrowRight') { event.preventDefault(); advanceStripByViewport(1) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); advanceStripByViewport(-1) }
      if (event.key === 'Home') { event.preventDefault(); goTo(0, true) }
      if (event.key === 'End') { event.preventDefault(); goTo(images.length - 1, true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, mode, modalOpen, images.length])

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
      dragSamplesRef.current = [{ x: event.clientX, time: performance.now() }]
      stage.setPointerCapture(event.pointerId)
      stage.classList.add('is-dragging')
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return
      const dx = event.clientX - lastPointerRef.current.x
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      dragTargetXRef.current += dx
      const now = performance.now()
      dragSamplesRef.current.push({ x: event.clientX, time: now })
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
    if (!modalOpen) return
    previousFocusRef.current = document.activeElement as HTMLElement
    requestAnimationFrame(() => {
      modalRef.current?.querySelector<HTMLElement>('[data-c2pa-panel]')?.scrollIntoView({ block: 'start' })
      modalRef.current?.querySelector<HTMLElement>('[data-close]')?.focus({ preventScroll: true })
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setModalOpen(false); return }
      if (event.key !== 'Tab' || !modalRef.current) return
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hasAttribute('disabled'))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modalOpen])

  useEffect(() => {
    if (modalOpen) return
    if (previousFocusRef.current) {
      previousFocusRef.current.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [modalOpen])

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
    setModalOpen(true)
    if (currentImage?.c2pa && credentialState[currentImage.id] === 'idle') void openCredentials()
  }

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
        class={`viewer-stage mode-${mode}`}
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
            const isActive = mode === 'vertical' || (mode === 'strip' ? Math.abs(imageIndex - index) <= 2 : imageIndex === index)
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
                  src={isActive ? image.src : image.placeholder}
                  data-full-src={image.src}
                  data-placeholder-src={image.placeholder}
                  data-active={isActive ? 'true' : 'false'}
                  alt={image.alt}
                  width={image.width}
                  height={image.height}
                  decoding="async"
                  loading={isActive ? 'eager' : 'lazy'}
                />
              </figure>
            )
          })}
        </div>
        {arrowsVisible ? (
          <div class="stage-arrows" aria-label="Image navigation">
            <button data-nav-arrow aria-label="Previous photograph" onClick={() => advanceStripByViewport(-1)} disabled={mode === 'single' && index === 0}>←</button>
            <button data-nav-arrow aria-label="Next photograph" onClick={() => advanceStripByViewport(1)} disabled={mode === 'single' && index === images.length - 1}>→</button>
          </div>
        ) : null}
      </div>

      <button ref={dotRef} class="control-logo" aria-label="Image information and Content Credentials" onClick={openImageProvenance}><img src="/manorama-logo-upright-test.png" alt="" aria-hidden="true" /></button>

      <div
        ref={modalRef}
        class="controls-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Image information and Content Credentials"
        hidden={!modalOpen}
        onClick={(event) => { if (event.target === event.currentTarget) setModalOpen(false) }}
      >
        <div class="controls-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">{slug.replaceAll('-', ' ')}</p>
              <h2>Current photograph</h2>
            </div>
            <button data-close class="quiet-button" aria-label="Close image information" onClick={() => setModalOpen(false)}>Close</button>
          </div>

          <section class="panel-section" aria-labelledby="view-mode-heading">
            <h3 id="view-mode-heading">View mode</h3>
            <div class="mode-options" role="radiogroup" aria-label="View mode">
              <label><input type="radio" name="view-mode" value="strip" checked={mode === 'strip'} onChange={() => setMode('strip')} /> <span>Strip</span><small>full-height, continuous</small></label>
              <label><input type="radio" name="view-mode" value="vertical" checked={mode === 'vertical'} onChange={() => setMode('vertical')} /> <span>Vertical scroll</span><small>landscapes to width, portraits to height</small></label>
              <label><input type="radio" name="view-mode" value="single" checked={mode === 'single'} onChange={() => setMode('single')} /> <span>One at a time</span><small>advance per gesture</small></label>
            </div>
          </section>

          <section class="panel-section compact-section" aria-label="Display options">
            <label class="toggle-row"><span>Show captions</span><input type="checkbox" aria-label="Show captions" checked={showCaptions} onChange={(event) => setShowCaptions((event.target as HTMLInputElement).checked)} /></label>
            {showCaptions ? <p class="quiet-copy">{currentImage?.caption || 'This album does not carry a separate caption for the current photograph.'}</p> : null}
            {mode === 'vertical' ? <p class="quiet-copy">Navigation arrows are unavailable in vertical scroll.</p> : <label class="toggle-row"><span>Show navigation arrows</span><input type="checkbox" aria-label="Show navigation arrows" checked={showArrows} onChange={(event) => setShowArrows((event.target as HTMLInputElement).checked)} /></label>}
            {fullscreenAvailable ? <button class="text-button" onClick={toggleFullscreen}>{fullscreenActive ? 'Exit fullscreen' : 'Enter fullscreen'}</button> : null}
          </section>

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

          <section class="panel-section" aria-labelledby="about-heading">
            <h3 id="about-heading">About this gallery</h3>
            <p class="about-copy">This single-album gallery is shared as one quiet sequence. Its images are served as originals where possible; non-credentialed responsive derivatives preserve the embedded colour profile.</p>
            <button class="text-button" onClick={recallCurtain}>Recall the opening curtain</button>
          </section>

          <section class="panel-section shortcuts" aria-labelledby="shortcuts-heading">
            <h3 id="shortcuts-heading">Keyboard shortcuts</h3>
            <p><kbd>←</kbd><kbd>→</kbd> move between photographs <span>·</span> <kbd>Home</kbd><kbd>End</kbd> jump to the ends <span>·</span> <kbd>Esc</kbd> close controls</p>
          </section>
        </div>
      </div>
    </>
  )
}
