import { useState, type Child } from 'hono/jsx'
import GalleryDetailsView from '../../app/components/GalleryDetailsView'
import { Button } from '../../app/components/ui/Button'
import { Sheet } from '../../app/components/ui/Sheet'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import { deleteGallery, refreshGallery, updateGalleryMetadata } from '../lib/api'
import { sourceLabelFor } from '../lib/library-media'
import { nativeDeviceLabel } from '../lib/device-label'

type Props = {
  apiBase: string
  owner: string
  gallery: GallerySummary
  streamOnly: boolean
  vaultNote?: string
  vaultProgress?: { completed: number; total: number } | null
  hasSavedCopy: boolean
  backLabel?: string
  backAriaLabel?: string
  rail?: Child
  deviceStatus?: Child
  onBack: () => void
  onOpen: () => void
  onShare: () => void
  onReorder: () => void
  onStreamOnlyChange: (next: boolean) => void
  onChanged: (gallery: GallerySummary) => Promise<void>
  onRemoved: () => void
  onPurge: () => Promise<void>
}

/** Native command owner for Details. The shared view stays serializable and
 * web-reusable; every write here still goes through the session-gated API. */
export default function GalleryDetails({
  apiBase,
  owner,
  gallery,
  streamOnly,
  vaultNote,
  vaultProgress,
  hasSavedCopy,
  backLabel,
  backAriaLabel,
  rail,
  deviceStatus,
  onBack,
  onOpen,
  onShare,
  onReorder,
  onStreamOnlyChange,
  onChanged,
  onRemoved,
  onPurge,
}: Props) {
  const [editing, setEditing] = useState<'name' | 'caption' | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [confirmingPurge, setConfirmingPurge] = useState(false)
  const title = gallery.title || gallery.slug

  const saveMetadata = async () => {
    if (!editing || busy) return
    if (editing === 'name' && !draft.trim()) {
      setNote('A gallery title cannot be empty')
      return
    }
    setBusy('metadata')
    setNote(null)
    try {
      const stored = await updateGalleryMetadata(apiBase, gallery.slug, editing === 'name' ? { title: draft } : { caption: draft })
      await onChanged(stored)
      setEditing(null)
      setNote(editing === 'name' ? 'Name saved' : stored.caption ? 'Caption saved' : 'Caption cleared')
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : 'That metadata could not be saved')
    } finally {
      setBusy(null)
    }
  }

  const refresh = async () => {
    if (busy) return
    setBusy('refresh')
    setNote(null)
    try {
      const stored = await refreshGallery(apiBase, gallery.slug)
      await onChanged(stored)
      setNote('Read just now')
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : 'The folder could not be read again')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (busy) return
    setBusy('remove')
    setNote(null)
    try {
      await deleteGallery(apiBase, gallery.slug)
      onRemoved()
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : 'The gallery could not be removed')
      setBusy(null)
    }
  }

  const purge = async () => {
    if (busy) return
    setBusy('purge')
    setNote(null)
    try {
      await onPurge()
      setConfirmingPurge(false)
      setNote('Saved copy removed from this device')
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : 'The saved copy could not be removed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <GalleryDetailsView
        title={title}
        caption={gallery.caption ?? ''}
        address={`manorama.xyz/${owner}/${gallery.slug}`}
        imageCount={gallery.imageCount}
        sourceLabel={sourceLabelFor(gallery.sourceUrl)}
        temporary={gallery.retention === 'pipeline'}
        expiresAt={gallery.expiresAt}
        editable={gallery.retention === 'retained'}
        busy={busy !== null}
        note={note}
        streamOnly={streamOnly}
        vaultNote={vaultNote}
        vaultProgress={vaultProgress}
        hasSavedCopy={hasSavedCopy}
        deviceLabel={nativeDeviceLabel()}
        backLabel={backLabel}
        backAriaLabel={backAriaLabel}
        rail={rail}
        deviceStatus={deviceStatus}
        onBack={onBack}
        onOpen={onOpen}
        onShare={onShare}
        onEditName={() => { setDraft(title); setNote(null); setEditing('name') }}
        onEditCaption={() => { setDraft(gallery.caption ?? ''); setNote(null); setEditing('caption') }}
        onReorder={onReorder}
        onRefresh={() => void refresh()}
        onStreamOnlyChange={onStreamOnlyChange}
        onPurge={() => setConfirmingPurge(true)}
        onRemove={() => setConfirmingRemove(true)}
      />

      <Sheet
        open={editing !== null}
        onClose={() => { if (!busy) setEditing(null) }}
        title={editing === 'name' ? 'Gallery name' : 'Gallery caption'}
        dismissible={!busy}
        footer={(
          <Button variant="primary" block type="submit" form="m-gallery-metadata-form" disabled={busy !== null}>
            {busy === 'metadata' ? 'Saving…' : 'Save'}
          </Button>
        )}
      >
        <form id="m-gallery-metadata-form" class="m-form" onSubmit={(event) => { event.preventDefault(); void saveMetadata() }}>
          <label class="m-field">
            <span>{editing === 'name' ? 'Name' : 'Caption'}</span>
            {editing === 'name' ? (
              <input class="m-input" type="text" value={draft} maxLength={120} required disabled={busy !== null} onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)} />
            ) : (
              <textarea class="m-input m-input--textarea" value={draft} maxLength={500} rows={4} disabled={busy !== null} onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)} />
            )}
          </label>
        </form>
      </Sheet>

      <Sheet open={confirmingPurge} onClose={() => { if (!busy) setConfirmingPurge(false) }} title={`Remove the saved copy of “${title}”?`} dismissible={!busy}>
        <p>This removes the encrypted copy from this device. The gallery and every original at its source remain.</p>
        <div class="m-form-inline">
          <Button variant="destructive" disabled={busy !== null} onClick={() => void purge()}>{busy === 'purge' ? 'Removing…' : 'Remove saved copy'}</Button>
          <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirmingPurge(false)}>Cancel</Button>
        </div>
      </Sheet>

      <Sheet open={confirmingRemove} onClose={() => { if (!busy) setConfirmingRemove(false) }} title={`Remove “${title}”?`} dismissible={!busy}>
        <p>This removes the gallery from manorama. Originals remain at their source; this cannot be undone.</p>
        <div class="m-form-inline">
          <Button variant="destructive" disabled={busy !== null} onClick={() => void remove()}>{busy === 'remove' ? 'Removing…' : 'Remove gallery'}</Button>
          <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirmingRemove(false)}>Cancel</Button>
        </div>
      </Sheet>
    </>
  )
}
