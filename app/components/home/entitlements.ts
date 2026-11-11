/**
 * The Free vs Visionary comparison, as data.
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
  /** Where the behaviour is enforced. */
  codeRef: string
}

export const ENTITLEMENTS: EntitlementRow[] = [
  {
    label: 'Permanent cloud galleries',
    free: '3',
    visionary: '99',
    note: 'A permanent gallery has no expiry while your plan is active.',
    codeRef: 'app/lib/gallery-policy.ts:4-5 (FREE_RETAINED_LIMIT, PAID_RETAINED_LIMIT)',
  },
  {
    label: 'Temporary cloud galleries',
    free: 'Up to 96 at a time; 30 days each; read-only',
    visionary: 'Still-live ones become permanent on upgrade, within 99',
    codeRef: 'app/lib/gallery-policy.ts:8-10,26; app/lib/user-repository.ts:456-463 (setUserTier)',
  },
  {
    label: 'Local galleries',
    free: 'Not available',
    visionary: 'Unlimited in the Mac and Windows apps',
    note: 'The catalogue stays on the computer. Only titles and counts travel.',
    // Verified during implementation: app/lib/device-gallery-repository.ts
    // holds no count check for any tier, so "unlimited" is true. The tier
    // gate is app/device-gallery-api.ts:66.
    codeRef: 'desktop/islands/Catalogue.tsx:431-441,935; app/device-gallery-api.ts:66; AGENTS invariant 12',
  },
  {
    label: 'Core viewing experience',
    free: 'Included',
    visionary: 'Included',
    note: 'The same viewer, the same controls, the same frame rate.',
    // Verified during implementation: a grep of app/islands/Viewer.tsx and
    // app/components/viewer/* for tier branches returns nothing.
    codeRef: 'app/islands/Viewer.tsx (no tier branch)',
  },
  {
    label: 'Supported cloud sources',
    free: 'All six; Proton Drive in the apps',
    visionary: 'All six; Proton Drive in the apps',
    note: 'Ente works in the browser too.',
    codeRef: 'app/lib/sources.ts:22,53; app/lib/proton-client.ts:263-265; app/lib/encrypted-client.ts:26-27',
  },
  {
    label: 'Edit and sequence your own galleries',
    free: 'Permanent galleries; temporaries read-only',
    visionary: 'All your galleries',
    codeRef: 'app/lib/gallery-policy.ts:26 (assertGalleryEditable)',
  },
  {
    label: 'Keep galleries shared by others',
    free: 'Included; counts toward your allowance',
    visionary: 'Included; counts toward your allowance',
    note: 'A kept copy is yours to view. It does not make you its publisher.',
    codeRef: 'app/api.ts:726+ (POST /api/galleries/adopt, createGalleryWithinLimit)',
  },
  {
    label: 'Public gallery sharing',
    free: 'Included; temporaries until they expire',
    visionary: 'Included',
    codeRef: 'README §Plans; app/lib/gallery-policy.ts (pipeline lifetime)',
  },
  {
    label: 'Offline encrypted copies',
    free: 'iPhone & iPad, up to 256 MB on the device',
    visionary: 'iPhone & iPad, a larger cap or no cap, your choice',
    note: 'The copy is encrypted on the device. The photographs are never re-encoded.',
    // The macOS shell ships the same vault module, but no owner-approved
    // wording for it yet, so the row keeps the narrowest true claim. It is
    // flagged in the handover.
    codeRef: 'native/lib/vault.ts:9; native/lib/vault-settings.ts:14-18,78-88',
  },
  {
    label: 'Global View',
    free: 'iPhone & iPad: the gallery you are looking at',
    visionary: 'iPhone & iPad: every gallery you have kept offline',
    codeRef: 'native/islands/GlobalView.tsx:179-186',
  },
  {
    label: 'Platforms',
    free: 'Web, iPhone, iPad, Mac, Windows',
    visionary: 'Web, iPhone, iPad, Mac, Windows',
    codeRef: 'app/components/home/home-manifest.ts (SURFACES)',
  },
  {
    label: 'Where to subscribe',
    free: 'Not applicable',
    visionary: 'The web, from your Library, or in the iPhone and iPad app',
    note: 'The Mac and Windows apps do not sell the subscription themselves.',
    codeRef: 'app/routes/[owner].tsx:29-36; native/lib/billing.ts; desktop/islands/Catalogue.tsx:2378',
  },
]
