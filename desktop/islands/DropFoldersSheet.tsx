import { useMemo } from 'hono/jsx'
import { Sheet } from '../../app/components/ui/Sheet'
import { Button } from '../../app/components/ui/Button'
import { CompactCoverImg } from '../../app/components/library/CompactCoverImg'
import { baseName } from '../lib/local-scan'
import {
  DROP_FOLDER_LIMIT,
  candidateCountText,
  coverForCandidate,
  isSelectable,
  parentFolderName,
  type DroppedFolderCandidate,
} from '../lib/folder-drop'

/**
 * The intermediate step of a multi-folder drop: the shell has already
 * scoped every directory on the desktop, and this sheet is where the owner
 * decides which of them become galleries. Rows resolve progressively as
 * their scans land — a skeleton stands in until then — and every non-new
 * state (duplicate, empty, unreadable) is shown, not hidden, so a dropped
 * folder never silently vanishes.
 *
 * Presentational only: scanning, selection state and the commit itself
 * live in Catalogue, which owns the catalogue writes and the native
 * pending-grant lifecycle.
 */

type Props = {
  open: boolean
  /** Every dropped folder in drop order — the page-side dedupe already ran;
   *  the sheet shows the first DROP_FOLDER_LIMIT and says so when there are
   *  more. */
  paths: readonly string[]
  candidates: readonly DroppedFolderCandidate[]
  selected: ReadonlySet<string>
  committing: boolean
  /** Path → renderable URL — `assetUrl` in production, a stub in tests. */
  assetUrl: (path: string) => string
  onToggle: (path: string) => void
  onSelectAll: (select: boolean) => void
  onCancel: () => void
  onAdd: () => void
}

const STATE_NOTE: Record<Exclude<DroppedFolderCandidate['state'], 'new'>, string> = {
  duplicate: 'Already in your library',
  empty: 'No photographs Manorama can display',
  unreadable: "Couldn't read this folder",
}

function DropFolderRow({
  path,
  candidate,
  selected,
  committing,
  assetUrl,
  onToggle,
}: {
  path: string
  candidate: DroppedFolderCandidate | undefined
  selected: boolean
  committing: boolean
  assetUrl: (path: string) => string
  onToggle: (path: string) => void
}) {
  const state = candidate?.state ?? 'scanning'
  const selectable = candidate ? isSelectable(candidate) : false
  const title = candidate?.title ?? baseName(path) ?? path
  const cover = candidate ? coverForCandidate(candidate) : undefined
  const parent = parentFolderName(path)
  const meta: string[] = []
  if (candidate && candidate.itemCount > 0) meta.push(candidateCountText(candidate))
  if (parent) meta.push(`in ${parent}`)
  if (candidate?.sourceKind === 'card') meta.push('Memory card')
  return (
    <li class={`drop-folder-row${state === 'scanning' ? ' is-scanning' : ''}${state !== 'new' ? ' is-disabled' : ''}`} data-state={state}>
      <span class="drop-folder-cover" aria-hidden="true">
        {cover ? (
          <CompactCoverImg
            src={assetUrl(cover.path)}
            storedWidth={cover.width}
            storedHeight={cover.height}
            filename={cover.name}
          />
        ) : (
          <span class="drop-folder-cover-ph" />
        )}
      </span>
      <span class="drop-folder-text">
        <span class="drop-folder-title">{title}</span>
        {state === 'scanning' ? (
          <span class="drop-folder-meta drop-folder-meta--scan">Looking for photographs…</span>
        ) : (
          <>
            {meta.length ? <span class="drop-folder-meta">{meta.join(' · ')}</span> : null}
            {state !== 'new' ? <span class="drop-folder-note">{STATE_NOTE[state]}</span> : null}
          </>
        )}
      </span>
      <input
        type="checkbox"
        class="drop-folder-check"
        checked={selectable && selected}
        disabled={committing || !selectable}
        aria-label={`Add ${title}`}
        onChange={() => onToggle(path)}
      />
    </li>
  )
}

export function DropFoldersSheet({
  open,
  paths,
  candidates,
  selected,
  committing,
  assetUrl,
  onToggle,
  onSelectAll,
  onCancel,
  onAdd,
}: Props) {
  const byPath = useMemo(() => {
    const map = new Map<string, DroppedFolderCandidate>()
    for (const candidate of candidates) map.set(candidate.path, candidate)
    return map
  }, [candidates])
  const shown = paths.slice(0, DROP_FOLDER_LIMIT)
  const selectable = candidates.filter(isSelectable)
  const selectedCount = selectable.filter((candidate) => selected.has(candidate.path)).length
  const allSelected = selectable.length > 0 && selectedCount === selectable.length
  const overflow = paths.length - shown.length
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title="Add folders"
      dismissible={!committing}
      footer={(
        <div class="drop-folders-foot">
          <Button variant="quiet" disabled={committing} onClick={onCancel}>Cancel</Button>
          <Button
            variant="quiet"
            disabled={committing || selectable.length === 0}
            onClick={() => onSelectAll(!allSelected)}
          >
            {allSelected ? 'Select none' : 'Select all'}
          </Button>
          <Button
            variant="primary"
            class="drop-folders-add"
            disabled={committing || selectedCount === 0}
            onClick={onAdd}
          >
            {committing ? 'Adding…' : `Add ${selectedCount} ${selectedCount === 1 ? 'gallery' : 'galleries'}`}
          </Button>
        </div>
      )}
    >
      <p class="drop-folders-sub" aria-live="polite">
        {`${selectedCount} of ${selectable.length} selected · originals stay where they are — nothing is copied or uploaded`}
      </p>
      {overflow > 0 ? (
        <p class="drop-folders-overflow">{`Showing the first ${shown.length} of ${paths.length} folders.`}</p>
      ) : null}
      <ul class="drop-folders-list">
        {shown.map((path) => (
          <DropFolderRow
            key={path}
            path={path}
            candidate={byPath.get(path)}
            selected={selected.has(path)}
            committing={committing}
            assetUrl={assetUrl}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </Sheet>
  )
}

/** The full-window ground a folder drag gets on the Library surface —
 *  translucent dark, a hairline in the app's shocking-pink accent, and a
 *  centred pill naming the gesture. Decorative: aria-hidden, pointer-events
 *  off, so it can never eat a click or a drop. */
export const DropVeil = ({ folders, pro }: { folders: number; pro: boolean }) => (
  <div class="desktop-drop-veil" aria-hidden="true">
    <div class="desktop-drop-pill">
      <span class="desktop-drop-title">
        {pro ? 'Drop folders to add them' : 'Local galleries are included with Visionary'}
      </span>
      {pro && folders > 0 ? (
        <span class="desktop-drop-count">{`${folders} ${folders === 1 ? 'folder' : 'folders'}`}</span>
      ) : null}
    </div>
  </div>
)
