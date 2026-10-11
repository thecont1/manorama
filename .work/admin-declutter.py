"""Apply the owner's six admin de-clutter items to the native account screen.

Deterministic and re-runnable: every edit asserts its anchor first, so a
mismatch stops the script instead of writing a half-applied patch.
"""
from pathlib import Path
import sys

path = Path('native/islands/GalleryList.tsx')
s = path.read_text()
def apply(old: str, new: str, label: str) -> None:
    global s
    if old not in s:
        sys.exit(f'anchor missing: {label}')
    s = s.replace(old, new, 1)
    print('ok:', label)

# ── imports ────────────────────────────────────────────────────────────────
apply(
    "import { createGalleryFromQuickAdd, deleteAccount, fetchAccountGalleries, fetchAccountIdentities, fetchAccountOwnerSlug, fetchDeviceGalleries, fetchGallery, normalizeApiBase, renameOwnerSlug } from '../lib/api'",
    "import { createGalleryFromQuickAdd, deleteAccount, fetchAccountGalleries, fetchAccountIdentities, fetchAccountOwnerSlug, fetchDeviceGalleries, fetchGallery, normalizeApiBase, renameOwnerSlug, updateGalleryCaption } from '../lib/api'",
    'caption helper import',
)
apply(
    "import Viewer from '../../app/islands/Viewer'",
    "import Viewer from '../../app/islands/Viewer'\nimport GalleryEditor from './GalleryEditor'\nimport { CloseIcon, CopyIcon, OpenIcon, RefreshIcon, TrashIcon } from '../../app/components/admin-icons'",
    'editor and icon imports',
)

# ── state ──────────────────────────────────────────────────────────────────
apply(
    "  const [removeGallerySlug, setRemoveGallerySlug] = useState<string | null>(null)",
    "  const [removeGallerySlug, setRemoveGallerySlug] = useState<string | null>(null)\n"
    "  // The caption under a gallery's title. The draft is local to the card that\n"
    "  // opened it, so an abandoned edit never leaves the row it belongs to.\n"
    "  const [captionEditingSlug, setCaptionEditingSlug] = useState<string | null>(null)\n"
    "  const [captionDraft, setCaptionDraft] = useState('')\n"
    "  const [captionBusy, setCaptionBusy] = useState(false)\n"
    "  // The editor a card's cover opens: the gallery it resequences, resolved\n"
    "  // when the cover is tapped so the island owns its own read and write.\n"
    "  const [editorGallery, setEditorGallery] = useState<{ owner: string; slug: string; title: string } | null>(null)",
    'caption and editor state',
)

# ── helpers ────────────────────────────────────────────────────────────────
apply(
    "  const accountGalleryRow = (gallery: GallerySummary) => {",
    """  const saveGalleryCaption = async (gallery: GallerySummary, caption: string) => {
    if (captionBusy) return
    setCaptionBusy(true)
    setGalleryActionNote('Saving caption…')
    try {
      const stored = await updateGalleryCaption(base, gallery.slug, caption)
      setAccountGalleries((previous) => previous?.map((item) => (
        item.slug === gallery.slug ? { ...item, caption: stored } : item
      )) ?? null)
      setCaptionEditingSlug(null)
      setGalleryActionNote(stored ? 'Caption saved' : 'Caption cleared')
    } catch (reason) {
      setGalleryActionNote(reason instanceof Error ? reason.message : 'That caption could not be saved.')
    } finally {
      setCaptionBusy(false)
    }
  }
  const accountGalleryRow = (gallery: GallerySummary) => {""",
    'caption save helper',
)

# ── the card ───────────────────────────────────────────────────────────────
old_card = """  const accountGalleryRow = (gallery: GallerySummary) => {
    const cover = gallery.images[0]
    return (
      <>
        {/* The cover is its own opener so it can hold a column of the card
          across both text rows; the actions then sit beside the photograph
          instead of under the whole card on a narrow screen. */}
        {cover ? (
          <button
            type="button"
            class="native-gallery-cover-open"
            onClick={() => ownerSlug && openSelection(ownerSlug, gallery.slug)}
            disabled={!ownerSlug}
            aria-label={`Open ${gallery.title || gallery.slug}`}
          >
            <span class="native-gallery-cover-row" aria-hidden="true">
              <span class="native-gallery-thumb">
                <img
                  src={imagePreview(cover)}
                  width={cover.width}
                  height={cover.height}
                  alt=""
                  loading="lazy"
                  draggable={false}
                />
              </span>
            </span>
          </button>
        ) : null}
        <button
          type="button"
          class="native-gallery-row native-gallery-row-with-thumb"
          onClick={() => ownerSlug && openSelection(ownerSlug, gallery.slug)}
          disabled={!ownerSlug}
        >
        <span class="native-gallery-heading">
          <span class="native-gallery-title">{gallery.title || gallery.slug}</span>
          <span class="native-gallery-meta">({gallery.imageCount} {gallery.imageCount === 1 ? 'item' : 'items'})</span>
        </span>
        {accountGallerySubtitle(gallery) ? <span class="native-gallery-subtitle">{accountGallerySubtitle(gallery)}</span> : null}
        <span class="native-gallery-link">{accountGalleryLink(gallery)}</span>
        {gallery.retention === 'pipeline' ? <span class="native-account-note">Temporary gallery{gallery.expiresAt ? ` · expires ${gallery.expiresAt.slice(0, 10)}` : ''}</span> : null}
        </button>
      </>
    )
  }"""
