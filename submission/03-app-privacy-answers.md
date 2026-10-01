# App Store Connect: App Privacy answer sheet

Based on `ios/App/App/PrivacyInfo.xcprivacy` and `docs/privacy-policy.md`. Recheck against the exact uploaded binary if the native build changes. The current source has native HTTPS gallery links, deliberate wrapped cloud-folder import handoffs, an account-owned photo picker, encrypted vault copies, and device-local feature records; those local records are not sent to Manorama.

**Do you or your third-party partners collect data from this app?** → **Yes**  
**Do you use data for tracking?** → **No**

| Data type | Collected | Linked | Tracking | Purpose | Basis |
|---|---:|---:|---:|---|---|
| Contact Info › Name | Yes | Yes | No | App Functionality | Sign-in display name |
| Contact Info › Email Address | Yes | Yes | No | App Functionality | Account email or Apple private relay |
| Identifiers › User ID | Yes | Yes | No | App Functionality | Manorama and RevenueCat account IDs |
| Purchases › Purchase History | Yes | Yes | No | App Functionality | Entitlements and purchase-event references |
| User Content › Other User Content | Yes | Yes | No | App Functionality | Gallery titles, captions, links, names and metadata |
| Photos or Videos | **Yes** | **Yes** | **No** | App Functionality | Bounded server-side MEGA preview-photo cache |
| Identifiers › Device ID | No | — | — | — | IDFA is not requested; RevenueCat device identifiers are disabled |
| Usage Data / Diagnostics | No | — | — | — | No analytics SDK; RevenueCat diagnostics disabled |
| Location | No | — | — | — | Not used |
| Contacts | No | — | — | — | Not used |
| Financial Information | No | — | — | — | Card details are not received by Manorama |
| Browsing/Search History | No | — | — | — | Not collected |
| Health/Sensitive Information | No | — | — | — | Not collected |

## Why Photos or Videos is Yes

The server can decrypt and hold a small MEGA preview photo in a bounded in-memory cache for App Functionality. Ordinary gallery media is passed through and is not durably stored. On macOS, opening, rescanning, launching, or mounting a local folder does not upload original files; catalogue metadata may sync, while original uploads occur only after the explicit Share action. Native vault copies are encrypted on the device and are not sent back to Manorama.

`NSPrivacyTracking` is `false`; no advertising identifier is requested. Account, gallery metadata, device catalogue and plan references are linked for App Functionality. RevenueCat/Apple process purchases; Manorama receives plan status and purchase-event references, not card details. C2PA verification is performed on-device when requested. Mobile vault bytes, photo picker thumbnails, and local compute feature records remain device-local and are not collected by Manorama.

## Export compliance

The app uses standard HTTPS and native-vault encryption. `ITSAppUsesNonExemptEncryption` is `false` in `Info.plist`; confirm the final App Store Connect answer remains exempt/no non-exempt encryption for the uploaded build.
