"""Apply the still-valid findings from the PR #117 review, minimally.

Every replacement asserts its anchor first: a script that rewrites source with
stale anchors is how a "small fix" quietly becomes a large one.
"""
from pathlib import Path

def patch(path, old, new, note, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'anchor missing in {path}: {note}')
    if s.count(old) != count:
        raise SystemExit(f'anchor not unique in {path} ({s.count(old)}): {note}')
    p.write_text(s.replace(old, new, count))
    print(f'ok: {path} — {note}')

# --- GlobalView: keep a gallery's vault entry ids when the online manifest is
# merged in, so saved thumbnails stay addressable offline ---------------------
patch(
    'native/islands/GlobalView.tsx',
    """        if (onlineGallery) {
          found = found.filter((gallery) => gallery.owner !== onlineGallery.selection.owner || gallery.slug !== onlineGallery.selection.slug)
          found.unshift({ galleryId: await offlineGalleryId(onlineGallery.selection), ...onlineGallery.selection, title: onlineGallery.manifest.title, frames: onlineGallery.manifest.images.map((image, index) => ({ id: image.id, entryId: '', mimeType: '', width: image.width, height: image.height, alt: image.alt, index })) })
        }""",
    """        if (onlineGallery) {
          // A cached copy of this same gallery already knows which vault entry
          // holds each photograph's saved bytes. Merging the online manifest
          // must not throw that away: a frame rebuilt with an empty entryId
          // reads as "never downloaded", which strands every saved thumbnail
          // the moment the network drops. Match by identity, keep what is
          // known, and let only genuinely new photographs start empty.
          const cached = found.find((gallery) => gallery.owner === onlineGallery.selection.owner && gallery.slug === onlineGallery.selection.slug)
          found = found.filter((gallery) => gallery !== cached)
          found.unshift({
            galleryId: cached?.galleryId ?? await offlineGalleryId(onlineGallery.selection),
            ...onlineGallery.selection,
            title: onlineGallery.manifest.title,
            frames: manifestFrames(onlineGallery.manifest.images, cached),
          })
        }""",
    'merge online frames onto the cached gallery',
)

patch(
    'native/islands/GlobalView.tsx',
    """        if (onlineGallery) {
          setGalleries([{ galleryId: 'online-current', ...onlineGallery.selection, title: onlineGallery.manifest.title, frames: onlineGallery.manifest.images.map((image, index) => ({ id: image.id, entryId: '', mimeType: '', width: image.width, height: image.height, alt: image.alt, index })) }])
        } else setLoadError(true)""",
    """        if (onlineGallery) {
          setGalleries([{ galleryId: 'online-current', ...onlineGallery.selection, title: onlineGallery.manifest.title, frames: manifestFrames(onlineGallery.manifest.images) }])
        } else setLoadError(true)""",
    'share the frame builder in the failure path',
)

patch(
    'native/islands/GlobalView.tsx',
    """export default function GlobalView({""",
    """/** The grid's frames for a manifest: the manifest's own order, carrying the
 *  vault entry and mime type of every photograph the cached gallery already
 *  knows. Dimensions, alt text and index always come from the manifest. */
const manifestFrames = (
  images: readonly GalleryMediaItem[],
  cached?: OfflineGridGallery,
): OfflineGridFrame[] => {
  const known = new Map((cached?.frames ?? []).map((frame) => [frame.id, frame]))
  return images.map((image, index) => {
    const saved = known.get(image.id)
    return {
      id: image.id,
      entryId: saved?.entryId ?? '',
      mimeType: saved?.mimeType ?? '',
      width: image.width,
      height: image.height,
      alt: image.alt,
      index,
    }
  })
}

export default function GlobalView({""",
    'add the manifest frame builder',
)

patch(
    'native/islands/GlobalView.tsx',
    """import type { GalleryManifest } from '../../app/lib/imagesource'""",
    """import type { GalleryManifest, GalleryMediaItem } from '../../app/lib/imagesource'""",
    'import the media item type the builder takes',
)

# --- GalleryList: a gallery with no title still names itself by slug ---------
patch(
    'native/islands/GalleryList.tsx',
    """const PRIVACY_URL = 'https://manorama.xyz/privacy'""",
    """/** What a gallery calls itself in labels and confirmations. The card shows
 *  the slug when a title is missing, and every control that speaks about the
 *  gallery says the same thing. */
const galleryName = (gallery: { title?: string; slug: string }): string =>
  gallery.title || gallery.slug

const PRIVACY_URL = 'https://manorama.xyz/privacy'""",
    'add the gallery name fallback',
)

