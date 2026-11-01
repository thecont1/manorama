import { describe, expect, test } from 'bun:test'
import { formatMediaCount, mediaCountOf, summaryMediaCount } from './imagesource'

describe('mediaCountOf', () => {
  test('counts only type:"video" entries, treating a bare type as a still', () => {
    expect(mediaCountOf([{}, {}, { type: 'video' }, { type: 'image' }])).toEqual({ stills: 3, videos: 1 })
    expect(mediaCountOf([])).toEqual({ stills: 0, videos: 0 })
  })
})

describe('formatMediaCount', () => {
  test('stills only', () => {
    expect(formatMediaCount({ stills: 24, videos: 0 })).toBe('24 photographs')
    expect(formatMediaCount({ stills: 1, videos: 0 })).toBe('1 photograph')
  })
  test('videos only', () => {
    expect(formatMediaCount({ stills: 0, videos: 2 })).toBe('2 videos')
    expect(formatMediaCount({ stills: 0, videos: 1 })).toBe('1 video')
  })
  test('stills and videos join with the middle dot', () => {
    expect(formatMediaCount({ stills: 24, videos: 1 })).toBe('24 photographs · 1 video')
  })
  test('hidden trails the visible counts and only appears when nonzero', () => {
    expect(formatMediaCount({ stills: 24, videos: 1, hidden: 2 })).toBe('24 photographs · 1 video · 2 hidden')
    expect(formatMediaCount({ stills: 3, videos: 0, hidden: 0 })).toBe('3 photographs')
  })
  test('an empty gallery reads 0 photographs, plus any hidden count', () => {
    expect(formatMediaCount({ stills: 0, videos: 0 })).toBe('0 photographs')
    expect(formatMediaCount({ stills: 0, videos: 0, hidden: 3 })).toBe('0 photographs · 3 hidden')
  })
})

describe('summaryMediaCount', () => {
  test('passes a present mediaCount through with hidden defaulted', () => {
    expect(summaryMediaCount({ imageCount: 30, mediaCount: { stills: 24, videos: 1, hidden: 5 } })).toEqual({ stills: 24, videos: 1, hidden: 5 })
    expect(summaryMediaCount({ imageCount: 30, mediaCount: { stills: 24, videos: 1 } })).toEqual({ stills: 24, videos: 1, hidden: 0 })
  })
  test('older payloads without mediaCount degrade to all-stills', () => {
    expect(summaryMediaCount({ imageCount: 25 })).toEqual({ stills: 25, videos: 0, hidden: 0 })
  })
})
