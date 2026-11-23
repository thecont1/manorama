/**
 * SSR injection probes: every attacker-controlled string that reaches the
 * gallery page — title, caption, alt, EXIF-ish caption text — is written by
 * a gallery owner, and the island's props are serialised into the document by
 * honox. The question is whether that serialisation escapes a payload that
 * closes the script element.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import viewerPage from '../../app/routes/[owner]/[slug]'
import quickAddPage from '../../app/routes/[...src]'
import renderer from '../../app/routes/_renderer'
import { resetUserStore } from '../../app/lib/user-repository'
import { createGallery, resetGalleryStore } from '../../app/lib/gallery-repository'
import { seedTestUser, TEST_OWNER, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'

const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}
const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

const PAYLOAD = `</script><img src=x onerror=alert(1)><script>alert(2)</script>`
const ATTR = `" onerror="alert(3)" x="`

// A payload that escaped serialisation lands as a live element OUTSIDE the
// script blocks, so script-content inspection alone cannot see it. Strip the
// script elements (they cannot execute anyway inside innerHTML), parse what
// remains as markup, and ask the DOM whether any element carries a handler.
const injectedElements = (html: string): number => {
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  const window = new Window({ settings: { disableJavaScriptFileLoading: true } })
  window.document.body.innerHTML = markup
  return window.document.querySelectorAll('[onerror],img[src="x"]').length
}

const app = () => {
  const hono = new Hono()
  hono.use('*', honoxContext)
  hono.use('*', renderer as unknown as never)
  const get = hono.get.bind(hono) as (p: string, ...h: unknown[]) => void
  get('/:owner/:slug', ...(viewerPage as unknown as unknown[]))
  get('/:src{.+}', ...(quickAddPage as unknown as unknown[]))
  return hono
}

let ownerSlug = ''

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  const owner = await seedTestUser()
  ownerSlug = owner.ownerSlug
  await createGallery(TEST_OWNER.accountId, {
    slug: 'injected',
    title: PAYLOAD,
    caption: ATTR,
    date: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    images: [{
      id: 'i1', filename: 'i1.jpg', src: '/x.jpg', width: 100, height: 100,
      alt: PAYLOAD, c2pa: false, placeholder: '',
      caption: PAYLOAD,
    }],
  })
})

describe('gallery page serialisation', () => {
  test('no attacker string terminates the document early', async () => {
    const response = await app().request(`/${ownerSlug}/injected`, {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    console.log('---HEAD---')
    console.log(html.slice(0, 1800))
    console.log('---END---')
    // Every script element must be well formed: strip them and no stray
    // "<img src=x onerror" may survive at top level as markup we did not emit.
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) {
      // A payload that closed the element early leaves its tail inside the
      // next "script" match; the tell is markup outside the quoting context.
      expect(script.includes('onerror=alert(1)')).toBe(false)
    }
    // And nothing may land as a live element anywhere in the document —
    // the escaped text still reads "onerror=alert(1)", but only a real
    // <img> would carry it as an attribute.
    expect(injectedElements(html)).toBe(0)
    // The document-level title is escaped, not parsed.
    expect(html).toContain('<title>')
    // The curtain title uses dangerouslySetInnerHTML with an escaped value.
    expect(html).toMatch(/<h2 class="curtain-title"[^>]*>&lt;\/script&gt;/)
  })
})

describe('quick-add page', () => {
  test('the provider label is a constant, and the path never reaches markup', async () => {
    const response = await app().request(`/https://www.dropbox.com/scl/fo/${encodeURIComponent(PAYLOAD)}?rlkey=k`, {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('data-quickadd')
    for (const script of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []) {
      expect(script.includes('onerror=alert(1)')).toBe(false)
    }
    expect(injectedElements(html)).toBe(0)
  })
})
