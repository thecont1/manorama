# Original-media fidelity

Status: evidence-backed implementation labels, not a blanket claim of C2PA validity or live byte-identity for every provider.

Every scanner labels `fidelity` and `thumbnailFidelity` independently. `original` means the selected media path returns the provider's original bytes (or decrypts those bytes without re-encoding). It does not assert that a valid C2PA manifest exists. `full-resolution-render` is Apple's rendered still; `display-derivative` is a thumbnail or video transcode.

| Provider | Stage original | Thumbnail | Evidence and limits |
| --- | --- | --- | --- |
| Dropbox | `original` | `display-derivative` | `sharing/get_shared_link_file` streams the raw file response. The `w256h256` JPEG is used only as a rendition. No pixel transform occurs in the proxy. |
| Google Drive | `original` | `display-derivative` | Drive v3 `files/{id}?alt=media` streams the file. Drive thumbnails are separate derivatives. |
| MEGA | `original` | `display-derivative` | AES-128-CTR decryption restores the uploaded bytes; no codec operation follows. Whole-file retrieval verifies the uploader's meta-MAC (a chained CBC-MAC over the upload chunks, expected value carried in the file key's last 8 bytes); a mismatch is rejected rather than served. Ranged reads are partial reads — see below. FIPS/AES and synthetic folder/collection tests exercise the client path. Per-item content versions are opaque SHA-256 digests of `{h,s,ts,fa}`, not size/timestamp disclosures. |
| Ente | `original` | `display-derivative` | Public album originals are decrypted client-side; preview and original requests stay separate. See the Ente protocol evidence and its live-verification caveats. |
| iCloud CloudKit | `original` when `resOriginalRes` exists, including HEIC; otherwise `full-resolution-render` | `display-derivative` | CloudKit CPLMaster records select `resOriginalRes` whenever present. Missing originals fall back to the largest JPEG and are labelled honestly. HEIC filenames retain `.heic` so the existing client decoder runs. |
| iCloud legacy sharedstreams | `full-resolution-render` | `display-derivative` | Apple's legacy web album exposes roughly 2048px JPEG renders, not original assets. Upgrading a legacy album cannot restore bytes Apple never supplied. |
| Local desktop source | `original` | `display-derivative` | The original file is read from the local source. Development thumbnails may be WebP; they never replace the stage original. |
| Video | `original` only for an original file/`resOriginalRes`; otherwise `display-derivative` | `display-derivative` | Shared-album MP4 transcodes and posters are not represented as originals. Range streaming does not alter bytes. |

## Byte and provenance evidence

- Synthetic AES vectors and scanner fixtures prove the MEGA decrypt path returns the expected plaintext; they are not live CDN byte comparisons.
- MEGA integrity verification is defined for whole-file retrieval only. The meta-MAC chains per-chunk MACs across the complete upload, so a ranged (partial) read — a `Range` request answered 206, or the scanner's 64KB dimensions probe — fetches a CTR-aligned window, decrypts it, and serves it unverified. Partial reads are bounded by `MAX_FILE_BYTES` for sizing, cannot assert full-file integrity, and must not be represented as verified; the `original` label rests on the whole-file path.
- CloudKit fixture tests prove original-field selection, HEIC selection, and derivative fallback. They do not prove byte identity against a rights-cleared physical-device library.
- Existing proxy tests exercise streamed responses, range headers, and unchanged response bodies. No server codec/recompression stage exists in these paths.
- No rights-cleared real MEGA, Ente, and Apple fixture set was available in this checkout. Live byte-identity claims for those providers remain explicitly unverified. A release claim requires SHA-256 comparisons between provider originals and client materialization for JPEG, HEIC, panorama, and C2PA-bearing samples.

## Boundary

Only the encrypted media working set holds plaintext in browser/native memory, under reference counting and byte caps. Native offline persistence remains inside the AES-GCM vault. Server responses are transient streams; no original, thumbnail, or decrypted derivative is written to D1, R2, KV, Cache API, CDN, or object storage.
