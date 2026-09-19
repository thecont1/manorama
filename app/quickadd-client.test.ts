import { describe, expect, test } from 'bun:test'
import { formatDuration } from './islands/VideoSlide'
import { createGallery, reconstructSourceUrl } from './quickadd'

/**
 * Client-side pieces that are pure enough to pin directly: the duration
 * chip's formatting, and the URL reconstruction that makes fragment-bearing
 * MEGA/iCloud links survive the trip through our own path.
 */

describe('formatDuration', () => {
  test('formats minutes and zero-padded seconds', () => {
    expect(formatDuration(97)).toBe('1:37')
    expect(formatDuration(5)).toBe('0:05')
    expect(formatDuration(60)).toBe('1:00')
    expect(formatDuration(3600)).toBe('60:00')
  })

  test('rounds fractional seconds', () => {
    expect(formatDuration(12.4)).toBe('0:12')
    expect(formatDuration(12.6)).toBe('0:13')
  })

  test('returns null when there is no usable duration', () => {
    // The chip then falls back to a bare VIDEO label.
    expect(formatDuration(undefined)).toBeNull()
    expect(formatDuration(0)).toBeNull()
    expect(formatDuration(-4)).toBeNull()
    expect(formatDuration(Number.NaN)).toBeNull()
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

const stubBrowser = (fetchImpl: () => Promise<Response>) => {
  const store = new Map<string, string>()
  const globals = globalThis as Record<string, unknown>
  const status = { textContent: '' }
  const navigated: string[] = []
  const previous = {
    location: globals.location,
    sessionStorage: globals.sessionStorage,
    localStorage: globals.localStorage,
    document: globals.document,
    fetch: globals.fetch,
  }
  globals.location = {
    href: 'https://manorama.xyz/https://mega.nz/folder/Ab#K',
    replace: (url: string) => { navigated.push(url) },
  }
  globals.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  }
  globals.localStorage = globals.sessionStorage
  globals.document = { querySelector: (selector: string) => (selector === '[data-quickadd-status]' ? status : null) }
  globals.fetch = fetchImpl
  return {
    status,
    navigated,
    store,
    restore: () => {
      globals.location = previous.location
      globals.sessionStorage = previous.sessionStorage
      globals.localStorage = previous.localStorage
      globals.document = previous.document
      globals.fetch = previous.fetch
    },
  }
}

describe('createGallery loop guard', () => {
  test('a failed attempt may be retried after the page reloads', async () => {
    // A guard may prevent redirect loops, but it must not make a transient
    // network/provider failure permanent for the rest of the tab session.
    const stub = stubBrowser(async () => new Response(JSON.stringify({ error: 'temporary failure' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    }))
    const root = { dataset: {} } as HTMLElement
    try {
      await createGallery('https://mega.nz/folder/Ab#K', root)
      expect(stub.store.has('manorama:quickadd-attempt')).toBe(false)
    } finally {
      stub.restore()
    }
  })
})

describe('createGallery limit handling', () => {
  const root = () => ({ dataset: {} }) as HTMLElement

  test('a pipeline gallery 201 redirects silently — no quota text, no retention notice', async () => {
    const stub = stubBrowser(async () => new Response(JSON.stringify({
      galleryUrl: '/test-owner/fresh-album',
      gallery: { slug: 'fresh-album', retention: 'pipeline' },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    try {
      await createGallery('https://mega.nz/folder/Ab#K', root())
      expect(stub.navigated).toEqual(['/test-owner/fresh-album'])
      expect(stub.status.textContent).toBe('')
    } finally {
      stub.restore()
    }
  })

  test('a GALLERY_LIMIT response sends the visitor to their dashboard', async () => {
    const stub = stubBrowser(async () => new Response(JSON.stringify({
      code: 'GALLERY_LIMIT',
      error: 'Paid accounts can retain up to 99 galleries. Delete a gallery before adding another.',
      dashboardUrl: '/test-owner',
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
    try {
      await createGallery('https://mega.nz/folder/Ab#K', root())
      expect(stub.navigated).toEqual(['/test-owner'])
      expect(stub.status.textContent).toBe('')
    } finally {
      stub.restore()
    }
  })

  test('a GALLERY_LIMIT response without a usable target falls back to a generic note', async () => {
    const stub = stubBrowser(async () => new Response(JSON.stringify({
      code: 'GALLERY_LIMIT',
      error: 'Paid accounts can retain up to 99 galleries. Delete a gallery before adding another.',
      dashboardUrl: 'https://evil.example.com/steal',
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
    try {
      await createGallery('https://mega.nz/folder/Ab#K', root())
      expect(stub.navigated).toEqual([])
      expect(stub.status.textContent).toBe('Open your dashboard to continue.')
    } finally {
      stub.restore()
    }
  })
})

describe('reconstructSourceUrl', () => {
  test('carries the fragment the server never saw — the whole point', () => {
    // A MEGA key lives after '#'; browsers never transmit it.
    expect(reconstructSourceUrl({
      pathname: '/https://mega.nz/folder/AbCdEf12',
      search: '',
      hash: '#a2V5LXNlY3JldA',
    })).toBe('https://mega.nz/folder/AbCdEf12#a2V5LXNlY3JldA')
  })

  test('keeps the query string alongside the fragment', () => {
    expect(reconstructSourceUrl({
      pathname: '/https://www.dropbox.com/scl/fo/abc/xyz',
      search: '?rlkey=secret&dl=0',
      hash: '',
    })).toBe('https://www.dropbox.com/scl/fo/abc/xyz?rlkey=secret&dl=0')
  })

  test('restores the collapsed scheme separator', () => {
    expect(reconstructSourceUrl({ pathname: '/https:/mega.nz/folder/Ab', search: '', hash: '#k' }))
      .toBe('https://mega.nz/folder/Ab#k')
  })

  test('prepends https for a scheme-less paste', () => {
    expect(reconstructSourceUrl({ pathname: '/mega.nz/folder/Ab', search: '', hash: '#k' }))
      .toBe('https://mega.nz/folder/Ab#k')
  })

  test('decodes percent-encoding and survives a malformed escape', () => {
    expect(reconstructSourceUrl({ pathname: '/https%3A%2F%2Fmega.nz%2Ffolder%2FAb', search: '', hash: '' }))
      .toBe('https://mega.nz/folder/Ab')
    expect(() => reconstructSourceUrl({ pathname: '/https://mega.nz/folder/100%', search: '', hash: '' })).not.toThrow()
  })

  test('an iCloud album token in the fragment round-trips intact', () => {
    expect(reconstructSourceUrl({
      pathname: '/https://www.icloud.com/sharedalbum/',
      search: '',
      hash: '#B0z5qAGN1JIFd3y',
    })).toBe('https://www.icloud.com/sharedalbum/#B0z5qAGN1JIFd3y')
  })
})