new_card = """  const accountGalleryRow = (gallery: GallerySummary) => {
    const cover = gallery.images[0]
    const title = gallery.title || gallery.slug
    const caption = gallery.caption?.trim() ?? ''
    const captionEditing = captionEditingSlug === gallery.slug
    return (
      <>
        {/* The cover holds one column of the card across every text row, so the
          actions sit beside the photograph rather than under the whole card on
          a narrow screen. It opens the editor, not the gallery: the card is a
          management surface, and the title row is what opens the gallery. */}
        {cover ? (
          <button
            type="button"
            class="native-gallery-cover-open"
            onClick={() => ownerSlug && setEditorGallery({ owner: ownerSlug, slug: gallery.slug, title })}
            disabled={!ownerSlug}
            aria-label={`Edit the running order of ${title}`}
          >
            <span class="native-gallery-cover-row" aria-hidden="true">
              <span class="native-gallery-thumb">
                <img
                  src={imagePreview(cover)}
                  width={cover.width}
                  height={cover.height}
                  alt=""
                  loading="lazy"
                  draggable={false}
                />
              </span>
            </span>
          </button>
        ) : null}
        <button
          type="button"
          class="native-gallery-row native-gallery-row-with-thumb"
          onClick={() => ownerSlug && openSelection(ownerSlug, gallery.slug)}
          disabled={!ownerSlug}
        >
          <span class="native-gallery-heading">
            <span class="native-gallery-title">{title}</span>
            <span class="native-gallery-meta">({gallery.imageCount} {gallery.imageCount === 1 ? 'item' : 'items'})</span>
          </span>
          {gallery.retention === 'pipeline' ? <span class="native-account-note">Temporary gallery{gallery.expiresAt ? ` · expires ${gallery.expiresAt.slice(0, 10)}` : ''}</span> : null}
        </button>
        {captionEditing ? (
          <form
            class="native-gallery-caption-edit"
            onSubmit={(event) => { event.preventDefault(); void saveGalleryCaption(gallery, captionDraft) }}
          >
            <input
              id={`native-caption-${gallery.slug}`}
              type="text"
              value={captionDraft}
              maxLength={500}
              placeholder="Add a caption"
              aria-label={`Caption for ${title}`}
              onInput={(event) => setCaptionDraft((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => { if (event.key === 'Escape') setCaptionEditingSlug(null) }}
            />
            <button type="submit" disabled={captionBusy}>{captionBusy ? 'Saving…' : 'Save'}</button>
            <button type="button" disabled={captionBusy} onClick={() => setCaptionEditingSlug(null)}>Cancel</button>
          </form>
        ) : (
          <button
            type="button"
            class={`native-gallery-caption${caption ? '' : ' is-empty'}`}
            aria-label={caption ? `Edit the caption for ${title}` : `Add a caption to ${title}`}
            onClick={() => { setCaptionDraft(caption); setCaptionEditingSlug(gallery.slug) }}
          >
            {caption || 'Add a caption'}
          </button>
        )}
        <span class="native-gallery-link">{accountGalleryLink(gallery)}</span>
      </>
    )
  }"""
apply(old_card, new_card, 'card format')

