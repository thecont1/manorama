# Native local compute

Issue #42 adds a native-only, vault-backed local-compute seam. It is deliberately separate from the web gallery: the browser viewer does not gain persistence or local analysis capabilities.

## What is computed

`native/lib/local-compute.ts` currently computes three deterministic artifacts from ephemeral decoded RGBA pixels:

- A 64-bit low-frequency DCT perceptual hash for near-duplicate grouping.
- A normalized `8 × 8 × RGB` `pixel-grid-v1` embedding. This is an explicit model-free baseline, not a claim of semantic understanding or a trained neural embedding.
- Non-destructive sequencing suggestions that compare the current next frame with a materially closer candidate in the local embedding space.

The module also exposes `findSimilarFrames` for a future native “find frames like this” interaction and `readImageFeatures` for reading one encrypted feature record.

## Privacy and memory boundary

- The input image bytes are read from the existing encrypted native cache and decoded on-device.
- The leased pixel buffer (`lease.pixels`) is zeroed before its lease is released, including when feature extraction or vault persistence fails; decoder-owned buffers are outside this guarantee.
- Only compact feature records are persisted, through `EncryptedVault.write`, under `local-compute:v1:<stable-image-id>`.
- No image bytes, thumbnails, vectors, or feature records are sent to the Worker.
- The existing gallery order is never changed. Suggestions are returned as reviewable alternatives.
- The compute pass yields to the host between frames and is started after cache readiness, so opening a gallery does not wait for analysis.

## Extension seam

`computeCachedGallery` adapts the existing encrypted-cache entries to the compute engine. The browser-native decoder uses `createImageBitmap` where available and falls back to an `Image` plus canvas decode in WebKit shells. A future native model can replace the feature implementation behind the versioned record while retaining the vault and query contracts.

This slice intentionally does not present an automatic “collapse duplicates” or “rewrite my sequence” control. Those actions need curator-facing review UI and explicit acceptance before they can affect a gallery.
