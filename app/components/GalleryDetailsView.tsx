import { ActionGroup, ActionRow } from './ui/ActionRow'
import { Button } from './ui/Button'
import { Meter } from './ui/Meter'
import { Switch } from './ui/Switch'
import { TopBar } from './ui/TopBar'

type Props = {
  title: string
  caption: string
  address: string
  imageCount: number
  sourceLabel: string
  temporary?: boolean
  expiresAt?: string | null
  editable: boolean
  busy?: boolean
  note?: string | null
  streamOnly: boolean
  vaultNote?: string
  vaultProgress?: { completed: number; total: number } | null
  hasSavedCopy?: boolean
  deviceLabel?: string
  platform?: 'native' | 'web'
  onBack: () => void
  onOpen: () => void
  onShare: () => void
  onEditName: () => void
  onEditCaption: () => void
  onEditAddress?: () => void
  onReorder: () => void
  onRefresh: () => void
  onStreamOnlyChange: (next: boolean) => void
  onPurge: () => void
  onRemove: () => void
}

/** Shared owner Details composition. Platform containers own the commands;
 * this view only states capabilities and emits intent. */
export function GalleryDetailsView({
  title,
  caption,
  address,
  imageCount,
  sourceLabel,
  temporary = false,
  expiresAt,
  editable,
  busy = false,
  note,
  streamOnly,
  vaultNote,
  vaultProgress,
  hasSavedCopy = false,
  deviceLabel = 'this device',
  platform = 'native',
  onBack,
  onOpen,
  onShare,
  onEditName,
  onEditCaption,
  onEditAddress,
  onReorder,
  onRefresh,
  onStreamOnlyChange,
  onPurge,
  onRemove,
}: Props) {
  const locked = busy || !editable
  return (
    <main class="m-owner m-screen m-screen--fixed" data-screen="details">
      <TopBar
        title="Details"
        logo={false}
        start={<Button variant="quiet" onClick={onBack}>‹ Back</Button>}
      />
      <div class="m-owner-content">
        <header class="m-owner-heading">
          <h1>{title}</h1>
          {caption ? <p>{caption}</p> : null}
          <p class="m-note">
            {imageCount} {imageCount === 1 ? 'photograph' : 'photographs'} · {sourceLabel}
            {temporary ? ` · Temporary gallery${expiresAt ? ` · expires ${expiresAt.slice(0, 10)}` : ''}` : ''}
          </p>
        </header>

        <ActionGroup label="Open">
          <ActionRow label="Open gallery" onClick={onOpen} disabled={busy} />
          <ActionRow label="Share link" value="Public address" onClick={onShare} disabled={busy} />
        </ActionGroup>

        <ActionGroup label="Gallery">
          <ActionRow label="Name" value={title} onClick={onEditName} disabled={locked} />
          <ActionRow label="Caption" value={caption || 'Add a caption'} onClick={onEditCaption} disabled={locked} />
          <ActionRow label="Address" value={address} onClick={onEditAddress} disabled={onEditAddress ? locked : undefined} chevron={onEditAddress ? undefined : false} />
          <ActionRow label="Reorder photographs" onClick={onReorder} disabled={locked} />
        </ActionGroup>

        {platform === 'native' ? <ActionGroup label={deviceLabel.replace(/^./, letter => letter.toUpperCase())}>
          <ActionRow
            label="Keep a copy"
            control={(
              <Switch
                checked={!streamOnly}
                onChange={(keep) => onStreamOnlyChange(!keep)}
                label={`Keep a copy on ${deviceLabel}`}
                describedBy="gallery-keep-note"
                disabled={busy}
              />
            )}
          />
          <p class="m-note m-panel-note" id="gallery-keep-note">
            Turning this off stops future downloads. It does not delete copies already saved here.
          </p>
          {vaultNote ? <p class="m-note m-panel-note" role="status" aria-live="polite">{vaultNote}</p> : null}
          {vaultProgress && !streamOnly ? (
            <Meter
              label="Photos saved to encrypted vault"
              value={vaultProgress.completed}
              max={vaultProgress.total}
              valueText={`${vaultProgress.completed} of ${vaultProgress.total}`}
            />
          ) : null}
          {hasSavedCopy ? <ActionRow label={`Remove saved copy from ${deviceLabel}`} onClick={onPurge} disabled={busy} /> : null}
          <ActionRow label="Read the folder again" onClick={onRefresh} disabled={locked} />
        </ActionGroup> : <ActionGroup label="Source">
          <ActionRow label="Read the folder again" onClick={onRefresh} disabled={locked} />
        </ActionGroup>}

        {note ? <p class="m-note" role="status">{note}</p> : null}

        <ActionGroup label="Remove">
          <ActionRow label="Remove gallery" value="Originals stay at their source" tone="destructive" onClick={onRemove} disabled={busy} />
        </ActionGroup>
      </div>
    </main>
  )
}

export default GalleryDetailsView
