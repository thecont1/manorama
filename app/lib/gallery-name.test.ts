import { describe, expect, test } from 'bun:test'
import { randomGalleryName } from './gallery-name'

describe('randomGalleryName', () => {
  test('returns three lowercase words joined by hyphens', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(randomGalleryName()).toMatch(/^[a-z]+(-[a-z]+){2}$/)
    }
  })

  test('never repeats a word inside one name', () => {
    for (let i = 0; i < 200; i += 1) {
      const parts = randomGalleryName().split('-')
      expect(new Set(parts).size).toBe(3)
    }
  })

  test('produces different names across calls', () => {
    const names = new Set(Array.from({ length: 50 }, () => randomGalleryName()))
    expect(names.size).toBeGreaterThan(45)
  })
})
