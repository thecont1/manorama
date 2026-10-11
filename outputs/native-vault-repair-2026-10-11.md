# Native gallery repair — 11 October 2026

## Changes

- **Account thumbnails:** normalize summary image URLs, variants and video posters against the API origin. Previously `/api/...` resolved against the bundled Capacitor origin. Use a video's poster when no preview variant is present.
- **Current gallery picker:** build its contact sheet from the current online manifest immediately. An encrypted vault commit is no longer a prerequisite. Other saved galleries remain governed by the existing Global View preference. No image transformations or server storage were introduced.
- **Vault feedback:** count photographs after encrypted writes; show preparing, saving N of M, saved, streaming, unsupported mixed-gallery, and interrupted states in the controls panel and picker. Never draw a progress indicator over photographs.
- **Per-gallery opt-out:** “Don’t download this gallery” starts unchecked, is stored on this device, and overrides the global download policy for this gallery. Switching it on cancels the current fill through the existing abort lifecycle. Existing encrypted copies are not erased.
- **Return navigation:** “Back to your galleries” appears in the Display settings panel. It releases the gallery lease, closes the picker, cancels background work and returns to the account surface. Android system Back handles the picker/modal/account stack; no edge-swipe gesture was added to iOS because that would compete with horizontal photographic panning.

## Important distinction

The existing offline store deliberately refuses mixed photo/video galleries. The previous picker copy implied a download was still progressing even when it had been skipped. This repair makes the picker work online and reports that limitation accurately; it does **not** claim mixed-gallery offline support.

## Verification

- TypeScript: clean.
- Full unit suite after initial repairs and Android Back integration: **1084 passed, 0 failed**.
- Native built-bundle controls acceptance: **3 passed**, at 375×812, 1376×1032 and 1440×900. Checks streaming switch default/state, immediate picker, return to account and no page errors.
- Regression tests cover account URL normalization, encrypted-write progress, gallery-scoped preference isolation and online picker selection with an empty vault.

## Remaining release gates

The complete viewer/input/C2PA matrix and fresh six-state native evidence for iPhone, iPad and macOS have not been rerun for this repair. Browser-sized native-bundle tests are not physical-device screenshots. Android system Back is implemented but has not been verified on Android hardware.

## Physical iPhone delivery

Final source passed TypeScript and all **1084 unit tests** (0 failed). Xcode reported **BUILD SUCCEEDED**, and CoreDevice confirmed installation of `in.thecontrarian.manorama` on Vidya’s iPhone 16 Plus. Automatic launch was denied because the phone was locked; unlock the phone and open manorama manually. No successful physical-device UI walkthrough is claimed.
