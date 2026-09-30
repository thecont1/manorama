import { createRoute } from 'honox/factory'

export default createRoute((c) =>
  c.render(
    <main class="policy-page">
      <article class="policy-document">
        <h1>Privacy Policy</h1>
        <p class="policy-updated">Last updated: 29 September 2026</p>
        <p class="policy-lede">Manorama is a place to share and look at photographs. This policy covers manorama.xyz, the Manorama mobile app, and the Manorama desktop app. Start with the part that sounds like you; if you both view and publish galleries, both parts apply.</p>

        <h2>Who this is for</h2>
        <div class="policy-personas">
          <section class="policy-card" aria-labelledby="policy-just-looking">
            <h3 id="policy-just-looking">Just looking</h3>
            <p>Open a public gallery link without an account. We do not keep a history of galleries you view or run page-view analytics. A link is unlisted, not private: anyone who has it can open it. Your browser may remember display choices; the app may keep encrypted offline copies on your device.</p>
          </section>
          <section class="policy-card" aria-labelledby="policy-making-galleries">
            <h3 id="policy-making-galleries">Making galleries</h3>
            <p>Sign in with Apple, Google, or Dropbox. We keep your account ID, name, email (which may be an Apple private-relay address), public address, plan, and the details needed to show your galleries. You can link more than one sign-in method to the same account. We never see your sign-in password or keep the provider’s sign-in token. Photos stay at the source; deleting a gallery here never deletes the originals.</p>
          </section>
          <section class="policy-card" aria-labelledby="policy-pro-forever">
            <h3 id="policy-pro-forever">Pro or Forever</h3>
            <p>Paid plans use the same account data. On mobile, RevenueCat and your app store handle purchases; on the web, Stripe does. Manorama receives plan status, not card details. You can keep more galleries and a larger device vault. You may still see Manorama’s own labeled placements, but not third-party ad-network placements.</p>
          </section>
        </div>

        <section class="policy-section">
          <h2>Where photographs go</h2>
          <p>Your photographs and videos stay with the public source you chose: Dropbox, Google Drive, iCloud Shared Albums, or MEGA. For each gallery, we keep its title, caption, public source link, media names and descriptive details, order, and any expiry date. When someone opens a gallery, Manorama fetches media from that source and passes it through to the viewer; we do not keep copies of the image or video bytes on our server. Today only iCloud Shared Albums can include video — the other sources supply photographs. Source services may process requests under their own privacy policies. A shared album or folder must remain publicly reachable for a gallery to work.</p>
          <p>If an image includes Content Credentials — information about where an image came from and how it changed — verification happens on the viewer’s device when requested. We do not upload its provenance record for that check. Link previews may fetch a cover image transiently; they are not a stored photo library. One exception: MEGA galleries can hold originals in a format browsers cannot display, so the server decrypts a small preview photo on request. Those previews are held in a bounded in-memory cache — at most 200 entries — which is discarded when the server restarts. They are never written to our database or to durable storage.</p>
        </section>

        <section class="policy-section" id="on-your-device">
          <h2>On your device</h2>
          <p>The web app may remember gallery display choices and the editor’s theme in browser storage. These preferences are not sent to Manorama. Clearing site data removes them.</p>
          <p>The mobile app can keep photographs and gallery details in a vault — the app’s encrypted storage on your device — for offline viewing and its optional image grid. Galleries that include video are not cached for offline use today. Its encryption keys stay on that device, and the vault is excluded from cloud backup. A cached image is either the source’s own bytes or a smaller version the source provides; nothing from the vault is saved to Manorama’s servers. Offline copies stay until the app evicts them, you remove a gallery from the vault, you choose “Forget everything,” or you uninstall the app. Removing an online gallery or account does not automatically clear copies already on another device; clear the local vault separately.</p>
          <p>The desktop app keeps its catalogue — the local folders and cards you have opened and your linked galleries — on your device, and a sign-in token in secure device storage. None of that is sent to Manorama except when you ask it to publish a gallery.</p>
        </section>

        <section class="policy-section">
          <h2>Ads and purchases</h2>
          <p>Today the website and apps show only Manorama’s labeled house placements. On the website, signed-in paying viewers see only house placements. We plan non-personalized third-party website ads in gallery strips for visitors without a sign-in and signed-in Free viewers; these ads are not enabled yet. A paid viewer must sign in on the web for us to recognize their plan; while signed out, they appear anonymous. We will identify the website ad provider and explain its data use, consent choices, and browser storage before enabling it. In the mobile app, Google AdMob ads for Free users are also planned but not enabled. Even non-personalized ad providers may receive technical request data such as IP address and device details. We do not plan to request Apple’s advertising identifier.</p>
          <p>RevenueCat and your app store process purchases and restores on mobile; Stripe processes them on the web. They may process purchase, device, and account-linked information under their own policies. Manorama receives active-plan status and purchase-event references to set your plan — never your payment-card details. A purchase made in the app and one made on the web update the same account plan.</p>
        </section>

        <section class="policy-section">
          <h2>Cookies, retention, and your choices</h2>
          <p>Looking at a gallery without signing in does not require a Manorama login cookie. Signing in on the web uses short-lived safety cookies, a login cookie lasting up to seven days, and a returning-visitor hint lasting up to one year. Signing out clears the login cookie; you can clear the returning hint with browser site data. In the apps, a sign-in token is kept in secure device storage.</p>
          <p>An owner’s account and retained gallery details remain until deleted. A Free owner’s extra temporary galleries expire after 30 days unless upgraded in time. You can delete a gallery from your dashboard; that removes its Manorama record, not the source files.</p>
          <p>You can delete your account yourself, from your dashboard or in the app under account settings. Deletion removes your account, gallery records, device catalogue, and linked sign-in methods from Manorama. It does not delete files at the photo source, and app stores or Stripe keep their own billing records under their policies. You can also ask us to access, correct, or export your account information. Rights vary by location, and service providers may keep their own records under their policies.</p>
        </section>

        <section class="policy-section">
          <h2>Services and what comes next</h2>
          <p>Cloudflare hosts Manorama and may handle request details such as IP address and time for delivery and security. Apple, Google, or Dropbox handles sign-in, depending on which you choose. The linked photo provider supplies the media. The website and apps may request fonts from Google. RevenueCat and the app store handle mobile purchases; Stripe handles web purchases. We do not sell your account or gallery records or use them to personalize ads.</p>
          <p>We are exploring opt-in, session-only nearby sharing and on-device photo suggestions. These are not active collection or sharing practices today. We will update this policy before any of them changes what leaves your device or who receives it.</p>
        </section>

        <section class="policy-section">
          <h2>Contact and changes</h2>
          <p>For privacy questions or requests, contact <a href="https://thecontrarian.in/#contact">Mahesh Shantaram</a>. If our practices change, we will update this page and its date.</p>
        </section>
      </article>
    </main>,
    { title: 'Privacy Policy — manorama', description: 'What Manorama keeps about gallery viewers, owners, and paid plans — on the web at manorama.xyz and in the mobile and desktop apps.' },
  ),
)
