# Manorama operations manual

This is the operator knowledge base for Manorama. It documents gallery
lifecycle, source-link expectations, slug policy, image ordering, Content
Credentials preservation, error recovery, and destructive-action policy.
When something is not covered here, say so plainly — never invent
procedures.

## Gallery lifecycle

A gallery moves through these states:

1. **Candidate** — a public source link (Dropbox folder, Google Drive
   folder, or iCloud shared album) has been scanned, and the image
   inventory and metadata are visible to the owner, but nothing is
   published.
2. **Published** — the gallery exists at `https://manorama.xyz/g/<slug>`
   and is publicly readable. Publication does not copy images; Manorama
   proxies source-hosted originals and derivative sizes on request.
3. **Stale** — the source folder or album changed (files added, removed,
   or renamed) since the last refresh. A refresh reconciles the inventory.
4. **Deleted** — deletion removes the gallery record and its metadata.
   Original source files are never touched. Deletion is irreversible
   from the operator side; recovery requires recreating the gallery from
   the source link.

## Source link expectations

- Only **public share links** are accepted. Login-walled or
  password-protected links cannot be scanned.
- Three providers are recognized: Dropbox shared folders
  (`dropbox.com/scl/fo/…` or `/sh/…`), Google Drive folders shared with
  "Anyone with the link" (`drive.google.com/drive/folders/…`), and iCloud
  shared albums (`icloud.com/sharedalbum/#…`, `share.icloud.com/photos/…`).
- Dropbox and Google Drive deliver originals (C2PA preserved; HEIC is
  transcoded to JPEG renditions for web display). iCloud shared albums
  serve web-optimized JPEG derivatives only — ~2048px maximum, no
  originals, no Content Credentials.
- iCloud support rides Apple's undocumented shared-album web endpoints
  and can break without notice; treat iCloud galleries as best-effort.
- Accepted image formats: JPEG, WebP, TIFF, and HEIC.
- Only the top level of a folder is scanned; subfolders are not
  descended into.
- Files that are not images are ignored, not deleted.
- Video files are ignored today. Do not promise video support.

## Slug policy

- Slugs are lowercase, URL-safe: `a-z`, `0-9`, and hyphens; they start and
  end with an alphanum...[truncated]
