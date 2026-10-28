import { describe, expect, test } from 'bun:test'
import {
  canGoBack,
  initialOwnerNav,
  ownerNavReducer,
  sameGallery,
  type GalleryIdentity,
  type OwnerNavState,
} from './owner-navigation'

const pub: GalleryIdentity = { kind: 'published', owner: 'ana', slug: 'coast' }
const pub2: GalleryIdentity = { kind: 'published', owner: 'ana', slug: 'cities' }
const local: GalleryIdentity = { kind: 'local', galleryId: 'g-1' }

const reduce = (state: OwnerNavState, ...actions: Parameters<typeof ownerNavReducer>[1][]) =>
  actions.reduce(ownerNavReducer, state)

const viewerState = (gallery = pub): OwnerNavState =>
  reduce(initialOwnerNav(true), { type: 'open-gallery', gallery })

describe('owner-navigation reducer', () => {
  test('initial state follows sign-in', () => {
    expect(initialOwnerNav(true).screen.kind).toBe('library')
    expect(initialOwnerNav(false).screen.kind).toBe('welcome')
    expect(initialOwnerNav(true).viewer).toBeNull()
  })

  test('sameGallery compares published and local identities', () => {
    expect(sameGallery(pub, { ...pub })).toBe(true)
    expect(sameGallery(pub, pub2)).toBe(false)
    expect(sameGallery(local, { ...local })).toBe(true)
    expect(sameGallery(pub, local)).toBe(false)
  })

  test('canGoBack is false only on library and welcome', () => {
    expect(canGoBack(initialOwnerNav(true))).toBe(false)
    expect(canGoBack(initialOwnerNav(false))).toBe(false)
    expect(canGoBack(viewerState())).toBe(true)
  })

  test('open-gallery shows the viewer and retains the session', () => {
    const state = viewerState()
    expect(state.screen).toEqual({ kind: 'viewer', gallery: pub, photoId: undefined })
    expect(state.viewer).toEqual({ gallery: pub, photoId: undefined })
  })

  test('open-gallery replaces any previous session', () => {
    const state = reduce(viewerState(pub), { type: 'open-gallery', gallery: pub2, photoId: 'p9' })
    expect(state.viewer).toEqual({ gallery: pub2, photoId: 'p9' })
    expect(state.screen.kind).toBe('viewer')
  })

  test('open-details from viewer keeps the retained session object', () => {
    const from = viewerState()
    const state = reduce(from, { type: 'open-details', gallery: pub, from: 'viewer' })
    expect(state.screen).toEqual({ kind: 'details', gallery: pub, from: 'viewer' })
    expect(state.viewer).toBe(from.viewer)
  })

  test('open-details from library or for another gallery clears the session', () => {
    const withViewer = viewerState()
    expect(reduce(withViewer, { type: 'open-details', gallery: pub, from: 'library' }).viewer).toBeNull()
    expect(reduce(withViewer, { type: 'open-details', gallery: pub2, from: 'viewer' }).viewer).toBeNull()
  })

  test('open-reorder from a viewer-retained details keeps the session and records detailsFrom', () => {
    const state = reduce(
      viewerState(),
      { type: 'open-details', gallery: pub, from: 'viewer' },
      { type: 'open-reorder', gallery: pub, from: 'details' },
    )
    expect(state.screen).toEqual({ kind: 'reorder', gallery: pub, from: 'details', detailsFrom: 'viewer' })
    expect(state.viewer).toEqual({ gallery: pub })
  })

  test('open-reorder for another gallery or from library clears the session', () => {
    const details = reduce(viewerState(), { type: 'open-details', gallery: pub, from: 'viewer' })
    const other = reduce(details, { type: 'open-reorder', gallery: pub2, from: 'details' })
    expect(other.viewer).toBeNull()
    expect(other.screen).toEqual({ kind: 'reorder', gallery: pub2, from: 'details', detailsFrom: 'viewer' })
    const fromLibrary = reduce(initialOwnerNav(true), { type: 'open-reorder', gallery: pub, from: 'library' })
    expect(fromLibrary.screen).toEqual({ kind: 'reorder', gallery: pub, from: 'library', detailsFrom: undefined })
    expect(fromLibrary.viewer).toBeNull()
  })

  test('viewer→details→reorder→back×3 lands on library, viewer retained until the last back', () => {
    let state = viewerState()
    state = reduce(state, { type: 'open-details', gallery: pub, from: 'viewer' })
    state = reduce(state, { type: 'open-reorder', gallery: pub, from: 'details' })
    state = reduce(state, { type: 'back' })
    expect(state.screen).toEqual({ kind: 'details', gallery: pub, from: 'viewer' })
    expect(state.viewer).toEqual({ gallery: pub })
    state = reduce(state, { type: 'back' })
    expect(state.screen).toEqual({ kind: 'viewer', gallery: pub, photoId: undefined })
    expect(state.viewer).toEqual({ gallery: pub })
    state = reduce(state, { type: 'back' })
    expect(state.screen).toEqual({ kind: 'library' })
    expect(state.viewer).toBeNull()
    expect(canGoBack(state)).toBe(false)
  })

  test('reorder from library backs to library', () => {
    const state = reduce(initialOwnerNav(true), { type: 'open-reorder', gallery: pub, from: 'library' }, { type: 'back' })
    expect(state.screen).toEqual({ kind: 'library' })
  })

  test('details from library backs to library', () => {
    const state = reduce(
      initialOwnerNav(true),
      { type: 'open-details', gallery: pub, from: 'library' },
      { type: 'back' },
    )
    expect(state.screen).toEqual({ kind: 'library' })
  })

  test('settings and visionary back to where they came from', () => {
    const settings = reduce(initialOwnerNav(true), { type: 'open-settings' })
    expect(reduce(settings, { type: 'back' }).screen).toEqual({ kind: 'library' })
    const fromLibrary = reduce(initialOwnerNav(true), { type: 'open-visionary', from: 'library' })
    expect(reduce(fromLibrary, { type: 'back' }).screen).toEqual({ kind: 'library' })
    const fromSettings = reduce(settings, { type: 'open-visionary', from: 'settings' })
    expect(reduce(fromSettings, { type: 'back' }).screen).toEqual({ kind: 'settings' })
  })

  test('privacy returns to its origin', () => {
    const fromWelcome = reduce(initialOwnerNav(false), { type: 'open-privacy', from: 'welcome' })
    expect(reduce(fromWelcome, { type: 'back' }).screen).toEqual({ kind: 'welcome' })
    const fromSettings = reduce(
      initialOwnerNav(true),
      { type: 'open-settings' },
      { type: 'open-privacy', from: 'settings' },
    )
    expect(reduce(fromSettings, { type: 'back' }).screen).toEqual({ kind: 'settings' })
    const fromVisionary = reduce(
      initialOwnerNav(true),
      { type: 'open-visionary', from: 'library' },
      { type: 'open-privacy', from: 'visionary' },
    )
    expect(reduce(fromVisionary, { type: 'back' }).screen).toEqual({ kind: 'visionary', from: 'library' })
  })

  test('signed-out lands on welcome with no session from anywhere', () => {
    const deep = reduce(
      viewerState(),
      { type: 'open-details', gallery: pub, from: 'viewer' },
      { type: 'open-reorder', gallery: pub, from: 'details' },
    )
    const state = reduce(deep, { type: 'signed-out' })
    expect(state).toEqual({ screen: { kind: 'welcome' }, viewer: null })
  })

  test('back on library or welcome is a no-op returning the same state', () => {
    const lib = initialOwnerNav(true)
    const wel = initialOwnerNav(false)
    expect(reduce(lib, { type: 'back' })).toBe(lib)
    expect(reduce(wel, { type: 'back' })).toBe(wel)
  })

  test('signed-in returns to the library', () => {
    const state = reduce(initialOwnerNav(false), { type: 'signed-in' })
    expect(state.screen).toEqual({ kind: 'library' })
    expect(state.viewer).toBeNull()
  })
})
