# App Store Connect — version 1.0 fill-in sheet

This is the current filing checklist. It distinguishes local evidence from fields that must be verified in the authenticated App Store Connect record.

## Version and metadata

| Field | Value |
|---|---|
| Version | `1.0` |
| Release | Manually release this version; no phased release |
| Name | `manorama.xyz` |
| Subtitle | `A delightful way to see photos` |
| Promotional text / Description | Use `01-app-store-listing.md` |
| Keywords | `photo,gallery,photography,portfolio,viewer,offline,slideshow,album,share,dropbox,drive,icloud,photos` |
| Support | `https://thecontrarian.in/#contact` |
| Marketing | `https://manorama.xyz` |
| Privacy policy | `https://manorama.xyz/privacy` |
| Copyright | `2026 Mahesh Shantaram` |
| Categories | Photo & Video / Lifestyle |

The description must accurately mention default-on encrypted vault download, optional stream-from-cloud for newly opened galleries, account-owned photo picker, 3 Free editable galleries, 99 Visionary retained galleries, explicit macOS local-folder sharing, and the new-subscriber introductory offer.

## Compliance and review

| Field | Value |
|---|---|
| Export compliance | Exempt/no non-exempt encryption, subject to confirmation for uploaded build; `ITSAppUsesNonExemptEncryption=false` |
| Content rights | Owner supplies or links content and is responsible for rights |
| App Privacy | Use `03-app-privacy-answers.md`; Photos or Videos is **Yes / Yes / No / App Functionality** due to bounded MEGA preview cache |
| Reviewer | Mahesh Shantaram, +91 99801 29770, ms@thecontrarian.in |
| Sign-in required | Yes |
| Demo account | Leave empty; Sign in with Apple works with a normal Apple ID |
| Notes | Use the current block in `02-app-review-notes.md` |

## In-app purchase — Visionary Annual

Direct ASC link: https://apps.apple.com/app/id6815378290 — open the Visionary subscription under Subscription Group 22421889.

| Field | Value |
|---|---|
| Product ID | `in.thecontrarian.manorama.visionary.annual` |
| Display name | Visionary Annual |
| Entitlement | `will_pay` |
| RevenueCat package | `$rc_annual` |
| Duration | One year |
| US price | US$19.99 (175 territories, CSV-verified 2026-10-01) |
| Introductory offer | Pay-up-front introductory offer, US$11.99 for the first year, new subscribers only. One introductory offer per subscription: delete the existing one-month free trial before creating this, or ASC will refuse. Reverts to US$19.99/year when the introductory period ends. |
| Promotional offer | Offer code `VISIONARY2020`, one free month, new subscribers only. Verify the resulting price path in a sandbox before describing it anywhere. |

### Subscription description (paste into the IAP description field, replacing the current generic line)

```text
manorama Visionary is an annual subscription that unlocks up to 99 retained galleries (vs. 3 on Free), a larger or unlimited encrypted offline vault, and house-only placements — no third-party ad slots. New subscribers can pay US$11.99 up front for the first year, then US$19.99/year. Auto-renews until cancelled in Settings.
```

### Review Information (paste)

- **Review note:** `Unlocks Visionary: up to 99 retained galleries, larger or unlimited encrypted offline vault, and house-only placements. Sign in, then tap "View subscription options".`
- **Review screenshot:** see "Pending before submit" below
- **1024×1024 promotional image (optional):** upload `screens/icon-1024.png` (the app icon). The field is optional and improves the subscription's listing — leave blank if the file is rejected.

### Pending before submit

- [ ] **Review screenshot** — capture the live RevenueCat paywall on the test build (after the corrected paywall is published; see `08-session-handoff-2026-09-30.md`) and upload via the IAP Review Information row.
- [ ] Paywall published in RevenueCat — `Oct 2026 Launch` paywall `wfe8d56d6ec2124d39` is in **Draft**; `Publish changes` is blocked by 2 unresolved issues at the time of writing (the chip reads "2 issues" — 1 warning + 1 error). `ActualPrice` and `ActualPrice2` were changed from a hand-typed literal to `{{ product.price_per_period }}` in both the Default and Selected text rules on 2026-10-01; the draft auto-saved across an editor reload.

## Screenshots

The local folder contains exactly six iPhone, six iPad landscape, and six macOS evidence images:

