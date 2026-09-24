import { describe, expect, test } from 'bun:test'
import { galleryStatusMessage } from './GalleryList'

describe('galleryStatusMessage', () => {
  test('keeps offline and loading states calm and actionable', () => {
    expect(galleryStatusMessage('loading')).toBe('Opening gallery…')
    expect(galleryStatusMessage('offline')).toBe(
      'Available offline. Full resolution returns with your connection.',
    )
  })

  test('does not describe a failed open as offline success', () => {
    expect(galleryStatusMessage('error')).toBe('That gallery could not be opened.')
  })
})
