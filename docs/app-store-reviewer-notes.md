# App Review notes — draft for the owner to paste into App Store Connect

Everything below is written to describe only what exists in build **12** (version
1.0). Replace each `[OWNER]` placeholder before submitting; do not paste the
brackets. Where a claim needs device proof, the matching capture set lives in
`demo-captures/` — attach or reference it in the review record.

## What the app is (for the "Notes" field)

Manorama is a photography-first gallery app. An owner points a gallery at a
public Dropbox, Google Drive, iCloud Shared Album, or MEGA link and gets
`manorama.xyz/{owner}/{gallery}` — original photographs streamed from the
provider, fit to the screen without cropping, stretching, or upscaling. The
iOS app adds what the web cannot: an encrypted on-device vault for offline
viewing, and a Global View matrix of every saved frame.

## What a reviewer can do without signing in

- Open the public demo gallery directly:
  `https://manorama.xyz/thecontrarian/italy` — the universal link opens the
  app into that gallery.
- Swipe through photographs, open the Gallery controls, switch strip /
  vertical / one-at-a-time modes, open the info sheet (`i` button) for
  position, caption, EXIF, and Content Credentials where present.
- No account, purchase, or personal data is required for any of the above.

## Signing in (owner path)

- Sign in offers Apple, Google, and Dropbox. To review the signed-in surface,
  use demo account: **[OWNER — provide reviewer-safe credentials, or precise
  sign-in steps, plus an expiry plan for the account]**.
- A signed-in reviewer can save a gallery to the encrypted vault, enable
  Airplane Mode, relaunch, and open it offline; open Global View from the
  account page; and reorder photographs in the editor.

## Monetisation (what the reviewer will see)

- One product: the annual `in.thecontrarian.manorama.visionary.annual`
  subscription (RevenueCat entitlement `will_pay`). There is no monthly or
  one-time tier in this build.
- Free accounts show ad placements on a seeded cadence (roughly one plate per
  25 photographs, never first/last/adjacent); Pro suppresses third-party
  network ads and shows only house placements. Ads are non-personalized.
  [OWNER — confirm dashboard ad units are configured, or note that plates
  render as house placements until they are.]

## Deliberate limits in this build

- Nearby/synchronised viewing between devices is not in this build.
- Vault keys live in the device keychain; deleting the app destroys them.
- The macOS app is a separate listing; the iOS listing claims no Mac features.

## Contact

Questions during review: mahesh@thecontrarian.in —
[OWNER — add a phone number; App Review asks for one.]

---

### Checklist before pasting

- [ ] Demo credentials filled in and verified working, or replaced with
      precise sign-in steps Apple can follow with their own accounts.
- [ ] Ad units confirmed live in AdMob, or the house-plate note kept.
- [ ] Phone number added.
- [ ] Build number updated if a build newer than 12 is submitted.
- [ ] Re-read against `docs/app-store-submission-evidence.md` — claim nothing
      the evidence matrix still marks pending.
