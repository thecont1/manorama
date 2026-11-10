import { useState } from 'hono/jsx'
import GalleryEditSheet from '../../app/components/GalleryEditSheet'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'
import { Button } from '../../app/components/ui/Button'
import { Sheet } from '../../app/components/ui/Sheet'
import type { GalleryAvailability, LocalGalleryRecord } from '../lib/catalogue'

/** The only operations that can be in flight; one at a time. */
type BusyOp = 'rename' | 'rescan' | 'remove'

type Props = {
  record: LocalGalleryRecord
  availability: GalleryAvailability
  onOpen: () => void
  /** The public link, only once this record's synced row carries a slug.
   *  Its presence is what makes "Share link" truthful instead of "Publish". */
  publishedUrl?: string | null
  /** Shares the existing link — never re-uploads. Resolves to the status
   *  line the surface shows, or null when the owner cancelled. */
  onShareLink?: () => Promise<string | null>
  onShare: () => void
  /** Opens the viewer's picker straight into Edit mode — the same place
   *  an account gallery's "Reorder photographs" row lands. */
  onReorder?: () => void
  onRescan: () => void | Promise<void>
  onRename: (title: string) => void | Promise<void>
  onRemove: () => void | Promise<void>
}

/** The source is named by kind — the path itself is local-only and never
 *  rendered. A mounted card is a "Memory card"; anything else is a folder on
 *  this Mac. */
const sourceLabel = (record: LocalGalleryRecord): string =>
  record.sourceKind === 'card' ? 'Memory card' : 'Folder on this Mac'

const messageFor = (reason: unknown, fallback: string): string =>
  reason instanceof Error ? reason.message : fallback

/** A local gallery's settings — the same Sheet panel an account gallery's
 *  settings hosts (`m-owner-panel` + ActionGroup rows), so the three-dots
 *  menu reads identically whichever card it came from. Purely
 *  presentational: it states capabilities and emits intent; the catalogue
 *  container owns the rescan/rename/remove commands and the persistence
 *  that comes with them. The record's root path, mount point, and file
 *  list never appear here — they are local-only by contract and stay out
 *  of the surface. */
export default function LocalGalleryDetails({
  record,
  availability,
  onOpen,
  publishedUrl = null,
  onShareLink,
  onShare,
  onReorder,
  onRescan,
  onRename,
  onRemove,
}: Props) {
  const unavailable = availability === 'unavailable'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<BusyOp | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editNote, setEditNote] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const locked = busy !== null

  const startRename = () => {
    setDraft(record.title)
    setEditNote(null)
    setEditing(true)
  }

  const rename = async (title: string) => {
    if (locked) return
    setBusy('rename')
    setEditNote(null)
    try {
      await onRename(title)
      setEditing(false)
      setNote('Name saved')
    } catch (reason) {
      // The sheet stays open so the draft survives; the reason shows inside it.
      setEditNote(messageFor(reason, 'That name could not be saved'))
    } finally {
      setBusy(null)
    }
  }

  const shareLink = async () => {
    if (locked || !onShareLink) return
    const status = await onShareLink()
    if (status) setNote(status)
  }

  const rescan = async () => {
    if (locked) return
    setBusy('rescan')
    setNote(null)
    try {
      await onRescan()
      setNote('Read just now')
    } catch (reason) {
      setNote(messageFor(reason, 'The folder could not be read again'))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (locked) return
    setBusy('remove')
    setNote(null)
    try {
      await onRemove()
      // Success dismisses the sheet; the container removes the record.
      setConfirmingRemove(false)
    } catch (reason) {
      setNote(messageFor(reason, 'The gallery could not be removed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div class="m-owner-panel" data-screen="local-details">
      {/* The same head an account gallery's settings panel shows: title once,
          then concise source metadata. The availability line is local-only —
          a detached source has no web analogue, so it stays its own line
          rather than pretending parity. */}
      <header class="m-owner-panel-head">
        <div class="m-owner-panel-title">{record.title}</div>
        <p class="m-owner-panel-meta">
          {record.itemCount} {record.itemCount === 1 ? 'photograph' : 'photographs'} · {sourceLabel(record)}
        </p>
        <p class="m-note" role="status" data-availability={availability}>
          {unavailable ? 'Unavailable — reconnect the source, then rescan.' : 'Source available'}
        </p>
      </header>

      <ActionGroup label="Open">
        <ActionRow label="Open gallery" onClick={onOpen} disabled={unavailable || locked} />
        {/* Publish means uploading originals to create the public gallery;
            once a usable link exists the action is sharing that link, not
            publishing again. */}
        {publishedUrl && onShareLink ? (
          <ActionRow
            label="Share link"
            value={`…/${publishedUrl.split('/').at(-1)}`}
            onClick={() => void shareLink()}
            disabled={locked}
          />
        ) : (
          <ActionRow label="Publish" onClick={onShare} disabled={unavailable || locked} />
        )}
      </ActionGroup>

      <ActionGroup label="Gallery">
        <ActionRow label="Name" value={record.title} onClick={startRename} disabled={locked} />
        <ActionRow label="Refresh gallery contents" onClick={() => void rescan()} disabled={locked} />
      </ActionGroup>

      {onReorder ? (
        <ActionGroup>
          <ActionRow label="Reorder photographs" onClick={onReorder} disabled={unavailable || locked} />
        </ActionGroup>
      ) : null}

      {note ? <p class="m-note" role="status">{note}</p> : null}

      <ActionGroup label="Remove">
        <ActionRow
          label="Remove from Library"
          value="Originals stay on this Mac"
          tone="destructive"
          onClick={() => setConfirmingRemove(true)}
          disabled={locked}
        />
      </ActionGroup>

      <GalleryEditSheet
        open={editing}
        field="name"
        value={draft}
        busy={busy === 'rename'}
        note={editNote}
        onValueChange={setDraft}
        onSubmit={(value) => void rename(value)}
        onClose={() => { if (!locked) setEditing(false) }}
      />

      <Sheet
        open={confirmingRemove}
        onClose={() => { if (!locked) setConfirmingRemove(false) }}
        title={`Remove “${record.title}”?`}
        dismissible={!locked}
      >
        <p>This removes only the catalogue entry for “{record.title}”. The original files on the memory card or folder are untouched.</p>
        {note ? <p class="m-note" role="alert">{note}</p> : null}
        <div class="m-form-inline">
          <Button variant="destructive" disabled={locked} onClick={() => void remove()}>
            {busy === 'remove' ? 'Removing…' : 'Remove from Library'}
          </Button>
          <Button variant="secondary" disabled={locked} onClick={() => setConfirmingRemove(false)}>Cancel</Button>
        </div>
      </Sheet>
    </div>
  )
}
