import { useState } from 'hono/jsx'
import GalleryEditSheet from '../../app/components/GalleryEditSheet'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'
import { Button } from '../../app/components/ui/Button'
import { Sheet } from '../../app/components/ui/Sheet'
import { GALLERY_ROWS } from '../../app/components/GalleryDetailsView'
import type { GalleryAvailability, LocalGalleryRecord } from '../lib/catalogue'

/** The only operations that can be in flight; one at a time. */
type BusyOp = 'edit' | 'refresh' | 'remove'
type EditField = 'name' | 'caption'

type Props = {
  record: LocalGalleryRecord
  availability: GalleryAvailability
  onOpen: () => void
  onRename: (title: string) => void | Promise<void>
  onRemove: () => void | Promise<void>
  /** "View source" for a local record — reveals the gallery's folder in
   *  Finder. */
  onRevealFolder?: () => void
  /** Caption edit — the shared edit sheet's caption field, persisted
   *  on the record like the name. */
  onCaption?: (caption: string) => void | Promise<void>
  /** The public address once this Mac's synced row is published —
   *  display only; the publish flow owns the slug. */
  publishedUrl?: string | null
  /** The Address row's destination — the publish/share flow. */
  onPublish?: () => void
  /** Opens the picker's Edit mode on this record — the local
   *  counterpart of the cloud panel's Reorder row. */
  onReorder?: () => void
  /** Rescans the source — the same command the card menu's Refresh
   *  gallery runs. */
  onRefresh?: () => void | Promise<void>
}

/** The source is named by kind — the path itself is local-only and never
 *  rendered. A mounted card is a "Memory card"; anything else is a folder on
 *  this Mac. */
const sourceLabel = (record: LocalGalleryRecord): string =>
  record.sourceKind === 'card' ? 'Memory card' : 'Folder on this Mac'

const messageFor = (reason: unknown, fallback: string): string =>
  reason instanceof Error ? reason.message : fallback

/** The public link reads owner/slug like the cloud panel's Address row —
 *  the origin is always manorama.xyz and adds nothing. */
