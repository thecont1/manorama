import { describe, expect, test } from 'bun:test'
import { GalleryEditSheet } from './GalleryEditSheet'

const render = (overrides: Partial<Parameters<typeof GalleryEditSheet>[0]> = {}) => String(GalleryEditSheet({
  open: true,
  field: 'name',
  value: 'Field notes',
  busy: false,
  onValueChange: () => {},
  onSubmit: () => {},
  onClose: () => {},
  ...overrides,
}))

describe('GalleryEditSheet', () => {
  test('edits a gallery name in the shared half sheet', () => {
    const html = render()
    expect(html).toContain('Edit name')
    expect(html).toContain('aria-label="Name"')
    expect(html).toContain('value="Field notes"')
    expect(html).toContain('form="m-edit-gallery-form"')
    expect(html).toContain('Save')
  })

  test('uses a multiline caption field', () => {
    const html = render({ field: 'caption', value: 'A quiet line' })
    expect(html).toContain('Edit caption')
    expect(html).toContain('<textarea')
    expect(html).toContain('aria-label="Caption"')
    expect(html).toContain('A quiet line')
  })

  test('uses a URL-safe address field with no autocorrection', () => {
    const html = render({ field: 'address', value: 'field-notes' })
    expect(html).toContain('Edit address')
    expect(html).toContain('autoCapitalize="none"')
    expect(html).toContain('autoCorrect="off"')
    expect(html).toContain('value="field-notes"')
  })

  test('busy and validation states disable saving without hiding the reason', () => {
    expect(render({ busy: true, note: 'The change could not be saved' })).toContain('Saving…')
    expect(render({ busy: true, note: 'The change could not be saved' })).toContain('role="alert"')
    expect(render({ value: '' })).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/)
  })

  test('no selected field means no editor', () => {
    expect(render({ field: null })).toBe('null')
  })
})
