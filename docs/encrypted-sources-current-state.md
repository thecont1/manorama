# Encrypted-source current-state audit

Baseline inspected: `916f0f9`; branch later synced cleanly to `origin/main` @ `5a401d6`. The plan's `b39e354` code references had no drift at the initial review; independent review re-confirmed every V(ext) row.

## Key custody at baseline

1. Browser quick-add reconstructs the provider fragment and POSTs the complete URL. Dashboard scan does the same after a 700ms debounce (`app/quickadd.ts`, `app/islands/Admin.tsx`).
2. `canonicalMegaUrl()` persists the fragment in `galleries.source_url` (`app/lib/mega-public.ts`, `app/api.ts`).
3. MEGA item and preview proxy URLs contain per-node `k=` secrets. They are persisted in `images_json` and shipped in SSR island props (`app/lib/mega-public.ts`, `app/routes/[owner]/[slug].tsx`).
4. Refresh scans the stored keyed URL on the Worker (`app/api.ts`).
5. OG source selection reaches the MEGA file proxy, which buffers and decrypts originals up to 48 MiB (`app/lib/og-card.ts`, `app/lib/mega-public.ts`).
6. `previewCache` retains decrypted previews in a 200-entry / 64 MiB module map (`app/lib/mega-public.ts`).

## Media fidelity at baseline

- MEGA serves decrypted original bytes but skips MAC verification. `c2pa: true` is therefore not an integrity claim.
- MEGA dimensions describe the preview rendition for browser-renderable formats; HEIC may use the original head. Failure falls back to 4:3.
- iCloud has legacy shared-stream and newer CloudKit scanner paths. Original labels must remain evidence-based: resolution alone does not prove byte identity, and an edited full-resolution render is not an original.
- Native vault reuse compares only `src`, so replacement under a stable handle can retain stale bytes (`native/lib/offline-gallery.ts`).
- Native deep links reject gallery URLs with fragments (`native/lib/session.ts`).

## Resolved reference notes

- Gallery primary key is `(owner_id, slug)` and slugs are reusable after deletion. Immutable ids are required for safe client key custody.
- `created_at` has one-second resolution in the original schema and is not a suitable surrogate identity.
- Pipeline galleries are read-only and retained-only update guards already exist.
- `width` and `height` are already published in D1 and island props; publishing them in client manifests adds no new metadata class.
- `/og-image.png` is 1200×630. Current renderer incorrectly labels explicit per-gallery images as JPEG regardless of asset and emits path-only `og:url`.
- Gallery CSP currently has `connect-src 'self'`; no third-party scripts are required by the current gallery route.

## Implementation status after the baseline audit

- Foundation commit `6f180fd` adds immutable gallery ids, session-only web keys, validated keyless manifests, MEGA client scanning/decryption, bounded object-URL ownership, static encrypted OG metadata, and fragment-preserving navigation.
- Reversible migration records non-secret device ids. The first converted gallery keeps its legacy server key; a second distinct verified device or an explicit owner opt-out retires it and stores only the keyless source URL.
- `LEGACY_ENCRYPTED_DECRYPT=enabled` is the explicit temporary cohort-migration kill switch. Without it, MEGA file/preview endpoints answer 410 and public legacy records use the client gate. Server-side MEGA scan dispatch is rejected unconditionally.
- iCloud CloudKit now selects `resOriginalRes`, including HEIC, whenever present and labels derivative fallback separately. See `docs/original-media-fidelity.md` for evidence limits.
- Visitor-facing client gates never receive the stored capability: the island's `sourceUrl` prop is always the keyless form and legacy `k=` item srcs are stripped from SSR props unless the viewer is the owner, who needs them for the migration call.
- Native delegates encrypted sources to the web until the fragment channel and vault materialize seam land: gallery opens and keyed deep links go through `Browser.open`, quick-add of an encrypted link hands the wrapped `manorama.xyz/<provider-url>` URL to the same sheet, and the vault fill skips encrypted manifests before it would invalidate a healthy stored copy. A gallery vaulted before migration still renders offline from stored bytes.

## Transition exceptions

Legacy server-held MEGA keys and the decrypted-preview cache remain named exceptions only until reversible migration and native readiness complete. They are not evidence that the end-state privacy invariant failed; they are removal targets with tests that become strict at M7.