const addressLabel = (publishedUrl: string): string =>
  publishedUrl.replace(/^https?:\/\/[^/]+\//, '')

/** A local gallery's settings — the same Sheet panel an account gallery's
 *  settings hosts (`m-owner-panel` + ActionGroup rows), carrying the same
 *  groups in the same order so the three-dots menu reads identically
 *  whichever card it came from. Purely presentational: it states
 *  capabilities and emits intent; the catalogue container owns the
 *  rename/caption/remove/rescan commands and the persistence that comes
 *  with them. The record's root path, mount point, and file list never
 *  appear here — they are local-only by contract and stay out of the
 *  surface. There is no on-device group: a local gallery's files already
 *  live on this Mac. */
export default function LocalGalleryDetails({
  record,
  availability,
  onOpen,
  onRename,
  onRemove,
  onRevealFolder,
  onCaption,
  publishedUrl,
  onPublish,
  onReorder,
  onRefresh,
}: Props) {
  const unavailable = availability === 'unavailable'
  const [editing, setEditing] = useState<EditField | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<BusyOp | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editNote, setEditNote] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const locked = busy !== null

  const startEdit = (field: EditField) => {
    setDraft(field === 'name' ? record.title : (record.caption ?? ''))
    setEditNote(null)
    setEditing(field)
  }

  const saveEdit = async (value: string) => {
    if (locked || !editing) return
    const field = editing
    setBusy('edit')
    setEditNote(null)
    try {
      if (field === 'name') await onRename(value)
      else await onCaption?.(value)
      setEditing(null)
      setNote(field === 'name' ? 'Name saved' : 'Caption saved')
    } catch (reason) {
      // The sheet stays open so the draft survives; the reason shows inside it.
      setEditNote(messageFor(reason, field === 'name' ? 'That name could not be saved' : 'That caption could not be saved'))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async () => {
    if (locked) return
    setBusy('refresh')
    setNote(null)
    try {
      await onRefresh?.()
      setNote('Refreshed')
    } catch (reason) {
      setNote(messageFor(reason, 'The gallery could not be refreshed'))
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
      {/* The same head an account gallery's settings panel shows: title
          once, then concise source metadata, then the caption in full.
          The availability line is local-only — a detached source has no
          web analogue, so it stays its own line rather than pretending
          parity. */}
      <header class="m-owner-panel-head">
        <div class="m-owner-panel-title">{record.title}</div>
        <p class="m-owner-panel-meta">
          {record.itemCount} {record.itemCount === 1 ? 'photograph' : 'photographs'} · {sourceLabel(record)}
        </p>
        {record.caption ? <p class="m-owner-panel-cap">{record.caption}</p> : null}
        {unavailable ? (
          <p class="m-note" role="status" data-availability={availability}>
            Unavailable — reconnect the source, then rescan.
          </p>
        ) : null}
      </header>

      {/* The same lead group an account gallery opens with: Open gallery,
          then View source — for a local record the source is its folder and
          "viewing" it is a Finder reveal. */}
      <ActionGroup>
        <ActionRow
          label={GALLERY_ROWS.open.label}
          icon={GALLERY_ROWS.open.icon()}
          onClick={onOpen}
          disabled={unavailable || locked}
        />
        {onRevealFolder ? (
          <ActionRow
            label={GALLERY_ROWS.openSource.label}
            icon={GALLERY_ROWS.openSource.icon()}
            onClick={onRevealFolder}
            disabled={locked}
          />
        ) : null}
      </ActionGroup>

      {/* The metadata group, in the cloud panel's order. A present caption
          reads on the head — the row only carries the empty state. The
          address exists only once the gallery is published; either way the
          row leads to the publish flow that owns the slug. */}
      <ActionGroup>
        <ActionRow
          label={GALLERY_ROWS.name.label}
          icon={GALLERY_ROWS.name.icon()}
          value={record.title}
          onClick={() => startEdit('name')}
          disabled={locked}
        />
        {onCaption ? (
          <ActionRow
            label={GALLERY_ROWS.caption.label}
            icon={GALLERY_ROWS.caption.icon()}
            value={record.caption ? undefined : 'None'}
            onClick={() => startEdit('caption')}
            disabled={locked}
          />
        ) : null}
        {onPublish || publishedUrl ? (
          <ActionRow
            label={GALLERY_ROWS.address.label}
            icon={GALLERY_ROWS.address.icon()}
            value={publishedUrl ? addressLabel(publishedUrl) : 'Not published'}
            onClick={onPublish}
            disabled={locked || !onPublish}
          />
        ) : null}
      </ActionGroup>

      {/* The management group the cloud panel's `management` layer
          carries — reorder opens the picker's Edit mode, refresh rescans
          the source. Refresh stays enabled on an unavailable source: it is
          the repair path the head's warning names. */}
      {onReorder || onRefresh ? (
        <ActionGroup>
          {onReorder ? (
            <ActionRow
              label={GALLERY_ROWS.reorder.label}
              icon={GALLERY_ROWS.reorder.icon()}
              value={record.items.length}
              onClick={onReorder}
              disabled={unavailable || locked}
            />
          ) : null}
          {onRefresh ? (
            <ActionRow
              label={busy === 'refresh' ? 'Refreshing…' : GALLERY_ROWS.refresh.label}
              icon={GALLERY_ROWS.refresh.icon()}
              onClick={() => void refresh()}
              disabled={locked}
            />
          ) : null}
        </ActionGroup>
      ) : null}

      {note ? <p class="m-note" role="status">{note}</p> : null}

      <ActionGroup>
        <ActionRow
          label={GALLERY_ROWS.remove.label}
          icon={GALLERY_ROWS.remove.icon()}
          value="Originals stay on this Mac"
          tone="destructive"
          onClick={() => setConfirmingRemove(true)}
          disabled={locked}
        />
      </ActionGroup>

      <GalleryEditSheet
        open={editing !== null}
        field={editing}
        value={draft}
        busy={busy === 'edit'}
        note={editNote}
        onValueChange={setDraft}
        onSubmit={(value) => void saveEdit(value)}
        onClose={() => { if (!locked) setEditing(null) }}
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
