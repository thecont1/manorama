# App Store Connect submission state — 2026-10-01

## What blocked "Add for Review" (reported by ASC at 11:03 IST)

| # | Blocker | Status |
|---|---------|--------|
| 1 | Age-rating questions unanswered | in progress (wizard open, Step 1 of 7 answered) |
| 2 | No primary category | **done** — Photo & Video, secondary Lifestyle |
| 3 | Build must use GM Xcode/SDK | **fixed in CI** (see below) |
| 4 | "Build 6 uses a beta version of Xcode" | build 6 is unusable; a new build is uploading |
| 5 | App Privacy answers missing | not started |

Also saved on the App Information page: subtitle "A delightful way to see photos",
Content Rights = "Yes, this app has the necessary rights to its third-party content."

## Age rating questionnaire — answers chosen

Step 1 (Features) answers:

- Parental Controls: **No**
- Age Assurance: **No**
- Unrestricted Web Access: **No** (no general-purpose browsing; links open in Safari)
- User-Generated Content: **Yes** (galleries are user-published photographs, shared by unlisted link)
- Social Media: **No** (no feed, profile, or social graph)
- Social Media Disabled for Users Under 13: **Yes** (there are no social features to reach)
- Messaging and Chat: **No**
- Advertising: **No** (no ad network; the free tier shows the owner's own house cards)

Steps 2–7 remain (mature themes, medical, sexuality, violence, chance-based, then the summary).

Steps 2–6 were then completed with every content question at NONE and every
capability follow-up at No (Mature Themes, Medical or Wellness, Sexuality or
Nudity, Violence, Chance-Based Activities).

### The rule that Step 7 enforces

Saving Step 7 failed with:

> Go Back to Step 1 and Edit Your Responses — If your app contains Social Media,
> but disabled for users under 13, you must choose Yes for Social Media,
> User-Generated Content, and Age Assurance.

The questionnaire refuses the combination "Social Media = No" with "Social Media
Disabled for Users Under 13 = Yes". manorama has no social features at all, so
the honest fix is the other direction: **Social Media Disabled for Users Under 13
= No**, leaving Social Media = No, UGC = Yes, Age Assurance = No. That keeps the
calculated rating at 13+ (driven by user-generated galleries) without claiming a
Declared Age Range integration the app does not implement.

## Why build 6 could not be submitted, and the fix

`ios/App/App/SceneDelegate.swift` used two iOS 27.1 SDK symbols
(`UIVerticalBarBehavior`, `UIView.reservedRegions`). They compile with the local
Xcode 27.1 **beta**, but App Review rejects beta-built binaries, and the iOS 26 SDK
on the CI runners does not contain them at all — so neither toolchain could produce
a submittable build. Both refinements were removed (commit "fix(ios): build with the
public SDK so the app can be submitted"); only the iOS 26 effective-geometry hook
and the size-class payload remain, which is all `packages/core/fold.ts` needs.

The archive then succeeded on Xcode 26.3, but the **export** failed:

```
error: exportArchive Cloud signing permission error
error: exportArchive No signing certificate "iOS Distribution" found
error: exportArchive No profiles for 'in.thecontrarian.manorama' were found
```

The archive had silently signed with "iOS Team Provisioning Profile" — a *development*
profile — which cannot produce an App Store package. Cloud signing could not fix it,
so the distribution identity and the App Store profile are now supplied from secrets.

### Secrets added to thecont1/manorama

| Secret | Value |
|---|---|
| `IOS_DIST_CERTIFICATE_BASE64` | base64 of `$HOME/DEV/manorama-secrets/ios-identities.p12` (holds "Apple Distribution: Mahesh Shantaram (373K7W3LKU)") |
| `IOS_DIST_CERTIFICATE_PASSWORD` | `$HOME/DEV/manorama-secrets/ios-p12-password.txt` |
| `IOS_PROVISIONING_PROFILE_BASE64` | base64 of `d9582f5c-b7d9-4bbe-97c5-46ecd89566a8.mobileprovision` |

The profile is **"iOS Team Store Provisioning Profile: in.thecontrarian.manorama"**
(hash `d9582f5c…`, `get-task-allow = false`, expires 2027-09-30). The other local
profile, `aa6a569c…`, is the *development* one and must not be used. The same name
appears in `.github/workflows/ios.yml` (`env.PROFILE_NAME`) and in
`ios/ExportOptions.plist` (`signingStyle = manual`, `provisioningProfiles`), so all
three must stay in step. `scripts/prepare-ios-signing-cert.sh` regenerates the secrets.

## Remaining to submit

1. Finish the age-rating wizard (steps 2–7; expect "None" / "No" throughout).
2. Complete **App Privacy** using `submission/03-app-privacy-answers.md`
   (collects data, linked, no tracking; Photos or Videos = Yes).
3. When the new build finishes processing in App Store Connect, attach it to
   iOS 1.0, then **Add for Review → Submit for Review**.
4. Request expedited review.
