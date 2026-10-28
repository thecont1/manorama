import { describe, expect, test } from 'bun:test'
import {
  AUTH_PROVIDERS,
  countRetainedGalleries,
  FREE_RETAINED_LIMIT,
  FREE_RETENTION_DISCLOSURE,
  normalizeSlug,
  nextGalleryRetentionFor,
  PAID_RETAINED_CAP_MESSAGE,
  PAID_RETAINED_LIMIT,
  PIPELINE_LIFETIME_MS,
  PIPELINE_LOCK_MESSAGE,
  retainedGalleryLimit,
  tierTransitionImpact,
  unlinkIdentityPolicy,
  validateGalleryUrlSlug,
  validateOwnerUrlSlug,
  type LinkedIdentity,
  type UnlinkResult,
} from './account'

const identity = (provider: LinkedIdentity['provider'], index = 0): LinkedIdentity => ({
  provider,
  subject: `subject-${provider}-${index}`,
  accountId: 'acct_1',
})

const identities = (providers: readonly LinkedIdentity['provider'][]): LinkedIdentity[] =>
  providers.map((provider, index) => identity(provider, index))

describe('unlinkIdentityPolicy', () => {
  test('refuses to remove the last remaining provider, for every provider', () => {
    for (const provider of AUTH_PROVIDERS) {
      const linked = [identity(provider)]
      const result = unlinkIdentityPolicy(linked, provider)
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({ reason: 'last-identity', message: 'The last sign-in method cannot be removed' })
    }
  })

  test('last-identity refusal leaves the identity list untouched', () => {
    const linked = [identity('apple')]
    const result = unlinkIdentityPolicy(linked, 'apple')
    expect(result.ok).toBe(false)
    expect(linked).toHaveLength(1)
    expect(linked[0].provider).toBe('apple')
  })

  test('removes one provider from several, preserving order of the rest', () => {
    const linked = identities(['dropbox', 'google', 'apple'])
    const result = unlinkIdentityPolicy(linked, 'google')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.remaining.map((item) => item.provider)).toEqual(['dropbox', 'apple'])
    expect(result.remaining[0].subject).toBe('subject-dropbox-0')
    expect(result.remaining[1].subject).toBe('subject-apple-2')
  })

  test('a duplicate unlink of an already-removed provider reports unknown', () => {
    const linked = identities(['dropbox', 'google'])
    const first = unlinkIdentityPolicy(linked, 'dropbox')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = unlinkIdentityPolicy(first.remaining, 'dropbox')
    expect(second.ok).toBe(false)
    expect(second).toMatchObject({ reason: 'unknown', message: 'That sign-in method was not found' })
  })

  test('an unknown provider that is not linked reports unknown', () => {
    const linked = identities(['dropbox', 'google'])
    const result = unlinkIdentityPolicy(linked, 'apple')
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'unknown' })
  })

  test('an unsupported provider string is rejected before any identity check', () => {
    const linked = identities(['dropbox'])
    const result = unlinkIdentityPolicy(linked, 'github')
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'unsupported-provider' })
  })

  test('an empty identity list reports unknown, not last-identity', () => {
    const result = unlinkIdentityPolicy([], 'dropbox')
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'unknown' })
  })

  test('removing a provider from a two-identity account is allowed (server COUNT>1 rule)', () => {
    const linked = identities(['dropbox', 'apple'])
    const result = unlinkIdentityPolicy(linked, 'dropbox')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.remaining).toHaveLength(1)
    expect(result.remaining[0].provider).toBe('apple')
  })
})

describe('retained-gallery caps', () => {
  test('limits mirror the server copy exactly', () => {
    expect(FREE_RETAINED_LIMIT).toBe(3)
    expect(PAID_RETAINED_LIMIT).toBe(99)
    expect(PIPELINE_LIFETIME_MS).toBe(30 * 24 * 60 * 60 * 1000)
    expect(PIPELINE_LOCK_MESSAGE).toContain('temporary gallery')
    expect(FREE_RETENTION_DISCLOSURE).toContain('3 editable galleries')
    expect(PAID_RETAINED_CAP_MESSAGE).toContain('99 galleries')
  })

  test('retainedGalleryLimit is tier-aware', () => {
    expect(retainedGalleryLimit('free')).toBe(3)
    expect(retainedGalleryLimit('pro')).toBe(99)
  })

  test('free retains up to the cap, then new galleries become pipeline', () => {
    for (const retained of [0, 1, 2]) {
      expect(nextGalleryRetentionFor('free', retained)).toEqual({ allowed: true, retention: 'retained' })
    }
    for (const retained of [3, 4, 10, 99, 100]) {
      expect(nextGalleryRetentionFor('free', retained)).toEqual({ allowed: true, retention: 'pipeline' })
    }
  })

  test('paid retains up to the cap and refuses beyond it', () => {
    for (const retained of [0, 1, 98]) {
      expect(nextGalleryRetentionFor('pro', retained)).toEqual({ allowed: true, retention: 'retained' })
    }
    for (const retained of [99, 100, 200]) {
      const result = nextGalleryRetentionFor('pro', retained)
      expect(result.allowed).toBe(false)
      expect(result).toMatchObject({ reason: 'paid-cap', message: PAID_RETAINED_CAP_MESSAGE })
    }
  })

  test('canRetainAnotherGallery agrees with nextGalleryRetentionFor', () => {
    expect(nextGalleryRetentionFor('free', 2).allowed).toBe(true)
    expect(nextGalleryRetentionFor('free', 3).allowed).toBe(true)
    expect(nextGalleryRetentionFor('pro', 98).allowed).toBe(true)
    expect(nextGalleryRetentionFor('pro', 99).allowed).toBe(false)
  })

  test('countRetainedGalleries treats missing retention as retained', () => {
    expect(countRetainedGalleries([])).toBe(0)
    expect(countRetainedGalleries([{}, { retention: 'retained' }, { retention: 'pipeline' }])).toBe(2)
    expect(countRetainedGalleries([{ retention: 'pipeline' }, { retention: 'pipeline' }])).toBe(0)
  })
})

