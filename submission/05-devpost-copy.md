# Devpost submission copy

This copy reflects the current source and native behavior. It does not claim that the App Store listing is live, that a judge account exists, or that the introductory offer is universal.

## Description

```text
manorama is a quiet place to look at photographs. Someone sends you a link; you open it; the pictures fill the screen. No feed, no likes, no algorithm deciding what you see next.

THE VIEWING EXPERIENCE IS THE PRODUCT
• Photographs are shown exactly as made: never upscaled, recompressed, cropped or stretched.
• Colour profiles and Content Credentials are preserved where the source provides them.
• A physical film-strip supports touch, pointer, trackpad and keyboard input, with ProMotion-aware motion on compatible iPhones.
• Magnifier and floating photo picker let you move through a gallery without turning it into a feed. The native account page controls the device-wide opt-in.
• Native local compute stores only compact encrypted feature records for reviewable sequencing suggestions; image data stays on the device.

TAKE GALLERIES OFFLINE
• Native defaults to Download to encrypted vault for still-image galleries.
• Vault copies are encrypted in app-private storage and visible only inside manorama, not Files or another image viewer.
• The account page offers Stream from cloud when needed for newly opened galleries. Existing encrypted copies remain.
• Free vault storage is capped at 256 MiB; Visionary can use a larger cap or unlimited vault storage.

MAKE YOUR OWN GALLERIES
• Sign in with Apple, Google or Dropbox and publish galleries from public Dropbox, Google Drive, iCloud Shared Album or MEGA links. A deliberate `manorama.xyz/<provider-url>` wrapper can hand the import to the installed native app; direct provider URLs remain untouched.
• Gallery metadata is stored by Manorama. Source photographs remain at their provider; the server has no durable photo library apart from a bounded transient MEGA preview cache.
• macOS can explicitly share a selected local folder to connected Dropbox or Google Drive. Local paths, file lists, and bytes do not reach the Worker.
```

## Testing instructions

```text
1. Open the app. Under “Continue with” are Apple, Google and Dropbox icons.
2. Tap Apple and sign in with any Apple ID. A new account may say “No galleries on this account yet.”
3. Expand “Open another gallery”, enter owner `thecontrarian` and slug `italy`, then tap “Open gallery” to reach `italia, amore mio` / `Family trip to Italy in October 2018`. Alternatively, deliberately prefix a supported public cloud-folder URL with `manorama.xyz/`; the installed native app receives that import intent while the direct provider URL remains provider-owned.
4. On the native account page, enable photo picker once. Then tap the quiet counter to expand the position readout and open the picker when cached frames exist. Tap the floating manorama control for settings.
5. On the account page, inspect Gallery loading: Download to encrypted vault (default) or Stream from cloud when needed.
6. Tap View subscription options to inspect the RevenueCat paywall and Customer Center. New subscribers get a discounted first year, and offer code VISIONARY2020 adds one free month; add a verified offer code or Visionary judge account here if required.
```

## Facts requiring owner confirmation

- Public App Store URL after release.
- Verified Apple offer code or pre-granted Visionary judge account.
- Public demo video under two minutes.
- Whether Devpost requires a separate 1024×1024 icon.
- Whether the generated iPad landscape screenshots and the IAP review screenshot are attached in App Store Connect.
- Any #BuildInPublic links.
