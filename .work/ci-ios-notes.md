# iOS CI notes — 2026-10-01

## The blocker ASC reported (11:03 IST)

Tapping **Add for Review** on iOS 1.0 returned **"Unable to Add for Review"** with five items:

1. Age-rating questions unanswered (App Information).
2. No primary category selected.
3. Builds must use the latest public (GM) Xcode and SDKs.
4. **"This build is using a beta version of Xcode and can't be submitted."** — build 6 was
   archived locally with **Xcode 27.1 beta**.
5. App Privacy answers missing (an Admin must complete the App Privacy section).

## Why the CI archive failed (runs 36817908612, 36818552831, 36819285612)

`ios/App/App/SceneDelegate.swift` used two **iOS 27.1 SDK** symbols:

- `preferredVerticalBarBehavior` / `UIVerticalBarBehavior` (line 12)
- `UIView.reservedRegions(kind:options:)` (line 109, inside `detectHinge`)

`@available(iOS 27.1, *)` and `#available` do **not** help when the symbol is absent from the SDK
being compiled against: the iOS 26 SDK that ships with Xcode 26.3 (the newest GM Xcode on the
`macos-15`/`macos-26` runner images — Xcode 27 exists there only as a preview) reports
`cannot find type 'UIVerticalBarBehavior' in scope`.

So the two paths were mutually exclusive:

- Build with Xcode 27.1 beta → compiles, but App Review rejects the binary.
- Build with Xcode 26.x GM → submission-eligible, but the archive fails.

## The fix (committed 2026-10-01)

Both iOS 27.1 refinements were removed from `SceneDelegate.swift`, leaving the iOS 26
`windowScene(_:didUpdateEffectiveGeometry:)` hook and the size-class payload that
`packages/core/fold.ts` consumes. `fold.ts#segmentsFromHinge` already treats a missing hinge as a
non-folded display, so no JS change was needed. Reinstated when the iOS 27 GM SDK ships.

The workflow then archives with Xcode 26.3 (GM) and uploads a stamped build to App Store Connect.