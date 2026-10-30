import type { Child } from 'hono/jsx'
import { PIPELINE_LOCK_MESSAGE } from '../lib/gallery-policy'
import { ActionGroup, ActionRow } from './ui/ActionRow'
import { Button } from './ui/Button'
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
  /** Web-only: the Stripe upgrade href shown under the temporary notice.
   *  Native surfaces the visionary sheet instead, so they never pass it. */
  upgradeHref?: string
  editable: boolean
  busy?: boolean
  note?: string | null
  streamOnly: boolean
  vaultNote?: string
  vaultProgress?: { completed: number; total: number } | null
  hasSavedCopy?: boolean
  deviceLabel?: string
  platform?: 'native' | 'web'
  /** "Library" when the owner came from the Library, "Back" when the
   *  suspended viewer sits underneath — same as the prototype's d-back. */
  backLabel?: string
  backAriaLabel?: string
  /** The gallery's own photographs in miniature (LibraryRail on native). */
  rail?: Child
  /** The card's on-device word — Streams / Saving n of m / On this iPhone —
   *  rendered inside the sub line (LibraryDeviceStatus on native). */
  deviceStatus?: Child
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

/** Row glyphs are built per render: a JSX vnode stashes its mount position
 *  during build, so a module-level element reused across renders forms a
 *  cycle that overflows hono's reconciler and silently aborts the patch. */
const icon = (...paths: string[]) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    {paths.map((path) => <path key={path} d={path} />)}
  </svg>
)
const ICONS = {
  share: () => icon('M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6'),
  name: () => icon('M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'),
  caption: () => icon('M4 6h16M4 11h16M4 16h10'),
  reorder: () => icon('M7 4v16M4 7l3-3 3 3', 'M17 20V4M14 17l3 3 3-3'),
  keep: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M12 8v6M9.5 11.5L12 14l2.5-2.5"/>
    </svg>
  ),
  refresh: () => icon('M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'),
  remove: () => icon('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'),
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
  upgradeHref,
  editable,
  busy = false,
  note,
  streamOnly,
  vaultNote,
  vaultProgress,
  hasSavedCopy = false,
  deviceLabel = 'this device',
  platform = 'native',
  backLabel = 'Back',
  backAriaLabel,
  rail,
  deviceStatus,
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
  const keepValue = streamOnly
    ? 'Streams'
    : vaultProgress && vaultProgress.completed < vaultProgress.total
      ? `${vaultProgress.completed} of ${vaultProgress.total}`
      : hasSavedCopy
        ? `On ${deviceLabel}`
        : undefined
  return (
    <main class="m-owner m-screen m-screen--fixed" data-screen="details">
      <TopBar
        start={(
          <Button variant="quiet" onClick={onBack} aria-label={backAriaLabel} class="m-backbtn">
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 6l-6 6 6 6"/></svg>
            {backLabel}
          </Button>
        )}
      />
      <div class="m-owner-content d-content">
        <header class="d-head">
          {rail ? <div class="d-rail">{rail}</div> : null}
          <div class="d-name">{title}</div>
          <div class="d-sub">
            {imageCount} {imageCount === 1 ? 'photograph' : 'photographs'} · {sourceLabel}
            {temporary ? ` · Temporary gallery${expiresAt ? ` · expires ${expiresAt.slice(0, 10)}` : ''}` : ''}
            {deviceStatus}
          </div>
          {caption ? <div class="d-cap">{caption}</div> : null}
          <div class="d-addr">{address}</div>
        </header>

        <div class="d-groups">
          {temporary && upgradeHref ? (
            <p class="m-note d-upgrade-note">{PIPELINE_LOCK_MESSAGE} <a href={upgradeHref}>Upgrade</a></p>
          ) : null}
          <ActionGroup>
            <ActionRow
              label="Open gallery"
              icon={(
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>
                </svg>
              )}
              onClick={onOpen}
              disabled={busy}
            />
            <ActionRow
              label="Share link"
              icon={ICONS.share()}
              value={`…/${address.split('/').at(-1)}`}
              onClick={onShare}
              disabled={busy}
            />
          </ActionGroup>

          <ActionGroup>
            <ActionRow label="Name" icon={ICONS.name()} value={title} onClick={onEditName} disabled={locked} />
            <ActionRow label="Caption" icon={ICONS.caption()} value={caption || 'None'} onClick={onEditCaption} disabled={locked} />
            {onEditAddress ? (
              <ActionRow label="Address" value={address} onClick={onEditAddress} disabled={locked} />
            ) : null}
            <ActionRow label="Reorder photographs" icon={ICONS.reorder()} value={imageCount} onClick={onReorder} disabled={locked} />
          </ActionGroup>

          {platform === 'native' ? (
            <ActionGroup>
              {/* The value span must exist from the first render: when the
                  flip adds "Streams" it would otherwise shift the control
                  span's index and swap the switch node mid-gesture. */}
              <ActionRow
                label={`Keep on ${deviceLabel}`}
                icon={ICONS.keep()}
                value={keepValue ?? ''}
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
              {hasSavedCopy ? <ActionRow label={`Remove saved copy from ${deviceLabel}`} onClick={onPurge} disabled={busy} /> : null}
              <ActionRow label="Read the folder again" icon={ICONS.refresh()} onClick={onRefresh} disabled={locked} />
            </ActionGroup>
          ) : (
            <ActionGroup>
              <ActionRow label="Read the folder again" icon={ICONS.refresh()} onClick={onRefresh} disabled={locked} />
            </ActionGroup>
          )}

          {note ? <p class="m-note" role="status">{note}</p> : null}

          <ActionGroup>
            <ActionRow label="Remove gallery" icon={ICONS.remove()} tone="destructive" onClick={onRemove} disabled={busy} />
          </ActionGroup>
          <p class="d-acts-note">Removing it leaves every photograph in {sourceLabel}.</p>
        </div>
      </div>
    </main>
  )
}

export default GalleryDetailsView
