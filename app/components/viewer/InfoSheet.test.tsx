import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync } from 'hono/jsx/dom'
import { unmountTracker } from '../../../test/unmount'
import InfoSheet, { type InfoSheetProps } from './InfoSheet'
import { releaseAllOverlays } from '../../lib/overlay-stack'
import type { GalleryImage } from '../../lib/imagesource'

/**
 * The Content Credentials panel must never assert presence it has not
 * verified: `c2pa: true` on a manifest item only means the original bytes
 * pass through — the on-device check decides what the sheet may claim.
 * These tests pin the copy for every panel state.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const photo = (c2pa: boolean): GalleryImage => ({
  id: 'p1',
  filename: 'p1.jpg',
  src: 'https://example.test/p1.jpg',
  width: 800,
  height: 600,
  alt: 'test photograph',
  c2pa,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
})

const base: InfoSheetProps = {
  open: true,
  onClose: () => {},
  index: 0,
  total: 3,
  image: photo(true),
  isVideo: false,
  credentialState: undefined,
  credentialStore: undefined,
  onRetryCredentials: () => {},
}

// Mounts leave through the tracker: its drop removes the child via a
// flushed state update, so reconciliation runs effect cleanup — a root
// render(null) skips it exactly like wiping innerHTML does.
const mounts = unmountTracker()

const mounted = (overrides: Partial<InfoSheetProps> = {}) => {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  flushSync(() => {
    mounts.mount(<InfoSheet {...base} {...overrides} />, container as unknown as HTMLElement)
  })
  return container as unknown as HTMLElement
}

const panel = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-c2pa-panel]')

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document, fetch: globals.fetch,
  }
  dom = new Window({ url: 'http://localhost/thecontrarian/mixed' })
  globals.window = dom
  globals.document = dom.document
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.fetch = prev.fetch
})

afterEach(() => {
  releaseAllOverlays()
  mounts.unmountAll()
  dom.document.body.innerHTML = ''
})

describe('the Content Credentials panel copy', () => {
  test('an unflagged photograph gets the quiet no-credentials line', () => {
    const root = mounted({ image: photo(false), credentialState: 'idle' })
    expect(panel(root)?.textContent).toContain('This photograph carries no Content Credentials.')
  })

  test('idle hedges — it may carry credentials and offers the check', () => {
    const root = mounted({ credentialState: 'idle' })
    expect(panel(root)?.textContent).toContain('This photograph may carry Content Credentials.')
    const button = [...panel(root)!.querySelectorAll('button')].find((b) => b.textContent === 'Check on this device')
    expect(button).toBeTruthy()
  })

  test('loading says the check is running', () => {
    const root = mounted({ credentialState: 'loading' })
    expect(panel(root)?.textContent).toContain('Checking Content Credentials on this device…')
  })

  test('verified reports the manifest', () => {
    const root = mounted({ credentialState: 'verified', credentialStore: {} })
    expect(panel(root)?.textContent).toContain('Content Credentials verified on this device.')
    expect(panel(root)?.querySelector('cai-manifest-summary')).not.toBeNull()
  })

  test('unavailable admits the check failed and offers a retry', () => {
    const root = mounted({ credentialState: 'unavailable' })
    expect(panel(root)?.textContent).toContain('Content Credentials could not be checked here.')
    expect(panel(root)?.textContent).not.toContain('are present')
    const button = [...panel(root)!.querySelectorAll('button')].find((b) => b.textContent === 'Try again')
    expect(button).toBeTruthy()
  })

  test('none reports the check ran and found nothing — no retry offered', () => {
    const root = mounted({ credentialState: 'none' })
    expect(panel(root)?.textContent).toContain('No Content Credentials were found in this photograph.')
    expect(panel(root)?.querySelector('button')).toBeNull()
  })
})

describe('the metadata rows', () => {
  const rows = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>('.m-info-row')].map((row) => ({
      label: row.querySelector('dt')?.textContent,
      value: row.querySelector('dd')?.textContent,
    }))

  test('no exif means only File and Size rows', () => {
    const root = mounted()
    expect(rows(root).map((r) => r.label)).toEqual(['File', 'Size'])
  })

  test('every present field renders its own labelled row in order', () => {
    const root = mounted({
      caption: 'Owner caption',
      exif: {
        title: 'Embedded Title',
        camera: 'Canon EOS R5',
        lens: 'RF 24-70mm F2.8L',
        aperture: 'f/2.8',
        shutter: '1/250 s',
        iso: 400,
        focalLength: '35 mm',
        dateOriginal: '2026-11-22T14:05:09+05:30',
        description: 'A description',
        creator: 'Jane Doe',
        copyright: 'Copyright 2026',
        location: 'Bandra, Mumbai, India',
        keywords: ['alpha', 'beta'],
      },
    })
    expect(rows(root)).toEqual([
      { label: 'File', value: 'p1.jpg' },
      { label: 'Size', value: '800 × 600' },
      { label: 'Caption', value: 'Owner caption' },
      { label: 'Title', value: 'Embedded Title' },
      { label: 'Camera', value: 'Canon EOS R5' },
      { label: 'Lens', value: 'RF 24-70mm F2.8L' },
      { label: 'Exposure', value: 'f/2.8 · 1/250 s · ISO 400 · 35 mm' },
      { label: 'Captured', value: '22 November 2026, 14:05' },
      { label: 'Description', value: 'A description' },
      { label: 'Creator', value: 'Jane Doe' },
      { label: 'Copyright', value: 'Copyright 2026' },
      { label: 'Location', value: 'Bandra, Mumbai, India' },
      { label: 'Keywords', value: 'alpha, beta' },
    ])
  })

  test('absent fields produce no rows', () => {
    const root = mounted({ exif: { camera: 'NIKON D850', iso: 200 } })
    expect(rows(root).map((r) => r.label)).toEqual(['File', 'Size', 'Camera', 'Exposure'])
    expect(rows(root).find((r) => r.label === 'Exposure')?.value).toBe('ISO 200')
  })
})
