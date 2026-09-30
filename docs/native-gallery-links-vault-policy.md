# Native gallery links and the on-device vault

## What happens when someone taps a gallery URL

A public gallery URL has the form:

```text
https://manorama.xyz/{owner}/{gallery-slug}
```

On iOS, the app declares `applinks:manorama.xyz` and the Worker serves an Apple
association document. When Manorama is installed and iOS has accepted the
association, a tap opens the native app. Cold-launch and warm-link delivery both
select the two-segment gallery without requiring sign-in. Sign-in is still
required only for private account surfaces.

Android has the corresponding HTTPS intent filter. It becomes a verified Android
App Link when the production signing certificate SHA-256 fingerprint is supplied
as the Worker secret/variable `ANDROID_APP_LINK_SHA256`; the value must be the
real release certificate, never a guessed or debug fingerprint. Until that is
configured, Android may present the normal app/browser chooser rather than
claiming verified ownership.

## One account setting

On the signed-in native account page, **Gallery loading** has one device-local
preference:

- **Download to encrypted vault (default):** opening an online gallery returns
  immediately from the network while a background fill downloads the selected
  still-image bytes into the encrypted vault. Existing cache and offline-open
  behavior remains available.
- **Stream from cloud when needed:** opening an online gallery does not start a
  new vault fill. The viewer loads the provider/API URLs on demand. Existing
  encrypted copies are not deleted and can still be opened if the network is
  unavailable.

The preference is stored only in native app preferences and is not sent to the
server. It is intentionally not inferred from an estimated folder size in this
first implementation: the user has an explicit, predictable choice and the
secure default is always on.

## What “vault” means

The vault is a native-only secure storage mechanism. Gallery image bytes written
to it are encrypted at rest with per-gallery key material held in secure storage
and stored under the platform's app-private, no-cloud location. The viewer gets
short-lived object URLs only after decrypting bytes in memory.

Vault copies:

- are readable through Manorama's vault APIs only;
- are not exported as ordinary photographs;
- do not appear in Files, Finder, Photos, or another image viewer;
- are removed by the explicit account/storage purge controls; and
- are never uploaded back to the server.

This is stronger than browser cache semantics, but it is not a promise against a
compromised or jailbroken device while Manorama is running.

## Desktop status

The Tauri/macOS catalogue currently references user-picked local folders and
supports its own private catalogue store; it does **not** yet implement the same
cloud-gallery encrypted vault. Desktop public-gallery opening therefore remains a
separate follow-up: do not describe the current macOS catalogue as having the
iOS vault guarantee until a Tauri-native encrypted media store and cloud-gallery
loader are implemented and tested.
