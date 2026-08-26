import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { GalleryImage } from '../lib/imagesource'
import { imageWithSettings, loadStoredGallerySettings, type GallerySettings } from '../lib/gallery-settings'

/**
 * Strip invariant: each frame derives its width from the source aspect ratio at
 * full stage height. The stage may clip the horizontal journey, never pixels
 * above or below a photograph. Pointer movement writes the track transform 1:1.
 */

type Mode = 'strip' | 'vertical' | 'single'
type Props = {
  slug: string
  images: readonly GalleryImage[]
  settings: GallerySettings
}

type DragSample = { x: number; time: number }

const getHashIndex = (length: number) => {
  if (typeof window === 'undefined') return 0
  const match = window.location.hash.match(/^#img-(\d+)$/)
  const value = match ? Number(match[1]) - 1 : 0
  return Math.max(0, Math.min(length - 1, Number.isFinite(value) ? value : 0))
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export default function Viewer({ slug, images: sourceImages, settings: initialSettings }: Props) {
  const [settings, setSettings] = useState<GallerySettings>(initialSettings)
  const images = useMemo(() => sourceImages.map((image) => imageWithSettings(image, settings)), [sourceImages, settings])
  const [mode, setMode] = useState<Mode>(initialSettings.defaultMode)
  const [index, setIndex] = useState(() => getHashIndex(sourceImages.length))
  const [x, setX] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [showArrows, setShowArrows] = useState(initialSettings.defaultShowArrows)
  const [showCaptions, setShowCaptions] = useState(initialSettings.defaultShowCaptions)
  const [credentialState, setCredentialState] = useState<Record<string, 'idle' | 'loading' | 'verified' | 'unavailable'>>({})
  const [credentialStores, setCredentialStores] = useState<Record<string, unknown>>({})
  const stageRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const modalRef = useRef<HTMLDivElement | null>(null)
  const dotRef = useRef<HTMLButtonElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const draggingRef = useRef(false)
  const lastPointerRef = useRef({ x: 0, y: 0 })
  const samplesRef = useRef<DragSample[]>([])
  const momentumRef = useRef<number | null>(null)
  const c2paRef = useRef<any>(null)
  const currentXRef = useRef(0)

  const currentImage = images[index] ?? images[0]

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
  const hasMultiple = images.length > 1

  const getBounds = () => {
    const viewport = stageRef.current?.clientWidth ?? window.innerWidth
    const content = trackRef.current?.scrollWidth ?? 0
    return { min: 0, max: Math.max(0, content - viewport) }
  }

  const reportStripPosition = (position: number) => {
    const stage = stageRef.current
    const track = trackRef.current
    if (!stage || !track) return
    const midpoint = -position + stage.clientWidth / 2
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
    setIndex((previous) => previous === nearest ? previous : nearest)
  }

  const renderX = (next: number) => {
    const bounds = getBounds()
    const value = clamp(next, -bounds.max, 0)
    currentXRef.current = value
    trackRef.current?.style.setProperty('transform', `translate3d(${value}px, 0, 0)`)
    setX(value)
    reportStripPosition(value)
    return value
  }

  const stopMomentum = () => {
    if (momentumRef.current !== null) {
      cancelAnimationFrame(momentumRef.current)
      momentumRef.current = null
    }
  }

  const settleTo = (target: number, instant = false) => {
    stopMomentum()
    const from = currentXRef.current
    const bounds = getBounds()
    const destination = clamp(target, -bounds.max, 0)
    if (instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      renderX(destination)
      return
    }
    const started = performance.now()
    const duration = 300
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      const next = from + (destination - from) * eased
      renderX(next)
      if (progress < 1) momentumRef.current = requestAnimationFrame(tick)
      else momentumRef.current = null
    }
    momentumRef.current = requestAnimationFrame(tick)
  }

  const imageStart = (imageIndex: number) => {
    if (imageIndex <= 0) return 0
    return trackRef.current?.querySelector<HTMLElement>(`[data-index="${imageIndex + 1}"]`)?.offsetLeft ?? 0
  }

  const goTo = (nextIndex: number, instant = false) => {
    const next = clamp(nextIndex, 0, images.length - 1)
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
    const dismiss = () => {
      curtain.hidden = true
      curtain.setAttribute('aria-hidden', 'true')
      document.body.classList.add('gallery-entered')
      dotRef.current?.focus({ preventScroll: true })
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        dismiss()
      }
    }
    curtain.addEventListener('click', dismiss)
    curtain.addEventListener('keydown', onKey)
    return () => {
      curtain.removeEventListener('click', dismiss)
      curtain.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const target = mode === 'strip' ? -imageStart(index) : 0
    renderX(target)
    if (mode === 'vertical') requestAnimationFrame(() => document.querySelector(`[data-image-id="${currentImage?.id}"]`)?.scrollIntoView({ block: 'start', behavior: 'auto' }))
  }, [mode])

  useEffect(() => {
    const onResize = () => {
      if (mode === 'strip') settleTo(-imageStart(index), true)
    }
    const onHash = () => {
      const next = getHashIndex(images.length)
      setIndex(next)
      if (mode === 'strip') settleTo(-imageStart(next), true)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    window.addEventListener('hashchange', onHash)
    onHash()
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      window.removeEventListener('hashchange', onHash)
    }
  }, [mode, images.length])

  useEffect(() => {
    const frames = stageRef.current?.querySelectorAll<HTMLImageElement>('img[data-src]')
    frames?.forEach((image) => {
      const frame = image.closest<HTMLElement>('[data-index]')
      const frameIndex = Number(frame?.dataset.index ?? 0) - 1
      if (Math.abs(frameIndex - index) <= 2 && image.dataset.src) {
        image.src = image.dataset.src
        image.removeAttribute('data-src')
      }
    })
  }, [index, mode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const current = index
    for (let offset = -2; offset <= 2; offset += 1) {
      const image = images[current + offset]
      if (!image) continue
      const preload = new Image()
      preload.decoding = 'async'
      preload.src = image.src
      preload.decode?.().catch(() => undefined)
    }
    const url = `#img-${index + 1}`
    if (window.location.hash !== url) history.replaceState(null, '', url)
  }, [index, images])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modalOpen || !document.body.classList.contains('gallery-entered')) return
      if (event.key === 'ArrowRight') { event.preventDefault(); step(1) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1) }
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
      samplesRef.current = [{ x: event.clientX, time: performance.now() }]
      stage.setPointerCapture(event.pointerId)
      stage.classList.add('is-dragging')
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return
      const dx = event.clientX - lastPointerRef.current.x
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      renderX(currentXRef.current + dx)
      const now = performance.now()
      samplesRef.current.push({ x: event.clientX, time: now })
      samplesRef.current = samplesRef.current.filter((sample) => now - sample.time < 120)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      stage.releasePointerCapture?.(event.pointerId)
      stage.classList.remove('is-dragging')
      const samples = samplesRef.current
      const first = samples[0]
      const last = samples[samples.length - 1]
      const velocity = first && last ? (last.x - first.x) / Math.max(16, last.time - first.time) : 0
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        settleTo(currentXRef.current, true)
        return
      }
      let velocityPx = velocity * 16
      const frame = () => {
        velocityPx *= 0.95
        const next = renderX(currentXRef.current + velocityPx)
        const bounds = getBounds()
        const atEdge = next === 0 || next === -bounds.max
        if (Math.abs(velocityPx) > 0.1 && !atEdge) momentumRef.current = requestAnimationFrame(frame)
        else momentumRef.current = null
      }
      momentumRef.current = requestAnimationFrame(frame)
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
      stopMomentum()
    }
  }, [mode])

  useEffect(() => {
    if (!modalOpen) return
    previousFocusRef.current = document.activeElement as HTMLElement
    requestAnimationFrame(() => modalRef.current?.querySelector<HTMLElement>('[data-close]')?.focus())
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

  useEffect(() => {
    if (!currentImage || credentialState[currentImage.id] !== 'verified') return
    const summary = document.querySelector('cai-manifest-summary') as HTMLElement & { manifestStore?: unknown } | null
    if (summary && credentialStores[currentImage.id]) summary.manifestStore = credentialStores[currentImage.id]
  }, [credentialState, credentialStores, currentImage?.id])

  const recallCurtain = () => {
    const curtain = document.querySelector<HTMLElement>('[data-curtain]')
    if (curtain) {
      curtain.hidden = false
      curtain.removeAttribute('aria-hidden')
      document.body.classList.remove('gallery-entered')
    }
    setModalOpen(false)
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
          style={mode === 'strip' ? { transform: `translate3d(${x}px, 0, 0)` } : undefined}
        >
          {images.map((image, imageIndex) => (
            <figure
              class={`viewer-frame ${mode === 'single' && imageIndex !== index ? 'viewer-frame--hidden' : ''}`}
              data-image-id={image.id}
              data-index={imageIndex + 1}
              style={mode === 'strip' ? { aspectRatio: `${image.width} / ${image.height}` } : undefined}
            >
              <img
                src={Math.abs(imageIndex - index) <= 2 ? image.src : image.placeholder}
                data-src={Math.abs(imageIndex - index) > 2 ? image.src : undefined}
                alt={image.alt}
                width={image.width}
                height={image.height}
                decoding="async"
                loading={Math.abs(imageIndex - index) <= 2 ? 'eager' : 'lazy'}
              />
            </figure>
          ))}
        </div>
        {showArrows ? (
          <div class="stage-arrows" aria-label="Image navigation">
            <button data-nav-arrow aria-label="Previous photograph" onClick={() => step(-1)} disabled={index === 0}>←</button>
            <button data-nav-arrow aria-label="Next photograph" onClick={() => step(1)} disabled={index === images.length - 1}>→</button>
          </div>
        ) : null}
      </div>

      <button ref={dotRef} class="control-dot" aria-label="Gallery controls" onClick={() => setModalOpen(true)} />

      <div
        ref={modalRef}
        class="controls-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Gallery controls"
        hidden={!modalOpen}
        onClick={(event) => { if (event.target === event.currentTarget) setModalOpen(false) }}
      >
        <div class="controls-panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">{slug.replaceAll('-', ' ')}</p>
              <h2>Gallery controls</h2>
            </div>
            <button data-close class="quiet-button" aria-label="Close gallery controls" onClick={() => setModalOpen(false)}>Close</button>
          </div>

          <section class="panel-section" aria-labelledby="view-mode-heading">
            <h3 id="view-mode-heading">View mode</h3>
            <div class="mode-options" role="radiogroup" aria-label="View mode">
              <label><input type="radio" name="view-mode" value="strip" checked={mode === 'strip'} onChange={() => setMode('strip')} /> <span>Strip</span><small>full-height, continuous</small></label>
              <label><input type="radio" name="view-mode" value="vertical" checked={mode === 'vertical'} onChange={() => setMode('vertical')} /> <span>Vertical scroll</span><small>force-fit to width</small></label>
              <label><input type="radio" name="view-mode" value="single" checked={mode === 'single'} onChange={() => setMode('single')} /> <span>One at a time</span><small>advance per gesture</small></label>
            </div>
          </section>

          <section class="panel-section compact-section" aria-label="Display options">
            <label class="toggle-row"><span>Show captions</span><input type="checkbox" aria-label="Show captions" checked={showCaptions} onChange={(event) => setShowCaptions((event.target as HTMLInputElement).checked)} /></label>
            {showCaptions ? <p class="quiet-copy">{currentImage?.caption || 'This album does not carry a separate caption for the current photograph.'}</p> : null}
            <label class="toggle-row"><span>Show navigation arrows</span><input type="checkbox" aria-label="Show navigation arrows" checked={showArrows} onChange={(event) => setShowArrows((event.target as HTMLInputElement).checked)} /></label>
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
