import { beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { attachMagnifier, lensScale, magnifierSupported, MAGNIFIER_SCALE } from './magnifier'

/**
 * The magnifier drives real DOM, so it is tested against one. happy-dom
 * gives us the pointer-media query, MutationObserver, rAF and element
 * geometry the lens depends on.
 */

/** Installs a DOM with a controllable pointer capability. */
const installDom = (options: { finePointer: boolean; reducedMotion?: boolean } = { finePointer: true }) => {
  const window = new Window({ width: 1440, height: 900 })
  const document = window.document
  document.body.innerHTML = `
    <div class="viewer-stage mode-strip seam-none" data-stage>
      <div class="viewer-track" data-track style="transform: translate3d(-120px, 0, 0)">
        <figure class="viewer-frame" data-index="1">
          <img class="frame-ph" src="/a-thumb.jpg" alt="" />
          <img class="frame-img" src="/a.jpg" alt="A" />
        </figure>
        <figure class="viewer-frame" data-index="2">
          <img class="frame-ph" src="/poster.jpg" alt="" />
          <video class="frame-video" src="/clip.mp4" poster="/poster.jpg"></video>
        </figure>
      </div>
      <div class="stage-arrows" data-magnifier-ignore><button id="next">→</button></div>
    </div>`

  // matchMedia is the gate the module consults.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('hover: hover')
      ? options.finePointer
      : query.includes('prefers-reduced-motion')
        ? Boolean(options.reducedMotion)
        : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia

  const globals = globalThis as Record<string, unknown>
  globals.window = window
  globals.document = document
  globals.MutationObserver = window.MutationObserver
  globals.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 0) as unknown as number
  globals.cancelAnimationFrame = (id: number) => window.clearTimeout(id as unknown as Parameters<typeof window.clearTimeout>[0])
  return { window, document }
}

const stageOf = (document: { querySelector: (s: string) => unknown }) =>
  document.querySelector('[data-stage]') as unknown as HTMLElement

describe('lensScale', () => {
  test('full magnification while native pixels remain', () => {
    // 4000px photo rendered at 500px — 8x of real data, cap at 3.
    expect(lensScale(4000, 3000, 500, 375)).toBe(MAGNIFIER_SCALE)
  })

  test('caps at the native 1:1 sample rather than upscaling', () => {
    // 800px photo rendered at 500px — only 1.6x of real data exists.
    expect(lensScale(800, 600, 500, 375)).toBe(1.6)
  })

  test('never shrinks below 1 — it is a loupe, not a shrink-ray', () => {
    expect(lensScale(300, 200, 600, 400)).toBe(1)
  })

  test('falls back to full magnification when the image has not decoded', () => {
    expect(lensScale(0, 0, 500, 375)).toBe(MAGNIFIER_SCALE)
  })
})

describe('magnifierSupported', () => {
  test('true for a hovering, precise pointer', () => {
    installDom({ finePointer: true })
    expect(magnifierSupported()).toBe(true)
  })

  test('false on a coarse-pointer device — the lens is desktop-only', () => {
    installDom({ finePointer: false })
    expect(magnifierSupported()).toBe(false)
  })
})

