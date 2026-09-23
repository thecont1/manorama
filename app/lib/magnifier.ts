/**
 * The M magnifier: a glass-ball loupe that replaces the cursor and
 * magnifies the stage beneath it 3×.
 *
 * Why a DOM mirror rather than a CSS transform on the stage itself: the
 * stage is `overflow: hidden`, so nothing can visually escape it, and the
 * strip's `translate3d` track must keep its own transform. The lens is a
 * fixed, circular, pointer-transparent element on `document.body` holding
 * a *clone* of the stage's children. Each frame the clone is translated
 * so the point under the cursor sits at the lens centre, then scaled.
 *
 * The clone is inert: `<video>` elements are swapped for their posters so
 * a clip is never decoded twice, and the whole lens is `aria-hidden` —
 * it is a decorative view of content the page already exposes.
 */

export const MAGNIFIER_SCALE = 3

/**
 * The zoom actually applied under the cursor: the requested magnification,
 * but never past the pixels the photograph really has. `natural / rendered`
 * is how many source pixels back one CSS pixel — magnifying beyond that
 * ratio is not detail, it is blur. When the source is smaller than the
 * requested zoom the lens settles at the honest 1:1 sample of the file
 * instead of upscaling; a floor of 1 keeps it a loupe, never a shrink-ray.
 * The min over both axes covers object-fit cropping: the constraint is the
 * axis showing the fewest pixels per CSS pixel.
 */
export const lensScale = (naturalW: number, naturalH: number, renderedW: number, renderedH: number): number => {
  if (!(naturalW > 0) || !(naturalH > 0) || !(renderedW > 0) || !(renderedH > 0)) return MAGNIFIER_SCALE
  const native = Math.min(naturalW / renderedW, naturalH / renderedH)
  return Math.min(MAGNIFIER_SCALE, Math.max(1, native))
}

export type MagnifierHandle = {
  /** Show the lens and start following the pointer. */
  activate: () => void
  /** Hide the lens; safe to call when already inactive. */
  deactivate: () => void
  isActive: () => boolean
  /** Remove every element, observer and listener this created. */
  destroy: () => void
}

/** Desktop only: a loupe that replaces the cursor is meaningless without
 *  a hovering, precise pointer. Touch and pen are excluded. */
export const magnifierSupported = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Attaches a magnifier to a stage element. Returns a handle; call
 * `destroy()` on unmount. Returns null when the environment cannot
 * support a lens (no DOM, coarse pointer).
 */