for old, new, note in [
    ('aria-label={`${gallery.title} actions`}', 'aria-label={`${galleryName(gallery)} actions`}', 'name the action group'),
    ('aria-label={`Copy ${gallery.title} link`}', 'aria-label={`Copy ${galleryName(gallery)} link`}', 'name the copy action'),
    ('aria-label={`Open ${gallery.title} source`}', 'aria-label={`Open ${galleryName(gallery)} source`}', 'name the open action'),
    ('aria-label={`Refresh ${gallery.title} from source`}', 'aria-label={`Refresh ${galleryName(gallery)} from source`}', 'name the refresh action'),
    ('aria-label={`Delete ${gallery.title}`}', 'aria-label={`Delete ${galleryName(gallery)}`}', 'name the delete action'),
    ('role="group" aria-label={`Confirm removal of ${gallery.title}`}>', 'role="group" aria-label={`Confirm removal of ${galleryName(gallery)}`}>', 'name the removal confirmation'),
    ('<p>Remove “{gallery.title}” from manorama?', '<p>Remove “{galleryName(gallery)}” from manorama?', 'name the gallery in the confirmation copy'),
]:
    patch('native/islands/GalleryList.tsx', old, new, note)

# --- GalleryList: rapid per-gallery vault toggles must not race --------------
patch(
    'native/islands/GalleryList.tsx',
    """  const changeGalleryStreamOnly = async (enabled: boolean) => {
    const previous = galleryPolicies ?? {}
    const next = { ...previous, [selectedPolicyKey]: enabled }
    try {
      await saveGalleryStreamOnly(next)
      setGalleryPolicies(next)
    } catch { setVaultNote('This device preference could not be saved. Please try again.') }
  }""",
    """  /** The newest intent per gallery, which is what a queued write persists.
   *  State alone lags a tap by a render, and a write that reads it can land
   *  behind a newer choice. */
  const galleryPoliciesRef = useRef<Record<string, boolean>>({})
  const streamOnlyWrites = useRef(new Map<string, Promise<void>>())
  const changeGalleryStreamOnly = async (enabled: boolean) => {
    const key = selectedPolicyKey
    const before = galleryPoliciesRef.current[key] === true
    // Optimistic: the checkbox follows the tap immediately.
    const next = { ...galleryPoliciesRef.current, [key]: enabled }
    galleryPoliciesRef.current = next
    setGalleryPolicies(next)
    // One write in flight per gallery, each persisting the newest intent
    // rather than a snapshot of a moment that has already passed.
    const queued = (streamOnlyWrites.current.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => saveGalleryStreamOnly({ ...galleryPoliciesRef.current }))
      .catch(() => {
        // Step back only if nothing newer has been chosen since.
        if (galleryPoliciesRef.current[key] === enabled) {
          const rolledBack = { ...galleryPoliciesRef.current, [key]: before }
          galleryPoliciesRef.current = rolledBack
          setGalleryPolicies(rolledBack)
        }
        setVaultNote('This device preference could not be saved. Please try again.')
      })
    streamOnlyWrites.current.set(key, queued)
    await queued
  }""",
    'serialize the per-gallery vault preference writes',
)

patch(
    'native/islands/GalleryList.tsx',
    """  useEffect(() => { void loadGalleryStreamOnly().then(setGalleryPolicies) }, [])""",
    """  useEffect(() => {
    void loadGalleryStreamOnly().then((policies) => {
      galleryPoliciesRef.current = policies
      setGalleryPolicies(policies)
    })
  }, [])""",
    'seed the intent ref from the stored preferences',
)

# --- styles.css: the confirmation must not share the actions' grid row -------
patch(
    'native/styles.css',
    """.native-gallery-list li > .native-gallery-remove-confirm { grid-row: 6; }
.native-gallery-list li > .native-gallery-remove-confirm { grid-column: 1 / -1; grid-row: 5; }""",
    """.native-gallery-list li > .native-gallery-remove-confirm { grid-column: 1 / -1; grid-row: 6; }""",
    'drop the duplicate row override',
)

