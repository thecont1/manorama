import { describe, expect, test } from 'bun:test'
import {
  isSlowConnection,
  shouldAutoplayVideo,
  videoAudibleFor,
  videoMountsFor,
  VIDEO_MOUNT_RADIUS,
} from './video-playback'

/**
 * Playback policy, as pure functions. The lifecycle lives in the island,
 * but every *decision* it makes is here so it can be tested without a DOM.
 *
 * The contract, in the user's words: a video must already be running when
 * it is loaded rather than waiting to become the active image; it must
 * occupy exactly its still image's box; and on a poor connection it must
 * stay a still image instead of playing.
 */

describe('detecting a connection too poor for video', () => {
  test('an absent Network Information API is treated as good', () => {
    // Safari and Firefox ship no navigator.connection. Refusing to play
    // there would disable video for most desktop visitors.
    expect(isSlowConnection(undefined)).toBe(false)
    expect(isSlowConnection(null)).toBe(false)
    expect(isSlowConnection({})).toBe(false)
  })

  test('Data Saver is an explicit user request for stills', () => {
    expect(isSlowConnection({ saveData: true })).toBe(true)
    expect(isSlowConnection({ saveData: true, effectiveType: '4g' })).toBe(true)
  })

  test('2g-class effective types are poor', () => {
    expect(isSlowConnection({ effectiveType: 'slow-2g' })).toBe(true)
    expect(isSlowConnection({ effectiveType: '2g' })).toBe(true)
  })

  test('3g is poor for video even though it is fine for stills', () => {
    expect(isSlowConnection({ effectiveType: '3g' })).toBe(true)
  })

  test('4g and better are good', () => {
    expect(isSlowConnection({ effectiveType: '4g' })).toBe(false)
    expect(isSlowConnection({ effectiveType: '5g' })).toBe(false)
  })

  test('a low measured downlink is poor regardless of the label', () => {
    // Carriers report '4g' on badly congested links; the measurement wins.
    expect(isSlowConnection({ effectiveType: '4g', downlink: 0.4 })).toBe(true)
    expect(isSlowConnection({ effectiveType: '4g', downlink: 5 })).toBe(false)
  })

  test('a zero or non-finite downlink is not mistaken for a slow link', () => {
    // 0 is the "unknown" reading; NaN comes from odd polyfills.
    expect(isSlowConnection({ effectiveType: '4g', downlink: 0 })).toBe(false)
    expect(isSlowConnection({ effectiveType: '4g', downlink: Number.NaN })).toBe(false)
  })

  test('unknown labels are not guessed at', () => {
    expect(isSlowConnection({ effectiveType: 'wifi' })).toBe(false)
    expect(isSlowConnection({ effectiveType: '' })).toBe(false)
  })

  test('the effective type is matched case-insensitively', () => {
    expect(isSlowConnection({ effectiveType: 'SLOW-2G' })).toBe(true)
  })
})

describe('deciding whether a loaded video may play', () => {
  test('a mounted video plays without waiting to become active', () => {
    // The whole point: loading is the trigger, not activation.
    expect(shouldAutoplayVideo({ isActive: false })).toBe(true)
    expect(shouldAutoplayVideo({ isActive: true })).toBe(true)
  })

  test('reduced motion keeps the poster and an explicit Play control', () => {
    expect(shouldAutoplayVideo({ isActive: true, prefersReducedMotion: true })).toBe(false)
  })

  test('a poor connection keeps it a still image', () => {
    expect(shouldAutoplayVideo({ isActive: true, connection: { effectiveType: '2g' } })).toBe(false)
    expect(shouldAutoplayVideo({ isActive: true, connection: { saveData: true } })).toBe(false)
  })

  test('a hidden tab does not start decoding', () => {
    expect(shouldAutoplayVideo({ isActive: true, documentHidden: true })).toBe(false)
  })

  test('defaults are permissive so a bare call plays', () => {
    expect(shouldAutoplayVideo({})).toBe(true)
  })
})

describe('which frames own a video element', () => {
  test('the active frame always mounts one', () => {
    expect(videoMountsFor({ imageIndex: 4, index: 4, frameActive: true })).toBe(true)
  })

  test('neighbours mount too, so arriving finds a running video', () => {
    // This is what makes "already running when loaded" observable: the
    // next slide is playing before the visitor steps onto it.
    expect(videoMountsFor({ imageIndex: 5, index: 4, frameActive: true })).toBe(true)
    expect(videoMountsFor({ imageIndex: 3, index: 4, frameActive: true })).toBe(true)
  })

  test('distant frames stay posters, whatever the window says', () => {
    // Bounded on purpose: one <video> per retained strip frame would
    // fetch metadata for the whole gallery.
    expect(videoMountsFor({ imageIndex: 40, index: 4, frameActive: true })).toBe(false)
  })

  test('the radius is the single source of truth for the bound', () => {
    const edge = VIDEO_MOUNT_RADIUS
    expect(videoMountsFor({ imageIndex: edge, index: 0, frameActive: true })).toBe(true)
    expect(videoMountsFor({ imageIndex: edge + 1, index: 0, frameActive: true })).toBe(false)
  })

  test('an inactive frame never mounts, even when adjacent', () => {
    expect(videoMountsFor({ imageIndex: 5, index: 4, frameActive: false })).toBe(false)
  })

  test('nothing mounts before the curtain lifts or while a modal is up', () => {
    expect(videoMountsFor({ imageIndex: 4, index: 4, frameActive: true, galleryEntered: false })).toBe(false)
    expect(videoMountsFor({ imageIndex: 4, index: 4, frameActive: true, blocked: true })).toBe(false)
  })

  test('a poor connection mounts no video at all', () => {
    // Stills only: do not even fetch metadata for a clip we will not play.
    expect(videoMountsFor({ imageIndex: 4, index: 4, frameActive: true, connection: { saveData: true } })).toBe(false)
  })
})

describe('which video may be heard', () => {
  test('only the active slide is audible', () => {
    // Neighbours play muted; otherwise several clips overlap.
    expect(videoAudibleFor({ isActive: true, soundOn: true })).toBe(true)
    expect(videoAudibleFor({ isActive: false, soundOn: true })).toBe(false)
  })

  test('sound off means silent everywhere', () => {
    expect(videoAudibleFor({ isActive: true, soundOn: false })).toBe(false)
    expect(videoAudibleFor({ isActive: false, soundOn: false })).toBe(false)
  })
})
