/**
 * Platform-free account policy for manorama — validation and policy only.
 *
 * The Worker remains authoritative for enforcement (`app/lib/user-repository.ts`,
 * `app/lib/identity-repository.ts`, `app/lib/gallery-policy.ts`). Every
 * constant and rule below mirrors that server code exactly so native and web
 * UI can reason about the same contract without importing platform code. If
 * the server changes a limit, this module must change with it.
 */

export type AccountTier = 'free' | 'pro'

export type AuthProvider = 'dropbox' | 'google' | 'apple'

export const AUTH_PROVIDERS: readonly AuthProvider[] = ['dropbox', 'google', 'apple']

export type LinkedIdentity = {
  provider: AuthProvider
  subject: string
  accountId: string
  displayName?: string
  email?: string
}

/**
 * URL slugs — owner and gallery — share the same shape: lowercase letters,
 * numbers, and single hyphens, never leading/trailing/double hyphens. This
 * mirrors `OWNER_SLUG_PATTERN` in `app/lib/user-repository.ts` and the inline
 * gallery-slug check in `app/api.ts`. The server normalizes (trim + lowercase)
 * before validating; `normalizeSlug` is that same step.
 */
export const URL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const OWNER_URL_SLUG_MIN = 3
export const OWNER_URL_SLUG_MAX = 48

export type SlugValidation =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'length' | 'format'; message: string }

export const normalizeSlug = (value: string): string => value.trim().toLowerCase()

export const validateOwnerUrlSlug = (slug: string): SlugValidation => {
  const normalized = normalizeSlug(slug)
  if (!normalized) return { ok: false, reason: 'empty', message: 'Use 3-48 lowercase letters, numbers, and single hyphens' }
  if (normalized.length < OWNER_URL_SLUG_MIN || normalized.length > OWNER_URL_SLUG_MAX) {
    return { ok: false, reason: 'length', message: `Use ${OWNER_URL_SLUG_MIN}-${OWNER_URL_SLUG_MAX} lowercase letters, numbers, and single hyphens` }
  }
  if (!URL_SLUG_PATTERN.test(normalized)) {
    return { ok: false, reason: 'format', message: 'Use 3-48 lowercase letters, numbers, and single hyphens' }
  }
  return { ok: true }
}

export const validateGalleryUrlSlug = (slug: string): SlugValidation => {
  const normalized = normalizeSlug(slug)
  if (!normalized) return { ok: false, reason: 'empty', message: 'Use lowercase letters, numbers, and single hyphens for the gallery URL' }
  if (!URL_SLUG_PATTERN.test(normalized)) {
    return { ok: false, reason: 'format', message: 'Use lowercase letters, numbers, and single hyphens for the gallery URL' }
  }
  return { ok: true }
}

/**
 * Unlink policy — a local mirror of `unlinkIdentity` in
 * `app/lib/identity-repository.ts`. The last sign-in method can never be
 * removed: an account with zero identities would be unrecoverable. The server
 * enforces this atomically; this function lets the UI refuse before the round
 * trip and render the same failure as the API (409 last-identity / 404 not
 * found).
 */
export type UnlinkResult =
  | { ok: true; remaining: LinkedIdentity[] }
  | { ok: false; reason: 'last-identity'; message: string }
  | { ok: false; reason: 'unknown'; message: string }
  | { ok: false; reason: 'unsupported-provider'; message: string }

export const unlinkIdentityPolicy = (
  identities: readonly LinkedIdentity[],
  provider: string,
): UnlinkResult => {
  if (!AUTH_PROVIDERS.includes(provider as AuthProvider)) {
    return { ok: false, reason: 'unsupported-provider', message: 'That sign-in method was not found' }
  }
  const remaining = identities.filter((identity) => identity.provider !== provider)
  if (remaining.length === identities.length) {
    return { ok: false, reason: 'unknown', message: 'That sign-in method was not found' }
  }
  // Refuse only when this removal would leave zero identities — the same
  // guard as the server's `COUNT(*) > 1`, which counts the whole account, not
  // per provider.
  if (remaining.length === 0) {
    return { ok: false, reason: 'last-identity', message: 'The last sign-in method cannot be removed' }
  }
  return { ok: true, remaining }
}