export const attachMagnifier = (stage: HTMLElement | null): MagnifierHandle | null => {
  if (!stage || typeof document === 'undefined' || !magnifierSupported()) return null

  const lens = document.createElement('div')
  lens.className = 'magnifier-lens'
  lens.setAttribute('aria-hidden', 'true')
  lens.hidden = true

  // The scroll wrapper reproduces vertical mode's internal scroll: the
  // stage scrolls its own content there, so the clone must be offset by
  // the same amount or the lens shows the wrong part of the gallery.
  const scroller = document.createElement('div')
  scroller.className = 'magnifier-scroll'
  const world = document.createElement('div')
  world.className = 'magnifier-world'
  scroller.appendChild(world)
  lens.appendChild(scroller)
  document.body.appendChild(lens)

  let active = false
  let frame: number | null = null
  let cloneTimer: number | null = null
  // Seeded at the viewport centre so the very first paint is never stuck
  // in the top-left corner: `activate()` can fire from a keypress before
  // any pointermove has been observed, and the lens must appear somewhere
  // sensible until the pointer next moves.
  let pointer = {
    x: (typeof window !== 'undefined' ? window.innerWidth : 0) / 2,
    y: (typeof window !== 'undefined' ? window.innerHeight : 0) / 2,
  }
  let pointerSeen = false

  /** Rebuilds the mirrored DOM. Videos become their poster image: a
   *  cloned <video> would fetch and decode the clip a second time, and an
   *  ambient loop running out of sync inside the lens looks broken. */
  const recloneWorld = () => {
    world.replaceChildren()
    for (const child of Array.from(stage.children)) {
      // The lens must not mirror the page's own controls (arrows, info
      // button) — only the photographs. Checked by duck-typing rather
      // than `instanceof HTMLElement`: that global is not guaranteed to
      // exist in every DOM the module runs in.
      const dataset = (child as Partial<HTMLElement>).dataset
      if (dataset && dataset.magnifierIgnore !== undefined) continue
      world.appendChild(child.cloneNode(true))
    }
    for (const video of Array.from(world.querySelectorAll('video'))) {
      const poster = document.createElement('img')
      poster.src = video.getAttribute('poster') ?? ''
      poster.alt = ''
      poster.setAttribute('aria-hidden', 'true')
      poster.className = video.className
      const style = video.getAttribute('style')
      if (style) poster.setAttribute('style', style)
      video.replaceWith(poster)
    }
    // A thumbnail must never be the thing the lens magnifies: where the
    // live stage has mounted the frame's real image, the clone's
    // placeholder takes that same already-decoded source rather than
    // showing a 256px rendition at 3x.
    for (const ph of Array.from(world.querySelectorAll<HTMLImageElement>('img.frame-ph'))) {
      const real = ph.closest('.viewer-frame')?.querySelector<HTMLImageElement>('img.frame-img')
      if (real?.src && ph.src !== real.src) ph.src = real.src
    }
    // Clones must never be focusable or announced — the lens duplicates
    // content that already exists in the accessibility tree.
    for (const node of Array.from(world.querySelectorAll('[id]'))) node.removeAttribute('id')
    for (const node of Array.from(world.querySelectorAll('button, a, input, [tabindex]'))) {
      node.setAttribute('tabindex', '-1')
      node.setAttribute('aria-hidden', 'true')
    }
    syncGeometry()
  }

  /** Mirrors the live stage geometry into the clone: the track's strip
   *  transform (including momentum), the stage's scroll offsets, its size
   *  and its mode classes. Without this the lens drifts out of sync
   *  the moment anything moves. */
  const syncGeometry = () => {
    const rect = stage.getBoundingClientRect()
    world.style.width = `${rect.width}px`
    world.style.height = `${rect.height}px`
    // The stage's measured height feeds rules like vertical mode's
    // `max-height: var(--viewer-stage-height)` — the world lives on
    // document.body, where the var would fall back to 100dvh and lay the
    // clone out taller than the stage it mirrors.
    world.style.setProperty(
      '--viewer-stage-height',
      stage.style.getPropertyValue('--viewer-stage-height') || `${rect.height}px`,
    )
    const track = stage.querySelector<HTMLElement>('[data-track]')
    const clonedTrack = world.querySelector<HTMLElement>('[data-track]')
    if (track && clonedTrack) clonedTrack.style.transform = track.style.transform
    scroller.scrollTop = stage.scrollTop
    scroller.scrollLeft = stage.scrollLeft
    // Mirror the mode classes so the clone lays out identically, but
    // never `viewer-stage` itself: a second element with that class would
    // pick up the stage's own fixed sizing rules and would make every
    // `.viewer-stage` selector — in CSS and in tests — ambiguous.
    // `is-magnified` is likewise the real stage's state, not the mirror's.
    const mirroredClasses = Array.from(stage.classList)
      .filter((name) => name !== 'viewer-stage' && name !== 'is-magnified')
    world.className = ['magnifier-world', ...mirroredClasses].join(' ')
  }

  const render = () => {
    frame = null
    if (!active) return
    const rect = stage.getBoundingClientRect()
    const radius = lens.offsetWidth / 2
    // Cursor position in the stage's own coordinate space.
    const sx = pointer.x - rect.left
    const sy = pointer.y - rect.top
    lens.style.left = `${pointer.x - radius}px`
    lens.style.top = `${pointer.y - radius}px`
    syncGeometry()
    // Put the magnified point at the lens centre: translate so (sx,sy)
    // scaled by S lands on the radius, then scale. S is capped at the
    // native resolution of the image under the cursor — a low-resolution
    // source gets its honest 1:1 sample rather than an enlarged blur.
    const underPointer = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(pointer.x, pointer.y)
      : null
    const frameEl = underPointer?.closest?.('.viewer-frame') ?? null
    const img = frameEl?.querySelector<HTMLImageElement>('img.frame-img') ?? null
    const imgRect = img?.getBoundingClientRect()
    const scale = lensScale(img?.naturalWidth ?? 0, img?.naturalHeight ?? 0, imgRect?.width ?? 0, imgRect?.height ?? 0)
    // The scroller mirrors the stage's own scroll offsets, subtracting
    // them after the transform — so the point under the cursor lives at
    // (sx + scrollLeft, sy + scrollTop) in content space and the offset
    // must be folded back: radius - S·(s + scroll) + scroll. Without it
    // the lens drifts (S - 1)·scrollTop off in a scrolled vertical stage.
    const scrollX = scroller.scrollLeft
    const scrollY = scroller.scrollTop
    world.style.transform =
      `translate(${radius - scale * (sx + scrollX) + scrollX}px, ${radius - scale * (sy + scrollY) + scrollY}px) scale(${scale})`
  }

  const schedule = () => {
    if (frame !== null || !active) return
    frame = requestAnimationFrame(render)
  }

  const onPointerMove = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY }
    pointerSeen = true
    if (active) schedule()
  }

  // Tracked even while inactive: `M` is a keypress, so the pointer may not
  // move again before the lens is shown. Without this the first frame
  // renders at a stale (or seeded) position instead of under the cursor.
  const startTracking = () => window.addEventListener('pointermove', onPointerMove, { passive: true })
  const stopTracking = () => window.removeEventListener('pointermove', onPointerMove)

  // The mirrored DOM goes stale whenever a frame loads, heals its aspect
  // ratio, or the active window shifts. Debounced so a burst of mutations
  // costs one reclone.
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
    if (!active) return
    if (cloneTimer !== null) window.clearTimeout(cloneTimer)
    cloneTimer = window.setTimeout(() => {
      cloneTimer = null
      if (active) recloneWorld()
    }, 120)
  })

  const activate = () => {
    if (active) return
    active = true
    lens.hidden = false
    lens.classList.toggle('is-instant', prefersReducedMotion())
    stage.classList.add('is-magnified')
    recloneWorld()
    window.addEventListener('scroll', schedule, { passive: true })
    stage.addEventListener('scroll', schedule, { passive: true })
    observer?.observe(stage, { subtree: true, childList: true, attributes: true, characterData: false })
    // Paint immediately at the last known pointer position rather than
    // waiting for the next mouse move.
    render()
  }

  const deactivate = () => {
    if (!active) return
    active = false
    lens.hidden = true
    stage.classList.remove('is-magnified')
    window.removeEventListener('scroll', schedule)
    stage.removeEventListener('scroll', schedule)
    observer?.disconnect()
    if (frame !== null) { cancelAnimationFrame(frame); frame = null }
    if (cloneTimer !== null) { window.clearTimeout(cloneTimer); cloneTimer = null }
    world.replaceChildren()
  }

  const destroy = () => {
    deactivate()
    stopTracking()
    lens.remove()
  }

  startTracking()
  return { activate, deactivate, isActive: () => active, destroy }
}
