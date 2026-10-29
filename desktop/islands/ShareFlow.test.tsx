import { describe, expect, test } from 'bun:test'
import ShareFlow from './ShareFlow'
import type { LocalCatalogue, LocalGalleryRecord } from '../lib/catalogue'

const record: LocalGalleryRecord = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  title: 'Field notes',
  rootPath: '/Users/private/Field notes',
  sourceKind: 'folder',
  itemCount: 1,
  items: [{ id: 'one', name: 'one.jpg', path: '/Users/private/Field notes/one.jpg' }],
  addedAt: '2026-10-28T00:00:00.000Z',
  lastSeenAt: '2026-10-28T00:00:00.000Z',
}
const catalogue: LocalCatalogue = { version: 1, deviceId: '11111111-2222-3333-4444-555555555555', deviceLabel: 'This Mac', galleries: [record] }
const render = (presentation: 'inline' | 'sheet') => String(ShareFlow({
  record,
  catalogue,
  apiBase: 'https://manorama.xyz',
  session: { token: 'session-token', ownerSlug: 'owner' },
  onClose: () => {},
  presentation,
}))

describe('desktop ShareFlow presentation', () => {
  test('the shared-sheet presentation leaves title and dismissal to Sheet', () => {
    const html = render('sheet')
    expect(html).toContain('desktop-share--sheet')
    expect(html).not.toContain('desktop-share-header')
    expect(html).toContain('nothing uploads until you confirm')
    expect(html).not.toContain(record.rootPath)
  })

  test('the legacy inline host retains its close action and confirmation copy', () => {
    const html = render('inline')
    expect(html).toContain('desktop-share-header')
    expect(html).toContain('Close')
    expect(html).toContain('nothing uploads until you confirm')
  })
})
