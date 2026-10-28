import { useState } from 'hono/jsx'
import GalleryEditSheet from '../../app/components/GalleryEditSheet'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'
import { Button } from '../../app/components/ui/Button'
import { Sheet } from '../../app/components/ui/Sheet'
import { TopBar } from '../../app/components/ui/TopBar'
import type { GalleryAvailability, LocalGalleryRecord } from '../lib/catalogue'

/** The only operations that can be in flight; one at a time. */
type BusyOp = 'rename' | 'rescan' | 'remove'

type Props = {
  record: LocalGalleryRecord
  availability: GalleryAvailability
  onBack: () => void
  onOpen: () => void
  onShare: () => void
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

/** Full-screen local gallery details. Purely presentational: it states
 *  capabilities and emits intent; the catalogue container owns the actual
 *  rescan/rename/remove commands and the persistence that comes with them.
 *  The record's root path, mount point, and file list never appear here —
 *  they are local-only by contract and stay out of the surface. */
export default function LocalGalleryDetails({
  record,
  availability,
  onBack,
  onOpen,
  onShare,
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
    <main class="m-owner m-screen m-screen--fixed" data-screen="local-details">
      <TopBar
        title={record.title}
        logo={false}
        start={<Button variant="quiet" aria-label="Back" onClick={onBack}>‹ Back</Button>}
      />
      <div class="m-owner-content">
        <header class="m-owner-heading">
          <h1>{record.title}</h1>
          <p class="m-note">
            {record.itemCount} {record.itemCount === 1 ? 'photograph' : 'photographs'} · {sourceLabel(record)}
          </p>
          <p class="m-note" role="status" data-availability={availability}>
            {unavailable ? 'Unavailable — reconnect the source, then rescan.' : 'Source available'}
          </p>
        </header>

        <ActionGroup label="Open">
          <ActionRow label="Open" onClick={onOpen} disabled={unavailable || locked} />
          <ActionRow label="Publish/Share" onClick={onShare} disabled={unavailable || locked} />
        </ActionGroup>

        <ActionGroup label="Gallery">
          <ActionRow label="Name" value={record.title} onClick={startRename} disabled={locked} />
          <ActionRow label="Read folder again" onClick={() => void rescan()} disabled={locked} />
        </ActionGroup>

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
      </div>

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
        <div class="m-form-inline">
          <Button variant="destructive" disabled={locked} onClick={() => void remove()}>
            {busy === 'remove' ? 'Removing…' : 'Remove from Library'}
          </Button>
          <Button variant="secondary" disabled={locked} onClick={() => setConfirmingRemove(false)}>Cancel</Button>
        </div>
      </Sheet>
    </main>
  )
}
