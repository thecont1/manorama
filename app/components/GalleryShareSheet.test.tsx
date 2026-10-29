import { describe, expect, test } from 'bun:test'
import GalleryShareSheet from './GalleryShareSheet'

const payload = {
  title: 'Quiet & Light',
  caption: 'A “winter” album',
  url: 'https://manorama.xyz/quiet-owner/kashmir',
}

describe('GalleryShareSheet', () => {
  test('encodes only the public metadata and gallery URL into fallback links', () => {
    const html = String(GalleryShareSheet({ payload, onClose: () => {}, onCopy: async () => true }))
    expect(html).toContain('https://manorama.xyz/quiet-owner/kashmir')
    expect(html).toContain(`https://wa.me/?text=${encodeURIComponent('Quiet & Light https://manorama.xyz/quiet-owner/kashmir')}`)
    expect(html).toContain(`sms:?&body=${encodeURIComponent('Quiet & Light https://manorama.xyz/quiet-owner/kashmir')}`.replaceAll('&', '&amp;'))
    expect(html).toContain(`mailto:?subject=${encodeURIComponent('Quiet & Light')}&body=${encodeURIComponent('A “winter” album\n\nhttps://manorama.xyz/quiet-owner/kashmir')}`.replaceAll('&', '&amp;'))
    expect(html).toContain('Copy link')
    expect(html).toContain('WhatsApp')
    expect(html).toContain('Messages')
    expect(html).toContain('Email')
  })
})
