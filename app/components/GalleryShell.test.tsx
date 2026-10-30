import { describe, expect, test } from 'bun:test'
import GalleryShell from './GalleryShell'

const settings = { title: 'Quiet light', caption: 'A cached gallery' }

const render = (status?: string) => String(GalleryShell({ settings, status, children: '' }))

describe('GalleryShell curtain status accessibility', () => {
  test('describes the curtain button with the available status', () => {
    const html = render('Available offline.')

    expect(html).toContain('class="curtain-content"')
    expect(html).toContain('class="curtain-mark"')
    expect(html).toContain('aria-describedby="gallery-curtain-status"')
    expect(html).toContain('id="gallery-curtain-status"')
    expect(html).toContain('role="status"')
    expect(html).toContain('Available offline.')
  })

  test('carries the fixed open hint and no kicker or date', () => {
    const html = render()

    expect(html).toContain('Tap to open')
    expect(html).not.toContain('curtain-kicker')
    expect(html).not.toContain('curtain-date')
  })

  test('does not point at a missing description when no status is present', () => {
    const html = render()

    expect(html).not.toContain('aria-describedby')
    expect(html).not.toContain('gallery-curtain-status')
  })
})
