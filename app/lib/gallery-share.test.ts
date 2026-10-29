import { afterEach, describe, expect, test } from 'bun:test'
import { copyText, galleryShareText, shareGalleryOnWeb } from './gallery-share'

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')

afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
  if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
})

const payload = { title: 'Kashmir', caption: 'A winter album', url: 'https://manorama.xyz/quiet-owner/kashmir' }

const installNavigator = (value: unknown) => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value })
}

describe('gallery sharing', () => {
  test('Web Share receives only the title, caption and public URL', async () => {
    let shared: unknown
    installNavigator({ share: async (input: unknown) => { shared = input } })
    expect(await shareGalleryOnWeb(payload)).toBe('shared')
    expect(shared).toEqual({ title: 'Kashmir', text: 'Kashmir\nA winter album', url: payload.url })
    expect(galleryShareText({ ...payload, caption: '' })).toBe('Kashmir')
  })

  test('cancellation is quiet, while refusal asks for the fallback', async () => {
    installNavigator({ share: async () => { throw new Error('Share canceled by user') } })
    expect(await shareGalleryOnWeb(payload)).toBe('cancelled')
    installNavigator({ share: async () => { throw new Error('Permission denied') } })
    expect(await shareGalleryOnWeb(payload)).toBe('fallback')
    installNavigator({})
    expect(await shareGalleryOnWeb(payload)).toBe('fallback')
  })

  test('clipboard failure falls back to the DOM copy result', async () => {
    installNavigator({ clipboard: { writeText: async () => { throw new Error('denied') } } })
    const field = { style: {}, select() {}, remove() {}, value: '' }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => field,
        body: { appendChild: () => {} },
        execCommand: () => true,
      },
    })
    expect(await copyText(payload.url)).toBe(true)
    expect(field.value).toBe(payload.url)
  })
})
