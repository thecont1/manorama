import { describe, expect, test } from 'bun:test'
import { WebSettings } from './WebSettings'
import { paidGalleryLimitError } from '../lib/gallery-policy'

const props = (overrides: Partial<Parameters<typeof WebSettings>[0]> = {}): Parameters<typeof WebSettings>[0] => ({
  ownerName: 'Test Owner',
  ownerSlug: 'quiet-owner',
  ownerSlugDraft: 'quiet-owner',
  onOwnerSlugDraft: () => {},
  onSaveOwnerSlug: () => {},
  ownerSlugBusy: false,
  identities: [{ provider: 'dropbox', displayName: 'Test Owner' }],
  onUnlinkIdentity: () => {},
  tier: 'free',
  retainedCount: 2,
  retainedLimit: 3,
  upgradeHref: 'https://buy.stripe.com/example?client_reference_id=646f6964',
  theme: 'dark',
  onTheme: () => {},
  deleteConfirm: '',
  onDeleteConfirmChange: () => {},
  deleteBusy: false,
  onDeleteAccount: () => {},
  onBack: () => {},
  ...overrides,
})

describe('WebSettings', () => {
  test('keeps identity, plan, appearance and sign-out controls on one surface', () => {
    const html = String(WebSettings(props()))
    expect(html).toContain('data-screen="settings"')
    expect(html).toContain('Dropbox')
    expect(html).toContain('Unlink')
    expect(html).toContain('href="/auth/google?link=1"')
    expect(html).toContain('href="/auth/apple?link=1"')
    expect(html).toContain('href="https://buy.stripe.com/example?client_reference_id=646f6964"')
    expect(html).toContain('aria-label="Appearance"')
    expect(html).toContain('method="post"')
    expect(html).toContain('action="/auth/logout"')
    expect(html).not.toContain('encrypted vault')
  })

  test('protects the last identity and permits unlinking when another remains', () => {
    expect(String(WebSettings(props()))).toMatch(/<button[^>]*disabled=""[^>]*>Unlink<\/button>/)
    const html = String(WebSettings(props({ identities: [{ provider: 'dropbox' }, { provider: 'google' }] })))
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Unlink<\/button>/)
  })

  test('gates deletion on the exact URL name and reports address errors', () => {
    const disabled = String(WebSettings(props({ deleteConfirm: 'someone-else' })))
    expect(disabled).toMatch(/<button[^>]*disabled=""[^>]*>Delete my account<\/button>/)
    const ready = String(WebSettings(props({ deleteConfirm: 'quiet-owner', ownerSlugNote: 'That URL is taken' })))
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Delete my account<\/button>/)
    expect(ready).toContain('role="alert"')
    expect(ready).toContain('That URL is taken')
  })

  test('paid settings show the cap warning without a redundant upgrade action', () => {
    const html = String(WebSettings(props({ tier: 'pro', retainedCount: 99, retainedLimit: 99 })))
    expect(html).toContain('Visionary')
    expect(html).toContain('99 of 99')
    expect(html).toContain(paidGalleryLimitError().message)
    expect(html).not.toContain('buy.stripe.com')
  })
})
