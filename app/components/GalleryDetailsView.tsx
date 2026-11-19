import type { Child } from 'hono/jsx'
import { PIPELINE_LOCK_MESSAGE, expiryCountdownText } from '../lib/gallery-policy'
import { formatMediaCount, type MediaCount } from '../lib/imagesource'
import { ActionGroup, ActionRow } from './ui/ActionRow'
import { Button } from './ui/Button'
import { Switch } from './ui/Switch'
import { TopBar } from './ui/TopBar'

type Props = {
  title: string
  caption: string
  address: string
  imageCount: number
  /** The sub line's still/video/hidden split — every surface counts media
   *  the same way now, so the header never collapses videos into
   *  photographs. `imageCount` stays for the Reorder row's item total. */
  mediaCount: MediaCount
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
  /** Web branch only — native's ··· menu already carries Copy link,
   *  Reorder and Refresh, so its level-1 keeps the macOS rest-layer rows. */
  onShare?: () => void
  onEditName: () => void
  onEditCaption: () => void
  onEditAddress?: () => void
  onReorder?: () => void
  onRefresh?: () => void
  /** Account galleries only: opens the provider source. */
  onOpenSource?: () => void
  onStreamOnlyChange: (next: boolean) => void
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

/** The one label/icon table every gallery-settings surface reads from, so
 *  the same action carries the same name and glyph on web, desktop and
 *  iOS. Order here is documentation only — each container renders the rows
 *  its host can actually perform, in the canonical group order. */
export const GALLERY_ROWS = {
  open: {
    label: 'Open gallery',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>
      </svg>
    ),
  },
  share: { label: 'Share link', icon: () => icon('M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6') },
  publish: {
    label: 'Publish',
    icon: () => icon('M17.5 18.5a4.5 4.5 0 0 0 .6-9A6 6 0 0 0 6.6 7.6 4 4 0 0 0 7.5 18.5z', 'M12 11v7m0 0l-3-3m3 3l3-3'),
  },
  name: { label: 'Name', icon: () => icon('M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4') },
  caption: { label: 'Caption', icon: () => icon('M4 6h16M4 11h16M4 16h10') },
  address: {
    label: 'Address',
    icon: () => icon('M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.1 1.1', 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.1-1.1'),
  },
  reorder: { label: 'Reorder photographs', icon: () => icon('M7 4v16M4 7l3-3 3 3', 'M17 20V4M14 17l3 3 3-3') },
  refresh: { label: 'Refresh gallery contents', icon: () => icon('M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7') },
  openSource: {
    label: 'View source',
    icon: () => icon('M14 4h6v6', 'M20 4l-9.5 9.5', 'M19 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5.5'),
  },
  keepCopy: {
    label: 'Keep a copy',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M12 8v6M9.5 11.5L12 14l2.5-2.5"/>
      </svg>
    ),
  },
  remove: { label: 'Remove from Library', icon: () => icon('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13') },
} as const

/** Shared owner Details composition. Platform containers own the commands;
 * this view only states capabilities and emits intent. */