describe('URL slug validation', () => {
  test('valid owner slugs pass', () => {
    for (const slug of ['abc', 'mahesh-v', 'mahesh-v2', 'a-b-c', 'x'.repeat(48)]) {
      expect(validateOwnerUrlSlug(slug)).toEqual({ ok: true })
    }
  })

  test('owner slugs reject spaces and underscore separators after normalization', () => {
    for (const slug of ['a b', 'a_b', 'a b-c']) {
      expect(validateOwnerUrlSlug(slug)).toMatchObject({ ok: false, reason: 'format' })
    }
  })

  test('owner slugs accept uppercase input because normalization lowercases it', () => {
    for (const slug of ['ABC', 'Mahesh', 'A-B']) {
      expect(validateOwnerUrlSlug(slug)).toEqual({ ok: true })
    }
  })

  test('owner slugs reject double or edge hyphens', () => {
    for (const slug of ['a--b', '-ab', 'ab-', 'a--', '--ab']) {
      expect(validateOwnerUrlSlug(slug)).toMatchObject({ ok: false, reason: 'format' })
    }
  })

  test('owner slugs reject out-of-range length', () => {
    expect(validateOwnerUrlSlug('ab')).toMatchObject({ ok: false, reason: 'length' })
    expect(validateOwnerUrlSlug('x'.repeat(49))).toMatchObject({ ok: false, reason: 'length' })
    expect(validateOwnerUrlSlug('')).toMatchObject({ ok: false, reason: 'empty' })
    expect(validateOwnerUrlSlug('   ')).toMatchObject({ ok: false, reason: 'empty' })
  })

  test('owner slug messages carry the server copy', () => {
    for (const slug of ['ab', 'a--b', '']) {
      const result = validateOwnerUrlSlug(slug)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain('lowercase letters, numbers, and single hyphens')
    }
  })

  test('gallery slugs accept the same pattern without a minimum length', () => {
    for (const slug of ['a', 'ab', 'coast', 'mixed-album', 'a-b-c']) {
      expect(validateGalleryUrlSlug(slug)).toEqual({ ok: true })
    }
    for (const slug of ['a--b', '-a', 'a-', 'a b', 'a_b', '']) {
      expect(validateGalleryUrlSlug(slug)).toMatchObject({ ok: false })
    }
    // Uppercase is normalized to lowercase first, exactly like the server.
    expect(validateGalleryUrlSlug('A')).toEqual({ ok: true })
  })

  test('gallery slug messages match the API copy', () => {
    const result = validateGalleryUrlSlug('Not A Valid Slug')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe('Use lowercase letters, numbers, and single hyphens for the gallery URL')
  })

  test('normalizeSlug matches the server trim+lowercase step', () => {
    expect(normalizeSlug('  Mahesh-V ')).toBe('mahesh-v')
    expect(normalizeSlug('COAST')).toBe('coast')
  })
})

describe('tier transitions', () => {
  test('upgrade raises the retained cap and never destroys anything', () => {
    const impact = tierTransitionImpact('free', 'pro')
    expect(impact.kind).toBe('upgrade')
    expect(impact.retainedLimitBefore).toBe(3)
    expect(impact.retainedLimitAfter).toBe(99)
    expect(impact.destructive).toBe(false)
    expect(impact.note).toContain('unexpired pipeline gallery')
  })

  test('downgrade narrows the cap but is explicitly non-destructive', () => {
    const impact = tierTransitionImpact('pro', 'free')
    expect(impact.kind).toBe('downgrade')
    expect(impact.retainedLimitBefore).toBe(99)
    expect(impact.retainedLimitAfter).toBe(3)
    expect(impact.destructive).toBe(false)
    expect(impact.note).toContain('never deleted or evicted')
    expect(impact.note).toContain('30 days')
  })

  test('same tier is no-change', () => {
    for (const tier of ['free', 'pro'] as const) {
      const impact = tierTransitionImpact(tier, tier)
      expect(impact.kind).toBe('no-change')
      expect(impact.retainedLimitBefore).toBe(impact.retainedLimitAfter)
      expect(impact.destructive).toBe(false)
    }
  })
})
