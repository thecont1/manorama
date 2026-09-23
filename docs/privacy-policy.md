# Privacy Policy

Last updated: 23 September 2026

Manorama is a photo-gallery app at manorama.xyz. This page explains what we do and don't collect, and why.

## The Users of Manorama

All kinds of people love and use Manorama. And they rise in three categories. The rules are different for each:

1. **Just Looking** — anyone with a gallery link. No sign-in, no account, no data collected. You open a gallery link, you get immersed in the experience. We have no clue who you are. Why not write in to say hello?

2. **Can Touch** — people who create and manage galleries. When you sign in with Dropbox, you get up to three editable galleries. Any further galleries that get added are available to you for 30 days and then removed unless you upgrade. We keep a small record of who you are so your galleries have a home.

3. **Will Pay** (coming soon) — same sign-in, up to 99 galleries, richer customisation, and the *Ask Manu* assistant.

## Just Looking: we collect nothing

When someone shares a gallery link with you, you can open it without signing in. We don't set cookies on your device, we don't run analytics, we don't track page views, and we don't record who you are. Your browser asks our server for the page, our server fetches the photos from the gallery owner's linked cloud folder and passes them through — that's the entire interaction.

One small exception to "we store nothing": if you change how a gallery looks — the layout, or whether photos get borders — your browser remembers that choice in its own local storage, keyed to that gallery. It is not a cookie, it never reaches our server, and we can't see it. Clearing your browser's site data forgets it entirely.

## Can Touch: what we store and why

Signing in with Dropbox creates a small record about you in our database. Here's exactly what we keep, and why each piece exists:

| What | Why |
|---|---|
| Your Dropbox account ID | This is how we know it's you. It's an immutable identifier Dropbox assigns to your account — we never see your Dropbox password. |
| Your display name | So we can greet you on your dashboard and credit you as the gallery owner. |
| Your email (only if Dropbox has verified it) | So we can reach you if something goes wrong with your account or galleries. We only store it if Dropbox confirms it's real. |
| Your chosen URL slug (e.g. `manorama.xyz/your-name`) | This is the public address for your galleries. You can change it anytime. |
| Your account tier (`free`) | To enforce gallery limits: free accounts keep 3 editable galleries plus temporary ones that expire after 30 days; paid accounts keep up to 99. |

We also store metadata about each gallery you create: the title, caption, the public link you pasted (Dropbox, Google Drive, iCloud, or MEGA), a list of media filenames and dimensions (photographs, and videos when an iCloud shared album contains them), and the gallery's retention state — whether it is retained or temporary, and if temporary, its expiry date. This lets us render your gallery without re-scanning the source folder on every visit.

Your browser also keeps your own preferences — the editor's light/dark theme, and per-gallery viewing choices — in its local storage. Like the viewer's, this never reaches our server.

## We don't store your photographs or videos

Manorama never copies, downloads, or caches your media. When a viewer opens your gallery, our server fetches each photograph — or, for an iCloud shared album containing video, each clip and its poster frame — directly from the linked source and streams it to their browser on demand. The media data passes through our server but is never written to disk; originals and video responses carry `no-store` cache headers. Video is proxied exactly like photographs: we never transcode it, never store it, and a seek simply forwards your browser's byte range to the source. We store only the source link and media metadata (filenames, dimensions, duration, alt text), never the pixels themselves.

## Content Credentials (C2PA)

Some photographs carry embedded Content Credentials — provenance information that records how an image was created and whether it's been edited. If a photo has them, a viewer can verify them by clicking the logo at the bottom of the gallery. This verification happens entirely in the viewer's browser: the image is downloaded to their device and checked locally. The provenance data never goes to our server.

## What we don't keep

- **No Dropbox passwords.** Dropbox handles authentication; we never see your password.
- **No Dropbox access tokens.** We exchange the sign-in code for your account details and then discard the token. We don't keep long-lived access to your Dropbox.
- **No browsing history.** We don't record which galleries you view or how long you spend on them.
- **No advertising cookies.** There are none.

## Third-party services

A few companies process data on Manorama's behalf:

- **Dropbox** — handles sign-in and may host the photos. When you sign in, Dropbox shares your account ID, name, and verified email with us. When a gallery is viewed, our server fetches images from the owner's public shared link. Dropbox's own privacy policy covers what they do on their side.
- **Google Drive, iCloud, and MEGA** — if a gallery's photos or videos live on one of these, our server fetches them from the owner's public link when the gallery is viewed. We never sign in to these services and share no account data with them; their privacy policies cover their side.
- **Cloudflare** — hosts the app and handles web traffic. Cloudflare may log request metadata (like IP addresses and timestamps) as part of keeping the site online and protected from abuse. Cloudflare's privacy policy covers what they do on their side.

## Your session

When you sign in, we place a cookie on your device that keeps you logged in for 7 days. The cookie contains only your Dropbox account ID, signed with a secret that lives on our server. It's not shared with anyone, and you can clear it anytime by signing out.

## Data retention

Galleries are yours to delete: the dashboard's delete action removes the gallery's Manorama record immediately, and nothing at the source is ever touched. Temporary galleries — the extra galleries a free account can hold beyond its three editable ones — are removed automatically at their deadline, 30 days after creation; the dashboard shows that deadline, and we send no emails or reminders before it arrives. Your account record itself stays until you ask us to delete it — there's no self-service delete button for the account yet — write to us and we'll remove your account and all associated gallery metadata. Deleting your account does not touch your Dropbox files; it only removes your Manorama record.

## Your rights (GDPR and friends)

Depending on where you live — the GDPR in the EU/UK, CCPA in California, and their equivalents elsewhere — you have the right to know what we hold about you, correct it, export it, or have it deleted. Our honest answer is that we hold very little: account owners have the small record described above, and visitors have nothing at all. Write to us and we'll show you, fix it, or erase it. We don't profile you, we don't make automated decisions about you, and we don't keep data longer than your account needs it.

## We don't sell your data

We don't sell, rent, or share your personal data with anyone for advertising or commercial purposes. The only data that leaves our system goes to Dropbox (for sign-in and image fetching), Google Drive, iCloud, and MEGA (for image fetching, when a gallery's photos live there), and Cloudflare (for hosting), all of which are necessary to run the app.

## Changes to this policy

If we change what we collect or how we use it, we'll update this page and bump the date at the top.

## Contact

For privacy questions, feel free to reach out to app developer [Mahesh Shantaram](https://thecontrarian.in/#contact).