# ── the actions: square icon buttons, as on the web ────────────────────────
old_actions = """                    <div class="native-gallery-actions" role="group" aria-label={`${gallery.title} actions`}>
                      <button type="button" aria-label={`Copy ${gallery.title} link`} onClick={() => void copyGalleryLink(gallery)}>Copy link</button>
                      {gallery.sourceUrl ? <button type="button" aria-label={`Open ${gallery.title} source`} onClick={() => openExternal(gallery.sourceUrl!)}>Open source</button> : null}
                      {gallery.sourceUrl ? <button type="button" aria-label={`Refresh ${gallery.title} from source`} disabled={galleryActionBusy !== null || gallery.retention === 'pipeline'} title={gallery.retention === 'pipeline' ? 'Temporary galleries cannot be edited on this plan' : 'Refresh from source'} onClick={() => void mutateGallery(gallery, 'refresh')}>Refresh</button> : null}
                      <button type="button" aria-label={`Delete ${gallery.title}`} disabled={galleryActionBusy !== null} onClick={() => setRemoveGallerySlug(gallery.slug)}>Delete</button>
                    </div>"""
new_actions = """                    {/* The same four square icon actions the web dashboard offers, so
                        one gallery is managed the same way on either surface. */}
                    <div class="native-gallery-actions" role="group" aria-label={`${gallery.title} actions`}>
                      <button type="button" title="Copy gallery link" aria-label={`Copy ${gallery.title} link`} onClick={() => void copyGalleryLink(gallery)}><CopyIcon /></button>
                      {gallery.sourceUrl ? <button type="button" title="Open the source folder" aria-label={`Open ${gallery.title} source`} onClick={() => openExternal(gallery.sourceUrl!)}><OpenIcon /></button> : null}
                      {gallery.sourceUrl ? <button type="button" title={gallery.retention === 'pipeline' ? 'Temporary galleries cannot be edited on this plan' : 'Refresh from source'} aria-label={`Refresh ${gallery.title} from source`} disabled={galleryActionBusy !== null || gallery.retention === 'pipeline'} onClick={() => void mutateGallery(gallery, 'refresh')}><RefreshIcon /></button> : null}
                      <button type="button" class="native-gallery-action--delete" title="Delete gallery" aria-label={`Delete ${gallery.title}`} disabled={galleryActionBusy !== null} onClick={() => setRemoveGallerySlug(gallery.slug)}><TrashIcon /></button>
                    </div>"""
apply(old_actions, new_actions, 'icon actions')

# ── the import form: the redundant line moves into the menu ────────────────
apply(
    """          <form onSubmit={importCloudGallery} aria-busy={quickAddBusy}>
            <label htmlFor="native-source-url">Public Dropbox, Google Drive, iCloud, or MEGA link</label>
            <input
              id="native-source-url"
              type="url"
""",
    """          <form onSubmit={importCloudGallery} aria-busy={quickAddBusy}>
            <input
              id="native-source-url"
              type="url"
              aria-label="Public Dropbox, Google Drive, iCloud, or MEGA link"
""",
    'import label removed',
)

# ── the drawer head ────────────────────────────────────────────────────────
apply(
    """          <div class="native-drawer-head">
            <h2>Account</h2>
            <button
              type="button"
              class="native-drawer-close"
              aria-label="Close account menu"
              onClick={closeAccountMenu}
            >
              ×
            </button>
          </div>""",
    """          <div class="native-drawer-head">
            {/* The brand sits exactly where it sits on the account page, so the
                menu reads as the page unfolding rather than a second surface
                arriving, and everything else starts below it. */}
            <div class="native-drawer-brand">
              <span class="brand-mark-wrap">
                <img
                  src="/manorama-merged-logo.png"
                  alt="manorama"
                  class="landing-brand-mark"
                />
                <span class="brand-tld" aria-hidden="true">.xyz</span>
              </span>
              <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
            </div>
            <button
              type="button"
              class="native-drawer-close"
              aria-label="Close account menu"
              onClick={closeAccountMenu}
            >
              <CloseIcon />
            </button>
          </div>
          <p class="native-drawer-hint">Add a gallery from a public Dropbox, Google Drive, iCloud, or MEGA link. Paste the folder or album link into the box on the main page and manorama will read it.</p>""",
    'drawer head brand',
)

# ── the editor overlay ─────────────────────────────────────────────────────
apply(
    """    {accountMenuOpen ? (
      <div class="native-drawer" id="native-account-drawer" data-account-drawer style={accountFoldStyle}>""",
    """    {editorGallery ? (
      <GalleryEditor
        owner={editorGallery.owner}
        slug={editorGallery.slug}
        title={editorGallery.title}
        apiBase={apiBase}
        onClose={() => setEditorGallery(null)}
        onSaved={() => setAccountRevision((revision) => revision + 1)}
      />
    ) : null}
    {accountMenuOpen ? (
      <div class="native-drawer" id="native-account-drawer" data-account-drawer style={accountFoldStyle}>""",
    'editor overlay',
)

path.write_text(s)
print('GalleryList.tsx written')