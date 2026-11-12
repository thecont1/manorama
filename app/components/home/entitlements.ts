/**
 * The Free vs Visionary comparison, as data.
 *
 * The table holds only the rows where the plans differ — the strongest
 * upgrade reasons first. What both plans share is stated once below the
 * table, in SHARED_FEATURES, instead of five identical "Included" cells.
 *
 * Every row was traced to the code that enforces it during implementation;
 * the `codeRef` on each row says where. Where the plan asked for a
 * "Verify" before the copy could ship, the answer is recorded here and in
 * the handover.
 */

export type EntitlementRow = {
  label: string
  free: string
  visionary: string
  /** A short qualifier shown under the row. */
  note?: string
  /** True when the cells are the offer's headline numbers. */
  bigCells?: boolean
  /** Where the behaviour is enforced. */
  codeRef: string
}

export const ENTITLEMENTS: EntitlementRow[] = [
  {
    label: 'Permanent cloud galleries',
    free: '3',
    visionary: '99',
    note: 'Permanent galleries have no scheduled expiry under your plan. Cloud galleries still depend on their source links remaining available. Manorama is not a backup service.',
    /** The headline number gets display-size type. */
    bigCells: true,
    codeRef: 'app/lib/gallery-policy.ts:4-5 (FREE_RETAINED_LIMIT, PAID_RETAINED_LIMIT)',
  },
  {
    label: 'Temporary cloud galleries',
    free: 'Up to 96 non-editable galleries that each expire 30 days after creation',
    visionary: 'No 30-day expiry within your 99-gallery allowance',
    codeRef: 'app/lib/gallery-policy.ts:8-10,26; app/lib/user-repository.ts:456-463 (setUserTier)',
  },
  {
    label: 'Local galleries',
    free: 'Not included',
    visionary: 'Unlimited on Mac and Windows',
    note: 'The catalogue stays on the computer. Only gallery titles and photo counts sync.',
    // Verified during implementation: app/lib/device-gallery-repository.ts
    // holds no count check for any tier, so "unlimited" is true. The tier
    // gate is app/device-gallery-api.ts:66.
    codeRef: 'desktop/islands/Catalogue.tsx:431-441,935; app/device-gallery-api.ts:66; AGENTS invariant 12',
  },
  {
    label: 'Encrypted offline storage',
    free: 'Up to 256 MB',
    visionary: 'Choose a larger allowance or remove the cap',
    note: 'iPhone and iPad. The copy is encrypted on the device. The photographs are never re-encoded.',
    // The macOS shell ships the same vault module, but no owner-approved
    // wording for it yet, so the row keeps the narrowest true claim. It is
    // flagged in the handover.
    codeRef: 'native/lib/vault.ts:9; native/lib/vault-settings.ts:14-18,78-88',
  },
  {
    label: 'Browse your saved photographs',
    free: 'Current gallery.',
    visionary: 'All galleries saved offline.',
    note: 'iPhone and iPad.',
    codeRef: 'native/islands/GlobalView.tsx:179-186',
  },
]

/**
 * What both plans include, stated once rather than repeated in matched
 * cells. The sources entry links to the register in the Unify band.
 */
export const SHARED_FEATURES: { label: string; href?: string; codeRef: string }[] = [
  // Verified during implementation: a grep of app/islands/Viewer.tsx and
  // app/components/viewer/* for tier branches returns nothing.
  { label: 'The same core viewing experience', codeRef: 'app/islands/Viewer.tsx (no tier branch)' },
  { label: 'All supported cloud sources', href: '#unify', codeRef: 'app/lib/sources.ts:22,53; app/lib/proton-client.ts:263-265; app/lib/encrypted-client.ts:26-27' },
  { label: 'Saving shared galleries to your Library', codeRef: 'app/api.ts:726+ (POST /api/galleries/adopt, createGalleryWithinLimit)' },
  { label: 'Public gallery sharing', codeRef: 'README §Plans; app/lib/gallery-policy.ts (pipeline lifetime)' },
  { label: 'Editing and sequencing your permanent galleries', codeRef: 'app/lib/gallery-policy.ts:26 (assertGalleryEditable)' },
]
