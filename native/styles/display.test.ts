import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const displayCss = readFileSync(new URL('./display.css', import.meta.url), 'utf8')

describe('native display colour foundation', () => {
  test('keeps an sRGB fallback and gates P3 chrome behind color-gamut', () => {
    expect(displayCss).toContain('--native-display-gamut: srgb')
    expect(displayCss).toContain('@media (color-gamut: p3)')
    expect(displayCss).toContain('--native-display-gamut: p3')
    expect(displayCss).toContain('color(display-p3')
    expect(displayCss).not.toMatch(/(?:src|srcset|filter|object-fit)\s*:/)
  })

  test('does not put image URLs or metadata on the display styling path', () => {
    expect(displayCss).not.toMatch(/(?:<img|image\.src|variants|exif|c2pa|reencode|transcod)/i)
  })
})
