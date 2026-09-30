# Privacy Policy

Last updated: 30 September 2026

Manorama is a place to share and look at photographs. This policy covers manorama.xyz, the Manorama mobile app, and the Manorama desktop app. Start with the part that sounds like you; if you both view and publish galleries, both parts apply.

## Who this is for

### Just looking

Open a public gallery link without an account. We do not keep a history of galleries you view or run page-view analytics. A link is unlisted, not private: anyone who has it can open it. When the native app is installed and the platform association is active, a public two-segment Manorama link may open in the app instead of the browser. Your browser may remember display choices; the app may keep encrypted offline copies on your device.

### Making galleries

Sign in with Apple, Google, or Dropbox. We keep your account ID, name, email (which may be an Apple private-relay address), public address, plan, and the details needed to show your galleries. You can link more than one sign-in method to the same account. We never see your sign-in password or keep the provider's sign-in token. Photos stay at the source; deleting a gallery here never deletes the originals.

### Pro or Forever

Paid plans use the same account data. On mobile, RevenueCat and your app store handle purchases; on the web, Stripe does. Manorama receives plan status, not card details. You can keep more galleries and a larger device vault. You may still see Manorama’s own labeled placements, but not third-party ad-network placements.

## Where photographs go

For a cloud-source gallery, your photographs and videos stay with the public source you chose: Dropbox, Google Drive, iCloud Shared Albums, or MEGA. For each gallery, we keep its title, caption, public source link, media names and descriptive details, order, and any expiry date. When someone opens a gallery, Manorama fetches media from that source and passes it through to the viewer; we do not keep copies of ordinary image or video bytes on our server. Today only iCloud Shared Albums can include video — the other sources supply photographs. Source services may process requests under their own privacy policies. A shared album or folder must remain publicly reachable for a cloud-source gallery to work.

The desktop app can also scan a folder you choose on that Mac. Its local catalogue keeps the folder path and file list on the device; the metadata sync sent to Manorama contains only a title, source type, item count, device identifier, and device label. Nothing is uploaded merely by opening, rescanning, launching, or mounting a folder. If you explicitly choose **Share**, the app uploads supported originals to your connected Dropbox or Google Drive, creates a public provider link, and sends Manorama that link plus the gallery metadata. Local paths, file lists, and image bytes are not sent to the Manorama Worker.

If an image includes Content Credentials — information about where an image came from and how it changed — verification happens on the viewer’s device when requested. We do not upload its provenance record for that check. Link previews may fetch a cover image transiently; they are not a stored photo library. One exception: MEGA galleries can hold originals in a format browsers cannot display, so the server decrypts a small preview photo on request. Those previews are held in a bounded in-memory cache — at most 200 entries — which is discarded when the server restarts. They are never written to our database or to durable storage.

## On your device

The web app may remember gallery display choices and the editor’s theme in browser storage. These preferences are not sent to Manorama. Clearing site data removes them.

The mobile app can keep photographs and gallery details in a vault — the app’s encrypted, app-private storage on your device — for offline viewing. **Download to encrypted vault** is the default for newly opened still-image galleries; **Stream from cloud when needed** avoids starting a new vault fill, while existing encrypted copies remain available. Galleries that include video are not cached for offline use today. The vault’s keys stay on that device and its files are excluded from cloud backup. Vault copies are readable through Manorama’s vault APIs only: they are not exported as ordinary photographs and should not appear in Files, Photos, Finder, or another image viewer. A cached image is either the source’s own bytes or a smaller version the source provides; nothing from the vault is saved to Manorama’s servers.

The optional **Global View** switch lives on the signed-in native account page, not inside each gallery. When enabled, it is a device-local contact sheet of frames already held in the encrypted vault. It decrypts thumbnails only on the device, lazily as needed, and sends neither image bytes nor the contact sheet to Manorama. Native local compute may also persist compact versioned feature records in that same vault for grouping and sequencing suggestions; it does not send image bytes, thumbnails, vectors, or feature records to the Worker.

Offline copies and local records stay until the app evicts them, you remove a gallery from the vault, you choose “Forget everything,” or you uninstall the app. Removing an online gallery or account does not automatically clear copies already on another device; clear the local vault separately.

The desktop app keeps its catalogue — the local folders and cards you have opened and your linked galleries — on your device, along with its app-private session and provider connection records. It does not provide the mobile cloud-gallery encrypted-vault guarantee. Desktop local-folder publication is a separate, explicit Share action as described above.

## Ads and purchases

Today the website and apps show only Manorama’s labeled house placements. On the website, signed-in paying viewers see only house placements. We plan non-personalized third-party website ads in gallery strips for visitors without a sign-in and signed-in Free viewers; these ads are not enabled yet. A paid viewer must sign in on the web for us to recognize their plan; while signed out, they appear anonymous. We will identify the website ad provider and explain its data use, consent choices, and browser storage before enabling it. In the mobile app, Google AdMob ads for Free users are also planned but not enabled. Even non-personalized ad providers may receive technical request data such as IP address and device details. We do not plan to request Apple’s advertising identifier.

RevenueCat and your app store process purchases and restores on mobile; Stripe processes them on the web. They may process purchase, device, and account-linked information under their own policies. Manorama receives active-plan status and purchase-event references to set your plan — never your payment-card details. A purchase made in the app and one made on the web update the same account plan.

## Cookies, retention, and your choices

Looking at a gallery without signing in does not require a Manorama login cookie. Signing in on the web uses short-lived safety cookies, a login cookie lasting up to seven days, and a returning-visitor hint lasting up to one year. Signing out clears the login cookie; you can clear the returning hint with browser site data. In the apps, a sign-in token is kept in secure device storage.

An owner’s account and retained gallery details remain until deleted. A Free owner’s extra temporary galleries expire after 30 days unless upgraded in time. You can delete a gallery from your dashboard; that removes its Manorama record, not the source files.

You can delete your account yourself, from your dashboard or in the app under account settings. Deletion removes your account, gallery records, device catalogue, and linked sign-in methods from Manorama. It does not delete files at the photo source, and app stores or Stripe keep their own billing records under their policies. You can also ask us to access, correct, or export your account information. Rights vary by location, and service providers may keep their own records under their policies.

## Services and what comes next

Cloudflare hosts Manorama and may handle request details such as IP address and time for delivery and security. Apple, Google, or Dropbox handles sign-in, depending on which you choose. The linked photo provider supplies the media. The website and apps may request fonts from Google. RevenueCat and the app store handle mobile purchases; Stripe handles web purchases. We do not sell your account or gallery records or use them to personalize ads.

We are exploring opt-in, session-only nearby sharing and on-device photo suggestions. These are not active collection or sharing practices today. We will update this policy before any of them changes what leaves your device or who receives it.

## Contact and changes

For privacy questions or requests, contact [Mahesh Shantaram](https://thecontrarian.in/#contact). If our practices change, we will update this page and its date.
