# RevenueCat integration for manorama native

This project uses **HonoX and Hono JSX islands**, not React. Capacitor plugins are framework-agnostic, so the RevenueCat integration follows the same lifecycle that a React `useEffect` would use, but it is wired in `native/main.tsx` rather than a React component.

## 1. Install the SDK

Use Bun in this repository:

```bash
bun add @revenuecat/purchases-capacitor \
  @revenuecat/purchases-capacitor-ui
bunx cap sync
```

The repository now pins the compatible Capacitor 13.6.0 packages. The UI package provides the native hosted Paywall and Customer Center.

## 2. Configure the public SDK key

RevenueCat public SDK keys are intended to ship in the client. They are not server secrets. The local test key supplied for this app is configured in the ignored `.env.local`; it is not committed to Git.

For local native builds:

```dotenv
VITE_REVENUECAT_API_KEY=<RevenueCat public test SDK key>
```

For production, set `VITE_REVENUECAT_API_KEY` in the native build environment. Do not put the RevenueCat webhook authorization value or HMAC signing secret in a `VITE_` variable: those remain Worker secrets.

The native bootstrap reads the key only after a Dropbox session exists. It uses the stable Dropbox account ID from the signed session JWT as the RevenueCat `appUserID`, so a reinstall or device change does not create a second customer identity for the same account.

```ts
const apiKey = import.meta.env.VITE_REVENUECAT_API_KEY?.trim()
const appUserId = await getSessionAppUserId()
if (apiKey && appUserId) {
  await billing.configure({ apiKey, appUserId })
}
```

The implementation lives in `native/main.tsx`, `native/lib/session.ts`, and `native/lib/billing.ts`.

## 3. Configure the RevenueCat dashboard

Create the following exact configuration:

| Item | Value |
| --- | --- |
| App | iOS bundle ID `in.thecontrarian.manorama` and the Android application from the Capacitor project |
| Entitlement | `will_pay` |
| App Store product | `yearly` |
| Product type | Auto-renewable subscription, one year |
| RevenueCat package | Annual package attached to `yearly` |
| Current offering | The offering shown by the hosted Paywall |
| Customer Center | Enabled for the project |

In App Store Connect, create product ID `yearly`, choose the price and localizations, and ensure it is in the same subscription group as the app’s other subscription products if more are added later. The Paid Apps Agreement and banking must be active; that gate is now clear for manorama. A Sandbox Tester and a physical device are still required for purchase verification.

In RevenueCat:

1. Import the App Store Connect product `yearly`.
2. Create entitlement `will_pay`.
3. Attach `yearly` to the annual package in the current offering.
4. Create or publish the hosted Paywall for that offering.
5. Enable and configure Customer Center.
6. Copy the public SDK key into `VITE_REVENUECAT_API_KEY` for native builds.

## 4. Configure the native SDK

The provider-neutral adapter is `native/lib/billing.ts`. Its core configuration is:

```ts
await Purchases.configure({
  apiKey,
  appUserID: appUserId,
  automaticDeviceIdentifierCollectionEnabled: false,
  diagnosticsEnabled: false,
})
```

The adapter then registers `addCustomerInfoUpdateListener` and maps the active `will_pay` entitlement to the local `pro` presentation tier. Missing or inactive `will_pay` maps to `free`.

```ts
export const PRO_ENTITLEMENT = 'will_pay'

export const tierFromCustomerInfo = (customerInfo: CustomerInfo): NativeTier =>
  customerInfo.entitlements.active[PRO_ENTITLEMENT]?.isActive
    ? 'pro'
    : 'free'
```

The server tier is not changed by the client. RevenueCat webhooks are the trusted server-side path; see the webhook section below.

## 5. Present the hosted Paywall

The native shell calls `presentPaywallIfNeeded` with `will_pay`, so a customer who already has an active entitlement does not see the purchase screen again.

```ts
const { result, state } = await billing.presentPaywallIfNeeded()
if (state.isPro) {
  // The RevenueCat customer info now has an active will_pay entitlement.
}
```

The adapter uses the native UI package:

```ts
await RevenueCatUI.presentPaywallIfNeeded({
  requiredEntitlementIdentifier: 'will_pay',
  presentationConfiguration: PaywallPresentationConfiguration.FULL_SCREEN,
  displayCloseButton: true,
})
```

The hosted Paywall performs purchase and restore operations natively. After dismissal, the adapter refreshes CustomerInfo so the in-app state updates immediately. Errors are caught and shown as a quiet status message in `native/islands/Paywall.tsx` rather than leaving a dead button.

## 6. Customer Center

Customer Center is opened from the same native subscription surface:

```ts
await RevenueCatUI.presentCustomerCenter()
const state = await billing.refresh()
```

This gives subscribers a native path for restoring purchases, viewing status, and managing cancellation or plan changes without a custom settings flow in manorama.

## 7. Webhook and server tier synchronization

The Worker endpoint is:

```text
POST https://manorama.xyz/api/revenuecat-webhook
```

Configure two Worker secrets:

```text
REVENUECAT_WEBHOOK_AUTH
REVENUECAT_WEBHOOK_SIGNING_SECRET
```

Configure the same Authorization value in the RevenueCat webhook dashboard and enable HMAC signing. The endpoint verifies the exact raw request body with the `X-RevenueCat-Webhook-Signature` header and rejects stale signatures beyond five minutes.

The endpoint resolves the immutable Dropbox ID from `app_user_id`, `original_app_user_id`, or aliases and calls the existing `setUserTier` helper. The client never writes D1 and never promotes itself by changing a local flag.

## 8. Error handling and lifecycle rules

The integration follows these rules:

- No API key means native billing remains unavailable rather than crashing public gallery viewing.
- No signed-in session means RevenueCat is not configured.
- Purchase and restore results are followed by a fresh `getCustomerInfo` call.
- `will_pay` is the only entitlement used for the Pro gate.
- Customer Center and Paywall errors are surfaced as recoverable UI messages.
- The Android activity uses `singleTop`, as required for purchase verification flows that temporarily background the app.
- Secure session tokens are stored in iOS Keychain and Android Keystore; browser localStorage is only the plugin’s development fallback.

## 9. Verification checklist

Run the code gates:

```bash
bunx tsc --noEmit
bun test
bun run build:native
bun run build
bunx cap sync
```

Then verify on a physical sandbox device:

1. Sign in with Dropbox through the system browser.
2. Confirm the app returns through `in.thecontrarian.manorama://auth/callback`.
3. Confirm the app resumes with the same Dropbox identity after a cold launch.
4. Open subscription options and confirm the hosted Paywall displays the `yearly` product.
5. Complete a Sandbox purchase and confirm `will_pay` becomes active.
6. Confirm the native UI refreshes to the Pro state.
7. Confirm the RevenueCat webhook reaches the Worker and the server tier changes through `setUserTier`.
8. Open Customer Center and verify restore and cancellation flows.
9. Confirm a free customer sees the ad/upgrade path and a Pro customer does not receive free-tier treatment.

The remaining owner-only gates are creating the `yearly` product and RevenueCat offering, creating a Sandbox Tester, and waiting for the DSA review to complete.