describe('attachMagnifier', () => {
  test('returns null on a coarse pointer and creates no DOM', () => {
    const { document } = installDom({ finePointer: false })
    expect(attachMagnifier(stageOf(document))).toBeNull()
    expect(document.querySelector('.magnifier-lens')).toBeNull()
  })

  test('returns null without a stage', () => {
    installDom({ finePointer: true })
    expect(attachMagnifier(null)).toBeNull()
  })

  test('creates a hidden, aria-hidden lens on attach', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))
    const lens = document.querySelector('.magnifier-lens') as unknown as HTMLElement
    expect(lens).not.toBeNull()
    expect(lens.hidden).toBe(true)
    expect(lens.getAttribute('aria-hidden')).toBe('true')
    expect(handle!.isActive()).toBe(false)
    handle!.destroy()
  })

  test('activation shows the lens, marks the stage, and mirrors the frames', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    const lens = document.querySelector('.magnifier-lens') as unknown as HTMLElement
    expect(lens.hidden).toBe(false)
    expect(handle.isActive()).toBe(true)
    // cursor:none rides on this class.
    expect(stageOf(document).classList.contains('is-magnified')).toBe(true)
    const world = document.querySelector('.magnifier-world') as unknown as HTMLElement
    expect(world.querySelectorAll('.viewer-frame').length).toBe(2)
    handle.destroy()
  })

  test('a cloned placeholder upgrades to the frame\u2019s real source, never a thumbnail', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    const world = document.querySelector('.magnifier-world') as unknown as HTMLElement
    const ph = world.querySelector<HTMLImageElement>('img.frame-ph')!
    expect(ph.getAttribute('src')).toBe('/a.jpg')
    handle.destroy()
  })

  test('the clone swaps <video> for its poster image — a clip never plays in the lens', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    const world = document.querySelector('.magnifier-world') as unknown as HTMLElement
    expect(world.querySelectorAll('video').length).toBe(0)
    const posters = Array.from(world.querySelectorAll('img')) as unknown as HTMLImageElement[]
    expect(posters.some((img) => img.getAttribute('src') === '/poster.jpg')).toBe(true)
    handle.destroy()
  })

  test('the lens does not mirror the page controls', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    const world = document.querySelector('.magnifier-world') as unknown as HTMLElement
    expect(world.querySelector('.stage-arrows')).toBeNull()
    handle.destroy()
  })

  test('cloned interactive nodes are removed from the a11y tree and tab order', () => {
    const { document } = installDom()
    const stage = stageOf(document)
    // A button inside the mirrored area (not ignored) must be neutralized.
    stage.querySelector('[data-track]')!.insertAdjacentHTML('beforeend', '<button id="inner">x</button>')
    const handle = attachMagnifier(stage)!
    handle.activate()
    const world = document.querySelector('.magnifier-world') as unknown as HTMLElement
    const cloned = world.querySelector('button') as unknown as HTMLElement
    expect(cloned.getAttribute('tabindex')).toBe('-1')
    expect(cloned.getAttribute('aria-hidden')).toBe('true')
    // Duplicate ids would break every getElementById in the page.
    expect(world.querySelector('#inner')).toBeNull()
    handle.destroy()
  })

  test('the mirrored track carries the live strip transform', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    const clonedTrack = document.querySelector('.magnifier-world [data-track]') as unknown as HTMLElement
    expect(clonedTrack.style.transform).toBe('translate3d(-120px, 0, 0)')
    handle.destroy()
  })

  test('the world scales by exactly 3x', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    const world = document.querySelector('.magnifier-world') as unknown as HTMLElement
    expect(MAGNIFIER_SCALE).toBe(3)
    expect(world.style.transform).toContain('scale(3)')
    handle.destroy()
  })

  test('deactivate hides the lens, clears the mirror, and unmarks the stage', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    handle.deactivate()
    const lens = document.querySelector('.magnifier-lens') as unknown as HTMLElement
    expect(lens.hidden).toBe(true)
    expect(handle.isActive()).toBe(false)
    expect(stageOf(document).classList.contains('is-magnified')).toBe(false)
    expect((document.querySelector('.magnifier-world') as unknown as HTMLElement).children.length).toBe(0)
    handle.destroy()
  })

  test('deactivate twice and destroy are safe', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.deactivate()
    handle.activate()
    handle.deactivate()
    handle.deactivate()
    expect(() => handle.destroy()).not.toThrow()
    expect(document.querySelector('.magnifier-lens')).toBeNull()
  })

  test('destroy removes the lens from the document entirely', () => {
    const { document } = installDom()
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    handle.destroy()
    expect(document.querySelector('.magnifier-lens')).toBeNull()
    expect(stageOf(document).classList.contains('is-magnified')).toBe(false)
  })

  test('reduced motion skips the scale-in animation', () => {
    const { document } = installDom({ finePointer: true, reducedMotion: true })
    const handle = attachMagnifier(stageOf(document))!
    handle.activate()
    const lens = document.querySelector('.magnifier-lens') as unknown as HTMLElement
    expect(lens.classList.contains('is-instant')).toBe(true)
    handle.destroy()
  })
})
