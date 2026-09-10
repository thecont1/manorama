# Privacy Policy

Last updated: 10 September 2026

Manorama is a photo-gallery app at manorama.xyz. This page explains what we
do and don't collect, and why.

## The three kinds of people on Manorama

Manorama has three participants, and the rules are different for each:

1. **Just Looking** — anyone with a gallery link. No sign-in, no account,
   no data collected. You open a link, you see photos, that's it.

2. **Can Touch** — people who create and manage galleries. You sign in
   with Dropbox, you get up to three galleries, and we keep a small
   record of who you are so your galleries have a home.

3. **Will Pay** (coming soon) — same sign-in, no gallery limit, richer
   customisation. The account tier column in our database already has a
   slot for this, but nobody is in it yet.

## If you're Just Looking: we collect nothing

When someone shares a gallery link with you, you can open it without
signing in. We don't set cookies on your device, we don't run analytics,
we don't track page views, and we don't record who you are. Your browser
asks our server for the page, our server fetches the photos from the
gallery owner's Dropbox folder and passes them through — that's the
entire interaction.

## If you Can Touch: what we store and why

Signing in with Dropbox creates a small record about you in our database.
Here's exactly what we keep, and why each piece exists:

| What | Why |
|---|---|
| Your Dropbox account ID | This is how we know it's you. It's an immutable identifier Dropbox assigns to your account — we never see your Dropbox password. |
| Your display name | So we can greet you on your dashboard and credit you as the gallery owner. |
| Your email (only if Dropbox has verified it) | So we can reach you if something goes wrong with your account or galleries. We only store it if Dropbox confirms it's real. |
| Your chosen URL slug (e.g. `manorama.xyz/your-name`) | This is the public address for your galleries. You can change it anytime. |
| Your account tier (`free`) | To enforce the three-gallery limit. When paid accounts arrive, this field will track that too. |

We also store metadata about each gallery you create: the title, caption,
the public Dropbox folder share URL, and a list of image filenames and
dimensions. This lets us render your gallery without re-scanning your
Dropbox folder on every visit.

## We don't store your photographs

Manorama never copies, downloads, or caches your images. When a viewer
opens your gallery, our server fetches each photo directly from your
Dropbox shared folder and streams it to their browser on demand. The
image data passes through our server but is never written to disk — image
responses carry `no-store` cache headers. We store only the Dropbox folder
share URL and image metadata (filenames, dimensions, alt text), never the
pixels themselves.

## Content Credentials (C2PA)

Some photographs carry embedded Content Credentials — provenance
information that records how an image was created and whether it's been
edited. If a photo has them, a viewer can verify them by clicking the logo
at the bottom of the gallery. This verification happens entirely in the
viewer's browser: the image is downloaded to their device and checked
locally. The provenance data never goes to our server.

## What we don't keep

- **No Dropbox passwords.** Dropbox handles authentication; we never see
  your password.
- **No Dropbox access tokens.** We exchange the sign-in code for your
  account details and then discard the token. We don't keep long-lived
  access to your Dropbox.
- **No browsing history.** We don't record which galleries you view or
  how long you spend on them.
- **No advertising cookies.** There are none.

## Third-party services

Two companies process data on Manorama's behalf:

- **Dropbox** — handles sign-in and hosts the photos. When you sign in,
  Dropbox shares your account ID, name, and verified email with us. When
  a gallery is viewed, our server fetches images from the owner's
  Dropbox shared link. Dropbox's own privacy policy covers what they do
  on their side.
- **Cloudflare** — hosts the app and handles web traffic. Cloudflare may
  log request metadata (like IP addresses and timestamps) as part of
  keeping the site online and protected from abuse. Cloudflare's privacy
  policy covers what they do on their side.

## Your session

When you sign in, we place a cookie on your device that keeps you logged
in for 7 days. The cookie contains only your Dropbox account ID, signed
with a secret that lives on our server. It's not shared with anyone, and
you can clear it anytime by signing out.

## Data retention

Your account and gallery metadata stay until you ask us to delete them.
There's no self-service delete button yet — write to us and we'll remove
your account and all associated gallery metadata. Deleting your account
does not touch your Dropbox files; it only removes your Manorama record.

## We don't sell your data

We don't sell, rent, or share your personal data with anyone for
advertising or commercial purposes. The only data that leaves our system
goes to Dropbox (for sign-in and image fetching) and Cloudflare (for
hosting), both of which are necessary to run the app.

## Changes to this policy

If we change what we collect or how we use it, we'll update this page and
bump the date at the top.

## Contact

For privacy questions or data deletion requests, reach us through the
contact information on the manorama.xyz landing page.
