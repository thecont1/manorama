# Manorama operations manual

This is the operator knowledge base for Manorama. It documents gallery
lifecycle, Dropbox expectations, slug policy, image ordering, Content
Credentials preservation, error recovery, and destructive-action policy.
When something is not covered here, say so plainly — never invent
procedures.

## Gallery lifecycle

A gallery moves through these states:

1. **Candidate** — a public Dropbox folder link has been scanned, and the
   image inventory and metadata are visible to the owner, but nothing is
   published.
2. **Published** — the gallery exists at `https://manorama.xyz/g/<slug>`
   and is publicly readable. Publication does not copy images; Manorama
   proxies Dropbox-hosted originals and derivative sizes on request.
3. **Stale** — the source Dropbox folder changed (files added, removed, or
   renamed) since the last refresh. A refresh reconciles the inventory.
4. **Deleted** — deletion removes the gallery record and its metadata.
   Original Dropbox files are never touched. Deletion is irreversible
   from the operator side; recovery requires recreating the gallery from
   the Dropbox link.

## Dropbox source expectations

- Only **public share links** to folders are accepted. Login-walled,
  password-protected, or app-folder links cannot be scanned.
- Accepted image formats: JPEG, PNG, WebP, and HEIC (HEIC is transcoded
  to JPEG derivatives for web display; the original is preserved).
- A folder may contain up to 10,000 images. Beyond that, scanning
  truncates and the gallery is marked with a `truncated` flag; split the
  folder before publishing.
- Nested subfolders are flattened into one gallery. The flattened order
  is deterministic (folder traversal order, then filename natural sort).
- Files without a recognizable image extension are ignored, not deleted.
- Video files are ignored today. Do not promise video support.

## Slug policy

- Slugs are lowercase, URL-safe: `a-z`, `0-9`, and hyphens; they start and
  end with an alphanum...[truncated]
