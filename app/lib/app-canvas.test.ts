import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import ground from '../assets/gallery-ground'
import { APP_CANVAS_INKS, appCanvasSvg, type AppCanvasPalette } from './app-canvas'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('../styles/canvas.css')

describe('approved app canvas', () => {
  for (const palette of Object.keys(APP_CANVAS_INKS) as AppCanvasPalette[]) {
    test(`${palette} public tile is the deterministic 256px export of every approved path`, () => {
      const svg = appCanvasSvg(palette)
      expect(read(`../../public/app-canvas-${palette}.svg`)).toBe(svg)
      const window = new Window()
      const doc = new window.DOMParser().parseFromString(svg, 'image/svg+xml')
      expect(doc.documentElement.getAttribute('width')).toBe('256')
      expect(doc.documentElement.getAttribute('height')).toBe('256')
      expect(doc.documentElement.getAttribute('color')).toBe(APP_CANVAS_INKS[palette])
      expect(doc.querySelector('pattern')?.getAttribute('patternUnits')).toBe('userSpaceOnUse')
      expect(doc.querySelector('[data-gallery-ground-scale]')?.getAttribute('transform')).toBe('scale(0.25)')
      const groups = Array.from(doc.querySelectorAll('[data-gallery-ground-motif]'))
      expect(groups.map(group => ({
        motifId: group.getAttribute('data-gallery-ground-motif'),
        placementId: group.getAttribute('data-gallery-ground-placement'),
        paths: Array.from(group.querySelectorAll('path')).map(path => path.getAttribute('d')),
      }))).toEqual(ground.groups)
      for (const path of doc.querySelectorAll('path')) {
        expect(path.getAttribute('stroke-width')).toBe('3')
        expect(path.getAttribute('stroke')).toBe('currentColor')
      }
      expect(doc.querySelectorAll('image, filter, foreignObject, script')).toHaveLength(0)
    })
  }

  test('the owner theme and dark viewer sheets select the same two tiles', () => {
    expect(css).toContain("html.light { --app-canvas-image: url('/app-canvas-light.svg'); }")
    expect(css).toContain(".m-dark { --app-canvas-image: url('/app-canvas-dark.svg'); }")
    const galleryCss = read('../styles.css')
    expect(galleryCss).toContain(`--doodle-ink: ${APP_CANVAS_INKS.dark}`)
    expect(galleryCss).toContain(`--doodle-ink: ${APP_CANVAS_INKS.light}`)
    expect(css).toContain('background-size: 256px 256px')
  })

  test('canvas selectors cover app screens but never photograph boxes, buttons or ad plates', () => {
    const selector = css.slice(css.indexOf(':root:is('), css.indexOf(') {', css.indexOf(':root:is(')))
    for (const surface of ['.admin-page', '.m-sheet', '.m-screen', '.native-welcome', '.native-global-view', '.native-editor', '.desktop-welcome']) {
      expect(selector).toContain(surface)
    }
    /* The curtain opens the gallery and stays a plain veil: the artwork is
       the first reveal, so it never wears the app wall either. */
    for (const excluded of ['.viewer-stage', '.viewer-frame', '.viewer-ad-frame', '.viewer-endcap', '.curtain', 'img', 'button', '.lib-card']) {
      expect(selector).not.toContain(excluded)
    }
    expect(css).not.toContain('backdrop-filter:')
    expect(css).not.toContain('animation:')
  })

  test('transparent UI gets themed fill-only backings without changing source content', () => {
    expect(css).toContain('--app-surface-alpha: .82')
    expect(css).toContain('rgba(22, 22, 22, var(--app-surface-alpha))')
    expect(css).toContain('rgba(233, 229, 220, var(--app-surface-alpha))')
    const backing = css.slice(css.indexOf('  .text-button,'), css.indexOf('/* Honor the shell'))
    for (const surface of ['.admin-button:not(.admin-button--solid)', '.m-btn--quiet', '.account-ad', '[data-account-ad]', '.admin-gallery-strip-frame', '.lib-rail', '.lib-card-menu']) {
      expect(backing).toContain(surface)
    }
    expect(backing).toContain('background-color: var(--app-translucent-surface)')
    expect(backing).not.toMatch(/(?:^|\n)\s*(?:opacity|filter|transform|pointer-events|padding|width|height):/)
    for (const photoSurface of ['.viewer-frame', '.viewer-ad-frame', '.viewer-endcap', '.viewer-filmstrip-item', '.lib-th']) {
      expect(backing).not.toContain(photoSurface)
    }
  })

  test('reduced transparency and increased contrast make only the UI fill opaque', () => {
    expect(css).toContain(':root[data-reduced-transparency] { --app-surface-alpha: 1; }')
    expect(css).toContain('@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)')
    expect(css).toContain('.m-dark, .curtain, .viewer-filmstrip {\n  --app-translucent-surface: rgba(22, 22, 22, var(--app-surface-alpha));')
  })

  test('web marketing is excluded and native/desktop load the shared stylesheet', () => {
    const renderer = read('../routes/_renderer.tsx')
    expect(renderer).toContain("class={home ? 'home-page' : 'app-page'}")
    expect(renderer).toContain('{home ? null : <Link href="/app/styles/canvas.css" rel="stylesheet" />}')
    for (const entry of ['../../native/main.tsx', '../../desktop/main.tsx']) {
      expect(read(entry)).toContain("import '../app/styles/canvas.css'")
    }
  })
})
