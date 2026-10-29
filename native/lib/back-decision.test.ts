import { describe, expect, test } from 'bun:test'
import { decideBack, type BackInput } from './back-decision'
import { initialOwnerNav, ownerNavReducer, type GalleryIdentity } from '../../packages/core/owner-navigation'

const gallery: GalleryIdentity = { kind: 'published', owner: 'ana', slug: 'coast' }

const base: BackInput = {
  globalViewOpen: false,
  viewerModalOpen: false,
  overlayDepth: 0,
  nav: initialOwnerNav(true),
}

const navAt = (...actions: Parameters<typeof ownerNavReducer>[1][]) =>
  actions.reduce(ownerNavReducer, initialOwnerNav(true))

describe('decideBack precedence', () => {
  test('global view wins over everything', () => {
    expect(decideBack({ ...base, globalViewOpen: true, viewerModalOpen: true, overlayDepth: 2 })).toBe('close-global')
  })

  test('a viewer modal beats the overlay stack and navigation', () => {
    expect(decideBack({ ...base, viewerModalOpen: true, overlayDepth: 1, nav: navAt({ type: 'open-gallery', gallery }) })).toBe('close-viewer-modal')
  })

  test('a redesign overlay beats screen navigation', () => {
    expect(decideBack({ ...base, overlayDepth: 1, nav: navAt({ type: 'open-gallery', gallery }) })).toBe('close-overlay')
  })

  test('the viewer screen returns to the library', () => {
    expect(decideBack({ ...base, nav: navAt({ type: 'open-gallery', gallery }) })).toBe('return-to-library')
  })

  test('a non-viewer screen above the library dispatches nav back', () => {
    expect(decideBack({ ...base, nav: navAt({ type: 'open-settings' }) })).toBe('nav-back')
    expect(decideBack({ ...base, nav: navAt({ type: 'open-visionary', from: 'library' }) })).toBe('nav-back')
  })

  test('on the library with nothing open the app exits', () => {
    expect(decideBack(base)).toBe('exit')
  })
})
