# Devpost submission: RevenueCat Shipaton 2026

- **Project:** manorama
- **Tagline:** A view that is delightful to the mind: the calmest way to look at photographs together.
- **App Store URL:** `https://apps.apple.com/app/id6815378290` — use only after public release.
- **Video:** `[OWNER: add a public YouTube URL under 2:00]`; no video is present in this folder.
- **Icon:** `[OWNER: add the final 1024×1024 icon if required]`.
- **Evidence:** six iOS captures in `screens/ios/` at 1284×2778, six iPad landscape captures in `screens/ipad/` at 2752×2064, and six macOS captures in `screens/macos/` at 1440×900. These were regenerated from the current source against real `italia, amore mio` / `Family trip to Italy in October 2018` content. The sixth iOS state is the account-owned photo picker; the sixth macOS state is the local folder grid.
- **Judge access:** Sign in with Apple using the judge’s own Apple ID. A verified offer code or pre-granted Visionary judge account is still needed to exercise paid access without a purchase.

## Description

```text
Someone sends you a link to their photographs. manorama opens it the way a photographer would want: the pictures fill the screen, nothing competes with them, and nothing about them is changed.

WHAT IT DOES
• Photo-first film-strip galleries from Dropbox, Google Drive, iCloud Shared Albums and MEGA.
• Honest image size: never upscaled, recompressed, cropped or stretched. Colour profiles and Content Credentials are preserved where the source provides them.
• Touch, pointer, trackpad and keyboard navigation with ProMotion-aware motion on compatible iPhones.
• Magnifier and a floating, vault-backed photo picker for cached frames; the setting is controlled from the native account page.
• Default-on encrypted on-device vault for still-image galleries, plus an account choice to stream newly opened galleries from the cloud.
• Native local compute persists only compact encrypted feature records for reviewable grouping/sequencing suggestions; image bytes and features stay local.
• Sign in with Apple, Google or Dropbox. Deliberately prefixing a supported public folder URL with `manorama.xyz/` hands that import to the installed native app; direct provider URLs are not intercepted. Originals remain at their provider; Manorama stores metadata and does not maintain a durable server-side photo library.
• macOS can explicitly share a chosen local folder to the owner’s Dropbox or Google Drive; opening, rescanning, and mounting remain local-only.
```

## RevenueCat

```text
Visionary is sold through RevenueCat using the `will_pay` entitlement, a RevenueCat paywall and Customer Center. The annual product is `in.thecontrarian.manorama.visionary.annual` in `$rc_annual`. A pay-up-front introductory offer gives new subscribers a discounted first year; eligibility depends on Apple storefront rules. Offer code `VISIONARY2020` gives new subscribers one free month on top. A RevenueCat webhook updates the account plan.
```

## Design Award

```text
Look at the stage, not the chrome. Low-resolution images stay at honest size. The strip is physically damped. The photo picker uses a glassy surface with full aspect ratios and no crop or upscale. The native account page owns the opt-in; the viewer contains only the picker. Native vault copies and local feature records are encrypted and visible only inside manorama. No feed, engagement algorithm, analytics SDK or advertising identifier request.
```

## HAMM Award: monetization

```text
Visionary is US$19.99/year in the US through Apple’s in-app purchase via RevenueCat. New subscribers receive a discounted first year at US$11.99; the subscription reverts to US$19.99/year when the introductory period ends, so introductory eligibility is not a universal promise. Reviewers and judges can also redeem offer code VISIONARY2020 for one free month. Free retains up to 3 editable galleries; additional galleries are temporary for 30 days. Visionary retains up to 99 galleries and can use a larger or unlimited encrypted vault. Visionary uses Manorama house placements only. No performance or conversion results are claimed because this is the first release.
```
