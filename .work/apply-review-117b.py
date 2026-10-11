"""Apply the second PR #117 review's still-valid findings, minimally."""
from pathlib import Path

def patch(path, old, new, note, count=1):
    p = Path(path)
    s = p.read_text()
    if s.count(old) != count:
        raise SystemExit(f'anchor problem in {path} ({s.count(old)}): {note}')
    p.write_text(s.replace(old, new, count))
    print(f'ok: {path} — {note}')

# --- 1. reshoot: a half-filled dimension string is not a successful capture --
patch(
    '.work/reshoot-iphone.sh',
    """  if [[ -z "$dims" ]]; then
    rm -f "$OUT/$1"
    printf '  %-30s CAPTURE UNREADABLE\\n' "$1" >&2
    return 1
  fi""",
    """  # awk prints "x" when either field is missing, so the shape is checked and
  # both numbers have to be there: a malformed size is a failed capture, not a
  # success with an odd label.
  if [[ ! "$dims" =~ ^[0-9]+x[0-9]+$ ]]; then
    rm -f "$OUT/$1"
    printf '  %-30s CAPTURE UNREADABLE (%s)\\n' "$1" "${dims:-no dimensions}" >&2
    return 1
  fi""",
    'reject a half-filled dimension string',
)

# --- 2. GlobalView: a saved frame is served from the vault, not the network ---
patch(
    'native/islands/GlobalView.tsx',
    """                    remoteSrc={gallery.owner === onlineGallery?.selection.owner && gallery.slug === onlineGallery?.selection.slug ? (() => {
                      const image = onlineGallery.manifest.images[frame.index]
                      return isVideoItem(image) ? image.poster.src : image.variants?.[0]?.src ?? image.src
                    })() : undefined}""",
    """                    // A frame with saved bytes belongs to the vault; the
                    // remote URL is a preview for the ones with none, so an
                    // online-looking grid never quietly replaces an offline
                    // copy — and never pulls a full-size source for it.
                    remoteSrc={gallery.owner === onlineGallery?.selection.owner && gallery.slug === onlineGallery?.selection.slug && !frame.entryId ? (() => {
                      const image = onlineGallery.manifest.images[frame.index]
                      return isVideoItem(image) ? image.poster.src : image.variants?.[0]?.src ?? image.src
                    })() : undefined}""",
    'only preview frames with no saved bytes',
)

patch(
    'native/islands/GlobalView.tsx',
    """      {url || remoteSrc ? (
        <img src={url ?? remoteSrc} width={frame.width} height={frame.height} alt={frame.alt} draggable={false} />""",
    """      {url || remoteSrc ? (
        <img
          src={url ?? remoteSrc}
          width={frame.width}
          height={frame.height}
          alt={frame.alt}
          // A remote preview is fetched as the grid reaches it; the vault's
          // own bytes are already on the device and stay eager.
          loading={url ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
        />""",
    'lazy-load the remote previews',
)

print('done')