/**
 * Retained-gallery caps. Values mirror `app/lib/gallery-policy.ts`: free
 * accounts retain three editable galleries, paid 99; beyond the free cap new
 * galleries become 30-day pipeline (temporary) galleries, while at the paid
 * cap creation is refused outright. No pricing is modeled here — only the
 * storage/editing caps.
 */
export const FREE_RETAINED_LIMIT = 3
export const PAID_RETAINED_LIMIT = 99
export const PIPELINE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
export const PIPELINE_LOCK_MESSAGE = 'This temporary gallery cannot be edited on the free plan. Upgrade to keep it and make changes.'
export const FREE_RETENTION_DISCLOSURE = 'Free accounts retain up to 3 editable galleries. Additional galleries are temporary and are removed after 30 days unless you upgrade.'
export const PAID_RETAINED_CAP_MESSAGE = 'Paid accounts can retain up to 99 galleries. Delete a gallery before adding another.'

export type GalleryRetention = 'retained' | 'pipeline'

export const retainedGalleryLimit = (tier: AccountTier): number =>
  tier === 'pro' ? PAID_RETAINED_LIMIT : FREE_RETAINED_LIMIT

export const canRetainAnotherGallery = (tier: AccountTier, retainedCount: number): boolean =>
  retainedCount < retainedGalleryLimit(tier)

export type NextGalleryRetention =
  | { allowed: true; retention: 'retained' }
  | { allowed: true; retention: 'pipeline' }
  | { allowed: false; reason: 'paid-cap'; message: string }

/** What a new gallery becomes, given the account's tier and retained count.
 *  Mirrors the CASE in `createGalleryWithinLimit`; the server's atomic check
 *  remains the real guard against concurrent creates. */
export const nextGalleryRetentionFor = (tier: AccountTier, retainedCount: number): NextGalleryRetention => {
  if (tier === 'pro') {
    if (retainedCount >= PAID_RETAINED_LIMIT) {
      return { allowed: false, reason: 'paid-cap', message: PAID_RETAINED_CAP_MESSAGE }
    }
    return { allowed: true, retention: 'retained' }
  }
  return retainedCount < FREE_RETAINED_LIMIT
    ? { allowed: true, retention: 'retained' }
    : { allowed: true, retention: 'pipeline' }
}

/** Retained count follows `retentionOf` in `gallery-repository.ts`: a missing
 *  retention is retained — only an explicit `pipeline` is temporary. */
export const countRetainedGalleries = (
  galleries: readonly { retention?: GalleryRetention }[],
): number => galleries.filter((gallery) => gallery.retention !== 'pipeline').length

export type TierTransitionKind = 'upgrade' | 'downgrade' | 'no-change'

export type TierTransitionImpact = {
  from: AccountTier
  to: AccountTier
  kind: TierTransitionKind
  retainedLimitBefore: number
  retainedLimitAfter: number
  /** A tier change never deletes or evicts retained galleries or encrypted
   *  device vault copies — it only narrows how many galleries may be *added*
   *  as retained. This flag is structurally always false; it exists so UI
   *  code cannot introduce a destructive downgrade path. */
  destructive: false
  note: string
}

export const tierTransitionImpact = (from: AccountTier, to: AccountTier): TierTransitionImpact => {
  const retainedLimitBefore = retainedGalleryLimit(from)
  const retainedLimitAfter = retainedGalleryLimit(to)
  if (from === to) {
    return {
      from,
      to,
      kind: 'no-change',
      retainedLimitBefore,
      retainedLimitAfter,
      destructive: false,
      note: 'Tier unchanged.',
    }
  }
  if (to === 'pro') {
    return {
      from,
      to,
      kind: 'upgrade',
      retainedLimitBefore,
      retainedLimitAfter,
      destructive: false,
      note: `Promotion keeps every unexpired pipeline gallery and raises the retained-gallery cap from ${retainedLimitBefore} to ${retainedLimitAfter}.`,
    }
  }
  return {
    from,
    to,
    kind: 'downgrade',
    retainedLimitBefore,
    retainedLimitAfter,
    destructive: false,
    note: `A downgrade narrows the retained-gallery cap from ${retainedLimitBefore} to ${retainedLimitAfter}; galleries beyond it become temporary (30 days) from the next addition. Existing retained galleries and encrypted device vault copies are never deleted or evicted.`,
  }
}
