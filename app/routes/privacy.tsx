import { createRoute } from 'honox/factory'

export default createRoute((c) =>
  c.render(
    <main class="policy-page">
      <article class="policy-document">
        <h1>Privacy Policy</h1>
        <p class="policy-updated">Last updated: 10 September 2026</p>

        <p>Manorama is a photo-gallery app at manorama.xyz. This page explains what we do and don't collect, and why.</p>

        <h2>The three kinds of people on Manorama</h2>
        <p>Manorama has three kinds of users. The rules are different for each:</p>
        <ol class="policy-participants">
          <li><strong>Mister Just Looking</strong> — anyone with a gallery link. No sign-in, no account, no data collected. You open a link, you see photos, that's it. We have no clue who you are. Why not write in to say hello?</li>
          <li><strong>Miss Can Touch</strong> — people who create and manage galleries. You sign in with Dropbox, you get up to three galleries, and we keep a small record of who you are so your galleries have a home.</li>
          <li><strong>Lord Will Pay</strong> (coming soon) — same sign-in, no gallery limit, richer customisation. The account tier column in our database already has a slot for this, but nobody is in it yet.</li>
        </ol>

        <h2>If you're Just Looking: we collect nothing</h2>
        <p>When someone shares a gallery link with you, you can open it without signing in. We don't set cookies on your device, we don't run analytics, we don't track page views, and we don't record who you are. Your browser asks our server for the page, our server fetches the photos from the gallery owner's Dropbox folder and passes them through — that's the entire interaction.</p>

        <h2>If you Can Touch: what we store and why</h2>
        <p>Signing in with Dropbox creates a small record about you in our database. Here's exactly what we keep, and why each piece exists:</p>
        <table class="policy-table">
          <thead><tr><th>What</th><th>Why</th></tr></thead>
          <tbody>
            <tr><td>Your Dropbox account ID</td><td>This is how we know it's you. It's an immutable identifier Dropbox assigns to your account — we never see your Dropbox password.</td></tr>
            <tr><td>Your display name</td><td>So we can greet you on your dashboard and credit you as the gallery owner.</td></tr>
            <tr><td>Your email (only if Dropbox has verified it)</td><td>So we can reach you if something goes wrong with your account or galleries. We only store it if Dropbox confirms it's real.</td></tr>
            <tr><td>Your chosen URL slug (e.g. <code>manorama.xyz/your-name</code>)</td><td>This is the public address for your galleries. You can change it anytime.</td></tr>
            <tr><td>Your account tier (<code>free</code>)</td><td>To enforce the three-gallery limit. When paid accounts arrive, this field will track that too.</td></tr>
          </tbody>
        </table>
        <p>We also store metadata about each gallery you create: the title, caption, the public Dropbox folder share URL, and a list of image filenames and dimensions. This lets us render your gallery without re-scanning your Dropbox folder on every visit.</p>

        <h2>We don't store your photographs</h2>
        <p>Manorama never copies, downloads, or caches your images. When a viewer opens your gallery, our server fetches each photo directly from your Dropbox shared folder and streams it to their browser on demand. The image data passes through our server but is never written to disk — image responses carry <code>no-store</code> cache headers. We store only the Dropbox folder share URL and image metadata (filenames, dimensions, alt text), never the pixels themselves.</p>

        <h2>Content Credentials (C2PA)</h2>
        <p>Some photographs carry embedded Content Credentials — provenance information that records how an image was created and whether it's been edited. If a photo has them, a viewer can verify them by clicking the logo at the bottom of the gallery. This verification happens entirely in the viewer's browser: the image is downloaded to their device and checked locally. The provenance data never goes to our server.</p>

        <h2>What we don't keep</h2>
        <ul>
          <li><strong>No Dropbox passwords.</strong> Dropbox handles authentication; we never see your password.</li>
          <li><strong>No Dropbox access tokens.</strong> We exchange the sign-in code for your account details and then discard the token. We don't keep long-lived access to your Dropbox.</li>
          <li><strong>No browsing history.</strong> We don't record which galleries you view or how long you spend on them.</li>
          <li><strong>No advertising cookies.</strong> There are none.</li>
        </ul>

        <h2>Third-party services</h2>
        <p>Two companies process data on Manorama's behalf:</p>
        <ul>
          <li><strong>Dropbox</strong> — handles sign-in and hosts the photos. When you sign in, Dropbox shares your account ID, name, and verified email with us. When a gallery is viewed, our server fetches images from the owner's Dropbox shared link. Dropbox's own privacy policy covers what they do on their side.</li>
          <li><strong>Cloudflare</strong> — hosts the app and handles web traffic. Cloudflare may log request metadata (like IP addresses and timestamps) as part of keeping the site online and protected from abuse. Cloudflare's privacy policy covers what they do on their side.</li>
        </ul>

        <h2>Your session</h2>
        <p>When you sign in, we place a cookie on your device that keeps you logged in for 7 days. The cookie contains only your Dropbox account ID, signed with a secret that lives on our server. It's not shared with anyone, and you can clear it anytime by signing out.</p>

        <h2>Data retention</h2>
        <p>Your account and gallery metadata stay until you ask us to delete them. There's no self-service delete button yet — write to us and we'll remove your account and all associated gallery metadata. Deleting your account does not touch your Dropbox files; it only removes your Manorama record.</p>

        <h2>We don't sell your data</h2>
        <p>We don't sell, rent, or share your personal data with anyone for advertising or commercial purposes. The only data that leaves our system goes to Dropbox (for sign-in and image fetching) and Cloudflare (for hosting), both of which are necessary to run the app.</p>

        <h2>Changes to this policy</h2>
        <p>If we change what we collect or how we use it, we'll update this page and bump the date at the top.</p>

        <h2>Contact</h2>
        <p>For privacy questions, feel free to reach out to app developer <a href="https://thecontrarian.in/#contact">Mahesh Shantaram</a>.</p>
      </article>
    </main>,
    { title: 'Privacy Policy — manorama', description: 'Manorama does not collect data from gallery viewers. Editor accounts store only a Dropbox ID, name, and gallery metadata. No images are stored.' },
  ),
)