# --- reshoot-iphone.sh: honest capture state, no arbitrary process killed ----
patch(
    '.work/reshoot-iphone.sh',
    """REPO=/Users/home/DEV/tools/manorama
PORT=4181""",
    """REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CAPTURE_PORT:-4181}\"""",
    'derive the repository root and honour the capture port variable',
)

patch(
    '.work/reshoot-iphone.sh',
    """lsof -ti :$PORT | xargs -r kill -9 2>/dev/null || true
sleep 1
( cd "$REPO" && exec bun .work/capture-server.ts ) >/tmp/reshoot-capture-server.log 2>&1 &""",
    """# Never force-kill whatever happens to hold the port: it may be the owner's
# own server. Report it, and only ever stop the server this script started.
if lsof -ti :"$PORT" >/dev/null 2>&1; then
  echo "port $PORT is already in use; stop that process or set CAPTURE_PORT" >&2
  exit 1
fi
SERVER_LOG="$(mktemp /tmp/reshoot-capture-server.XXXXXX.log)"
( cd "$REPO" && exec bun .work/capture-server.ts ) >"$SERVER_LOG" 2>&1 &""",
    'refuse a busy port and log to a unique path',
)

patch(
    '.work/reshoot-iphone.sh',
    """  kill -0 "$SERVER_PID" 2>/dev/null || { echo "capture server died" >&2; tail -20 /tmp/reshoot-capture-server.log >&2; exit 1; }""",
    """  kill -0 "$SERVER_PID" 2>/dev/null || { echo "capture server died" >&2; tail -20 "$SERVER_LOG" >&2; exit 1; }""",
    'report failures from the log this run wrote',
)

patch(
    '.work/reshoot-iphone.sh',
    """shoot() { # <name> <settle seconds>
  sleep "$2"
  xcrun simctl io "$UDID" screenshot "$OUT/$1" >/dev/null 2>&1
  local dims
  dims="$(sips -g pixelWidth -g pixelHeight "$OUT/$1" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')"
  printf '  %-30s %s\\n' "$1" "$dims"
}""",
    """shoot() { # <name> <settle seconds>
  sleep "$2"
  # A capture that did not happen must report failure: a missing file that the
  # driver treats as captured is how a matrix silently loses a state.
  if ! xcrun simctl io "$UDID" screenshot "$OUT/$1" >/dev/null 2>&1; then
    rm -f "$OUT/$1"
    printf '  %-30s CAPTURE FAILED\\n' "$1" >&2
    return 1
  fi
  local dims
  dims="$(sips -g pixelWidth -g pixelHeight "$OUT/$1" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')"
  if [[ -z "$dims" ]]; then
    rm -f "$OUT/$1"
    printf '  %-30s CAPTURE UNREADABLE\\n' "$1" >&2
    return 1
  fi
  printf '  %-30s %s\\n' "$1" "$dims"
  return 0
}""",
    'fail the capture when the screenshot or its dimensions do not arrive',
)

patch(
    '.work/reshoot-iphone.sh',
    """  xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
  xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1
  for _ in $(seq 1 60); do""",
    """  xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
  xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || { echo "state $state could not launch" >&2; return 1; }
  for _ in $(seq 1 60); do""",
    'a state that will not launch is a failure',
)

patch(
    '.work/reshoot-iphone.sh',
    """log "01 opening screen (shipped bundle)"
xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$(prep_app "$PLAIN_APP")" >/dev/null 2>&1
xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1
shoot 01-opening-screen.png 5

log "harness states"
xcrun simctl install "$UDID" "$(prep_app "$HARNESS_APP")" >/dev/null 2>&1
failures=""
drive 0 02-gallery-curtain.png 1 || failures="$failures 02\"""",
    """failures=""
log "01 opening screen (shipped bundle)"
xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$(prep_app "$PLAIN_APP")" >/dev/null 2>&1 || { echo "the plain bundle could not be installed" >&2; exit 1; }
xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || { echo "the plain bundle could not be launched" >&2; exit 1; }
shoot 01-opening-screen.png 5 || failures="$failures 01"

log "harness states"
xcrun simctl install "$UDID" "$(prep_app "$HARNESS_APP")" >/dev/null 2>&1 || { echo "the harness bundle could not be installed" >&2; exit 1; }
drive 0 02-gallery-curtain.png 1 || failures="$failures 02\"""",
    'check the installs, launches and the first capture',
)

print('done')