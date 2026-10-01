# App Store Connect: version 1.0 listing

## App information
- **Name:** manorama.xyz (Apple ID 6815378290)
- **Subtitle:** `A delightful way to see photos`
- **Primary category:** Photo & Video
- **Secondary category:** Lifestyle
- **Copyright:** `2026 Mahesh Shantaram`
- **Support URL:** `https://thecontrarian.in/#contact`
- **Marketing URL:** `https://manorama.xyz`
- **Privacy Policy URL:** `https://manorama.xyz/privacy`
- **Age rating:** 4+
- **User-generated content:** Yes — galleries are unlisted links, not a public feed.
- **Content rights:** The owner supplies or links the gallery content and is responsible for the rights to publish it.

## Version 1.0 copy

**Promotional text**

```text
Open a gallery and just look. Honest colour, ProMotion-aware motion, and an encrypted offline vault so your photographs travel with you. No feed, no noise.
```

**Description**

```text
manorama (adj.): a view that is delightful to the mind.

manorama is a quiet place to look at photographs. Someone sends you a link; you open it; the pictures fill the screen. No feed, no likes, no algorithm deciding what you see next.

THE VIEWING EXPERIENCE IS THE PRODUCT
• Photographs are shown at their honest size: never upscaled, recompressed, cropped or stretched.
• Colour profiles and Content Credentials are preserved through the image path where the source provides them.
• A physical film-strip stage supports touch, pointer, trackpad and keyboard navigation, with ProMotion-aware motion on compatible iPhones.
• A magnifier and photo picker help you inspect a gallery without turning it into a feed. The photo picker is enabled once from the native account page and shows frames already held in the device vault.

TAKE GALLERIES OFFLINE
• The native app defaults to downloading still-image galleries into an encrypted on-device vault.
• Vault copies are visible only inside manorama, not in Files or another image viewer. Keys remain in secure device storage and the vault is excluded from cloud backup.
• The account page can instead stream newly opened galleries from the cloud. Existing encrypted copies are not deleted by that choice.
• The Free vault ceiling is 256 MiB. Visionary can use a larger cap or unlimited vault storage, subject to device space.

MAKE YOUR OWN GALLERIES
• Sign in with Apple, Google or Dropbox and publish galleries from public Dropbox, Google Drive, iCloud Shared Album or MEGA links. Deliberately prefix a supported public folder URL with `manorama.xyz/` to hand the import to the installed native app.
• On macOS, choose a local folder and explicitly Share it to connected Dropbox or Google Drive. Opening, rescanning, or mounting a folder never uploads it.
• Gallery metadata is stored by manorama while source photographs remain at their source. Manorama does not keep a durable server-side photo library; a bounded transient MEGA preview cache is the documented exception.

manorama VISIONARY
• Up to 99 retained galleries instead of 3 editable Free galleries.
• A larger or unlimited encrypted offline vault.
• House placements only; no third-party ad-network placement.
• US$19.99 per year in the US, with a discounted first year for new subscribers. Local storefront prices vary.

Payment is charged to your Apple ID when you confirm the purchase. The subscription renews automatically unless cancelled at least 24 hours before the current period ends. Manage or cancel it in Settings › Apple ID › Subscriptions.

Privacy Policy: https://manorama.xyz/privacy
Terms of Use: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
```

**Keywords**

```text
photo,gallery,photography,portfolio,viewer,offline,slideshow,album,share,dropbox,drive,icloud,photos
```

## In-app purchase
- **Product ID:** `in.thecontrarian.manorama.visionary.annual`
- **Display name:** Visionary Annual
- **Entitlement:** `will_pay`
- **Duration:** 1 year
- **US price:** US$19.99
- **India price recorded during setup:** ₹899
- **Introductory offer:** Pay-up-front introductory offer — US$11.99 for the first year, for new subscribers. The subscription reverts to US$19.99/year when the introductory period ends. Verify final storefront eligibility; it is not available to every customer.
- **Promotional offer:** Offer code `VISIONARY2020` — one free month for new subscribers, after which the subscription renews at the introductory price. Confirm the resulting price path in a sandbox before advertising the combination.
- **RevenueCat package:** `$rc_annual`
- **Review note:** `Unlocks Visionary: up to 99 retained galleries, larger or unlimited encrypted offline vault, and house-only placements. Sign in, then tap “View subscription options”.`

## Release and evidence
- **Release:** Manual release.
- **Local build:** `build/manorama-1.0-build-6.ipa` (21.2 MB, SHA-256 `73721e13214b73ce451e7e2eacbce9cc46dfa0f5a42261a5b5c9e04ff2b5ce72`).
- **Binary/source boundary:** build 6 was archived from `main` at `95c51e8` with the build-number bump committed as `4f5020c` on `chore/ios-build-6`, on 1 Oct 2026. It therefore carries the account gallery cover row (`5bc9b9e`) and the phone-sized chrome row on wider screens (`6d17a75`), which build 5 did not — and which the uploaded iPad screenshots already show. Verified in the exported binary: `CFBundleVersion 6`, `CFBundleShortVersionString 1.0`, bundle id `in.thecontrarian.manorama`, signed `Apple Distribution: Mahesh Shantaram (373K7W3LKU)`, `get-task-allow` false, `beta-reports-active` true, `com.apple.developer.associated-domains = applinks:manorama.xyz`, and bundled web entry `assets/index-Cpk8Z5sH.js` (build 5 carried `assets/index-C7rM0Iwa.js`).
- **Do not upload build 3, 4, or 5.** Build 3 predates the native deep-link/vault-policy branch. Build 4 predates the chrome and opening-screen fixes. Build 5 predates the cover row and the phone-sized chrome row, so it does not match the listing's screenshots.
- **Associated Domains:** the app declares `applinks:manorama.xyz`, which the existing profile did not carry. Archiving needed `-allowProvisioningUpdates` so Xcode could reconcile the capability with the profile. If a future archive reports "provisioning profile does not include the associated-domains entitlement", that is this capability, not a signing regression.
- Local evidence: six authentic iPhone images at **1284×2778** in `screens/ios/`, six iPad landscape images at **2752×2064** in `screens/ipad/`, and six macOS images at **1440×900** in `screens/macos/`.
- The iPhone set uses the real `italia, amore mio` gallery with subtitle `Family trip to Italy in October 2018`.
- macOS images are evidence only, not iOS App Store slots. The local iPad set is ready; confirm the required iPad slots and the IAP review screenshot in App Store Connect before submission.