export function GalleryDetailsView({
  title,
  caption,
  address,
  imageCount,
  mediaCount,
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
  onOpenSource,
  onStreamOnlyChange,
  onRemove,
}: Props) {
  const locked = busy || !editable
  const keepValue = streamOnly
    ? 'Streams'
    : vaultProgress && vaultProgress.completed < vaultProgress.total
      ? `${vaultProgress.completed} of ${vaultProgress.total}`
      : hasSavedCopy
        ? 'Saved'
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
            {formatMediaCount(mediaCount)} · {sourceLabel}
            {temporary ? ` · Temporary gallery${expiresAt ? ` · expires in ${expiryCountdownText(expiresAt, Date.now())}` : ''}` : ''}
            {deviceStatus}
          </div>
          {caption ? <div class="d-cap">{caption}</div> : null}
          <div class="d-addr">{address}</div>
        </header>

        <div class="d-groups">
          {temporary && upgradeHref ? (
            <p class="m-note d-upgrade-note">{PIPELINE_LOCK_MESSAGE} <a href={upgradeHref}>Upgrade</a></p>
          ) : null}
          {platform === 'native' ? (
            <>
              {/* The native level-1 mirrors the macOS Gallery Settings sheet:
                  open/view-source first, then the metadata group, then the
                  management pair. Copy link stays in the card's ··· menu one
                  level up. */}
              <ActionGroup>
                <ActionRow label={GALLERY_ROWS.open.label} icon={GALLERY_ROWS.open.icon()} onClick={onOpen} disabled={busy} />
                {onOpenSource ? (
                  <ActionRow label={GALLERY_ROWS.openSource.label} icon={GALLERY_ROWS.openSource.icon()} onClick={onOpenSource} disabled={locked} />
                ) : null}
              </ActionGroup>
              <ActionGroup>
                <ActionRow label={GALLERY_ROWS.name.label} icon={GALLERY_ROWS.name.icon()} value={title} onClick={onEditName} disabled={locked} />
                <ActionRow label={GALLERY_ROWS.caption.label} icon={GALLERY_ROWS.caption.icon()} value={caption ? undefined : 'None'} onClick={onEditCaption} disabled={locked} />
                {onEditAddress ? (
                  <ActionRow label={GALLERY_ROWS.address.label} icon={GALLERY_ROWS.address.icon()} value={address} onClick={onEditAddress} disabled={locked} />
                ) : null}
              </ActionGroup>
              {onReorder || onRefresh ? (
                <ActionGroup>
                  {onReorder ? (
                    <ActionRow label={GALLERY_ROWS.reorder.label} icon={GALLERY_ROWS.reorder.icon()} value={imageCount} onClick={onReorder} disabled={locked} />
                  ) : null}
                  {onRefresh ? (
                    <ActionRow label={GALLERY_ROWS.refresh.label} icon={GALLERY_ROWS.refresh.icon()} onClick={onRefresh} disabled={locked} />
                  ) : null}
                </ActionGroup>
              ) : null}
            </>
          ) : (
            <>
              <ActionGroup>
                <ActionRow label={GALLERY_ROWS.name.label} icon={GALLERY_ROWS.name.icon()} value={title} onClick={onEditName} disabled={locked} />
                {/* A present caption reads in full on the header — only an empty
                    one needs the row to state it. */}
                <ActionRow label={GALLERY_ROWS.caption.label} icon={GALLERY_ROWS.caption.icon()} value={caption ? undefined : 'None'} onClick={onEditCaption} disabled={locked} />
                {onEditAddress ? (
                  <ActionRow label={GALLERY_ROWS.address.label} icon={GALLERY_ROWS.address.icon()} value={address} onClick={onEditAddress} disabled={locked} />
                ) : null}
                {/* The full address is already on the header — the row states the
                    action, not a second copy of the path. */}
                {onShare ? (
                  <ActionRow
                    label="Copy link"
                    icon={GALLERY_ROWS.share.icon()}
                    onClick={onShare}
                    disabled={busy}
                  />
                ) : null}
              </ActionGroup>

              {onReorder || onRefresh || onOpenSource ? (
                <ActionGroup>
                  {onReorder ? <ActionRow label={GALLERY_ROWS.reorder.label} icon={GALLERY_ROWS.reorder.icon()} value={imageCount} onClick={onReorder} disabled={locked} /> : null}
                  {onRefresh ? <ActionRow label={GALLERY_ROWS.refresh.label} icon={GALLERY_ROWS.refresh.icon()} onClick={onRefresh} disabled={locked} /> : null}
                  {onOpenSource ? (
                    <ActionRow label={GALLERY_ROWS.openSource.label} icon={GALLERY_ROWS.openSource.icon()} onClick={onOpenSource} disabled={locked} />
                  ) : null}
                </ActionGroup>
              ) : null}
            </>
          )}

          {platform === 'native' ? (
            <ActionGroup>
              {/* The value span must exist from the first render: when the
                  flip adds "Streams" it would otherwise shift the control
                  span's index and swap the switch node mid-gesture. */}
              <ActionRow
                label={`Keep a copy on ${deviceLabel ?? 'this device'}`}
                icon={GALLERY_ROWS.keepCopy.icon()}
                value={keepValue ?? ''}
                control={(
                  <Switch
                    checked={!streamOnly}
                    onChange={(keep) => onStreamOnlyChange(!keep)}
                    label={`Keep a copy on ${deviceLabel ?? 'this device'}`}
                    describedBy="gallery-keep-note"
                    disabled={busy}
                  />
                )}
              />
              <p class="m-note m-panel-note" id="gallery-keep-note">
                Turning this off deletes copies saved to this device's Vault.
              </p>
              {vaultNote ? <p class="m-note m-panel-note" role="status" aria-live="polite">{vaultNote}</p> : null}
              {vaultProgress && vaultProgress.total > 0 ? (
                <span
                  class="native-vault-meter"
                  role="progressbar"
                  aria-label={`Saving to ${deviceLabel ?? 'this device'}`}
                  aria-valuemin={0}
                  aria-valuemax={vaultProgress.total}
                  aria-valuenow={vaultProgress.completed}
                >
                  <span
                    class="native-vault-meter-fill"
                    style={{ width: `${Math.min(100, Math.round((vaultProgress.completed / vaultProgress.total) * 100))}%` }}
                  />
                </span>
              ) : null}
            </ActionGroup>
          ) : null}

          {note ? <p class="m-note" role="status">{note}</p> : null}

          <ActionGroup>
            <ActionRow
              label={GALLERY_ROWS.remove.label}
              icon={GALLERY_ROWS.remove.icon()}
              tone="destructive"
              onClick={onRemove}
              disabled={busy}
            />
            {/* The consequence reads on its own line — inline it truncates
                on a phone. */}
            <p class="m-note m-panel-note">Photographs stay in {sourceLabel}.</p>
          </ActionGroup>
        </div>
      </div>
    </main>
  )
}

export default GalleryDetailsView
