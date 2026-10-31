# App Review Information

## Fields
- **First name:** Mahesh
- **Last name:** Shantaram
- **Phone:** +91 99801 29770
- **Email:** ms@thecontrarian.in
- **Sign-in required:** Yes
- **Demo account:** Leave username/password empty; Sign in with Apple is available.
- **Release:** Manual release; no phased release.

## Guideline 2.1 reply (1 October 2026)

Apple asked for six items under "Information Needed — New App Submission". Send this
block as the Resolution Center reply, then paste it into the Notes field so it travels
with future submissions. Attach or link the physical-device recording where indicated.

```text
Thank you for reviewing manorama. Answers to your questions follow, and a reviewer walkthrough is at the end.

1. SCREEN RECORDING
A screen recording captured on a physical iPhone running iOS 26 is provided with this reply. It begins with launching the app and shows the typical flow: sign-in with Apple, opening a public gallery, the photo-first viewer, the subscription paywall, and self-serve account deletion from Settings. The app carries no user-to-user content — only a gallery owner publishes, from their own cloud folder, and viewers cannot post, comment, or upload anything — so content reporting and blocking mechanisms are not applicable.

2. PURPOSE AND TARGET AUDIENCE
manorama is a photography-first gallery viewer and publisher for photographers and anyone who shares photo albums. The owner points the app at a public Dropbox, Google Drive, iCloud, or MEGA album and manorama publishes it as a gallery at manorama.xyz/<owner>/<gallery> that displays every image at its honest size — never upscaled, cropped, or re-compressed — with colour profiles and provenance intact. The app adds what the web cannot: an encrypted on-device vault for true offline viewing and a device-local photo picker. The problem it solves: cloud album links and social feeds re-encode and crop photographs; manorama shows them as they are.

3. SETUP AND ACCESS
No demo credentials are needed. Launch the app, tap the Apple icon under "Continue with", and sign in with any Apple ID (Google and Dropbox sign-in also work). Your own galleries appear as cards on the Library. To load the real gallery "italia, amore mio" in the app, open https://manorama.xyz/thecontrarian/italy on the device — the universal link hands it to manorama; viewing a public gallery never requires an account and the same URL works in any browser. A deliberate `manorama.xyz/<supported-public-folder-url>` wrapper also hands a folder import to the installed app.

4. EXTERNAL SERVICES
- Cloudflare Workers and D1: hosting and gallery metadata.
- Dropbox, Google Drive, iCloud Shared Albums, MEGA: user-supplied photo sources; media is fetched on view and never stored by manorama.
- Sign in with Apple, Google sign-in, Dropbox sign-in (OAuth).
- RevenueCat and App Store in-app purchase for the optional Visionary subscription; Stripe is used on the website only.
- No analytics SDKs, no advertising identifier, no AI services. All typefaces are bundled in the app; no remote font or asset services are contacted.

5. REGIONAL DIFFERENCES
None. The app functions identically in all regions. Our own in-gallery promotional placements may be suppressed per day or per region by us; no third-party ad networks are enabled.

6. REGULATED INDUSTRY / PROTECTED MATERIAL
Not applicable. The app is not in a regulated industry and ships no third-party protected material; owners link their own photographs and are responsible for their rights.
```

## Notes field

```text
Thank you for reviewing manorama.

FIRST SCREEN
The app opens on the manorama wordmark and “adj. a view that is delightful to the mind.” Under “Continue with” are three icon controls: Apple, Google and Dropbox.

SIGN IN
Tap the Apple icon. A normal Apple ID can be used; no special demo account is required. A new account may show “No galleries on this account yet.”

OPEN A GALLERY
Open the real gallery at `https://manorama.xyz/thecontrarian/italy` on the device — the universal link hands it to the app. The evidence gallery is “italia, amore mio” with subtitle “Family trip to Italy in October 2018”. A deliberate `manorama.xyz/<supported-public-folder-url>` wrapper is also a native import handoff; direct Dropbox/Drive URLs remain with those providers.

VIEWER
The viewer is a photo-first horizontal strip. Tapping the stage or moving the pointer raises temporary chrome: a top bar with the position count and a bottom row with Display, Info and (for owners) Details; the bars hide again after a few idle seconds. Display opens a sheet with Layout (Strip/Scroll/One by one), Canvas (Black/Dark/Light) and the Arrows switch; Info shows position, caption, EXIF and Content Credentials. Tapping the position count or pressing `G` opens the photo picker matrix. On native the picker is enabled once in Settings › This iPhone › Photo picker, which also gains an "Open photo picker" row; it reads frames already held in the encrypted vault and fetches remote previews lazily for frames that have no vault entry yet.

SUBSCRIPTION
A new free account below its gallery limit sees "Plan" in the Library footer — it opens Settings › Plan, where "Go Visionary" leads to "See price in the App Store" and the RevenueCat paywall. (A free account that has reached its gallery limit sees "Go Visionary" in the footer directly.) RevenueCat presents the annual Visionary product using the `will_pay` entitlement. The paywall offers "Restore purchases" and "Manage subscription"; Customer Center supports restore and subscription management.

VAULT
“Gallery loading” defaults to “Download to encrypted vault (default)”. “Stream from cloud when needed” is the alternative. Vault copies are encrypted in app-private storage and are displayed only by manorama, not Files or another image viewer. The photo picker reads cached frames from that vault. Native local compute may also persist compact feature records in the same encrypted vault for grouping and sequencing suggestions; those records never leave the device.

ACCOUNT DELETION
From the Library, tap the gear to open Settings and use the "Delete account" row at the bottom, review the confirmation, then tap "Delete permanently" or Cancel. Deletion removes Manorama records and linked sign-in methods; it does not delete files at Dropbox, Google Drive, iCloud or MEGA, and billing records remain with Apple/RevenueCat.

PRIVACY
The privacy manifest declares linked account metadata, purchase history, owner-authored gallery metadata and bounded MEGA preview-photo handling for App Functionality. It declares no tracking and the app does not request the advertising identifier.

WHY THIS IS AN APP
Encrypted on-device vault, offline opening of cached still-image galleries, account-owned vault-backed photo picker, local compute that does not upload image data, native RevenueCat purchase/Customer Center, explicit macOS local-folder sharing, ProMotion-aware motion and wide-colour handling.
```

**Contact:** Mahesh Shantaram · +91 99801 29770 · ms@thecontrarian.in

## Expedited review text, only after submission

```text
manorama is our entry to the RevenueCat Shipaton 2026 hackathon. The build is complete, reviewer notes explain how to test without a demo account, and we are available to answer questions immediately.
```