| Set | Count | Dimensions | Use |
|---|---:|---:|---|
| iOS | 6 | 1284×2778 | iPhone evidence / Devpost |
| iPad landscape | 6 | 2752×2064 | iPad App Store evidence / Devpost |
| macOS | 6 | 1440×900 | Desktop evidence only |

States: opening screen; gallery curtain; first image with navigation controls; controls popover; account/admin page with the device-local photo picker decision; iOS photo picker / macOS folder-grid equivalent. iOS images use the real `italia, amore mio` gallery and `Family trip to Italy in October 2018` subtitle. Native rails are 12dvh, aspect-ratio-preserving, and gapless.

**Do not mark complete until App Store Connect confirms required iPhone slots, required iPad slots for the universal target, and the IAP review screenshot.**

## Build artifact

- IPA: `build/manorama-1.0-build-6.ipa` (21.2 MB, SHA-256 `73721e13214b73ce451e7e2eacbce9cc46dfa0f5a42261a5b5c9e04ff2b5ce72`)
- Marketing version: `1.0`
- Project build: `6`
- Release: manual
- Archived from `main` at `95c51e8` on 1 Oct 2026, build-number bump committed as `4f5020c` on `chore/ios-build-6`. Distribution-signed with `Apple Distribution: Mahesh Shantaram (373K7W3LKU)` (SHA-1 `F991A7BE50DE830B38DA8F6A8FB5282FBFCFE4B8`, expires 27/09/27), `get-task-allow` false, `beta-reports-active` true, `applinks:manorama.xyz` present, web entry `assets/index-Cpk8Z5sH.js`.

Build 3, 4 and 5 must not be uploaded. Build 3 predates the native deep-link/vault-policy branch and the photo picker/admin rail changes. Build 4 predates the chrome and opening-screen fixes, so its bundled CSS still paints the viewport-scale wordmark behind the curtain and over every photograph. Build 5 predates the account gallery cover row and the phone-sized chrome row, so it does not match the screenshots already uploaded to App Store Connect. Build 6 supersedes all three.

The project build number was raised from `3` to `6` (`CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`) so the upload is not rejected as a duplicate if build 3 already reached App Store Connect. Confirm the highest build number present in App Store Connect before uploading.

**Export prerequisite on this machine.** `xcodebuild -exportArchive` shells out to `rsync` when it assembles the IPA, and Homebrew's `rsync` 3.5.1 at `/opt/homebrew/bin/rsync` shadows macOS's `/usr/bin/rsync` and rejects the flags Xcode passes. The failure is a bare `error: exportArchive Copy failed` with no useful cause on stdout; the real error is in the `.xcdistributionlogs` bundle (`rsync error: syntax or usage error (code 1)`). Run the export with `/usr/bin` first on `PATH`:

```sh
env PATH="/usr/bin:/bin:/usr/sbin:/sbin" xcodebuild -exportArchive \
  -archivePath ios/build/Manorama-6.xcarchive \
  -exportPath <out> -exportOptionsPlist <plist> -allowProvisioningUpdates
```

The same shadowing will break the tag-triggered ASC upload in CI if the runner has a Homebrew rsync ahead of `/usr/bin`.

## Final checklist

- [ ] **Physical-device screen recording (Guideline 2.1, requested 1 Oct 2026)** — record on the iPhone running current iOS: launch → Sign in with Apple → open `thecontrarian/italy` → viewer → "View subscription options" paywall → account deletion. Use a throwaway sign-in for the deletion take — the flow really deletes the account. Attach to the Resolution Center reply.
- [ ] **Paste the Guideline 2.1 reply** from `02-app-review-notes.md` into the Notes field (Apple asked for it there too) and send the Resolution Center reply.
- [ ] **Publish the RevenueCat paywall** — the `Oct 2026 Launch` draft still has unresolved issues; the reviewer cannot see the real paywall until it is published.
- [ ] **Submit Visionary Annual with the version** — the IAP must be attached to this submission, with the IAP review screenshot (live paywall) in its Review Information row.
- [ ] Confirm the exact build attached to version 1.0.
- [ ] Confirm all required iPhone screenshots are accepted.
- [ ] Upload/confirm the six iPad landscape screenshots in `screens/ipad/`.
- [ ] Add/confirm the IAP review screenshot.
- [ ] Confirm App Privacy answers against the uploaded binary.
- [ ] Confirm introductory-offer eligibility and wording.
- [ ] Confirm export compliance and content rights.
- [ ] Paste review notes and verify reviewer phone.
- [ ] Submit only after all checks pass.
