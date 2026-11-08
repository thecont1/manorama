import { useEffect, useRef, useState, type Child } from 'hono/jsx'
import { PIPELINE_LOCK_MESSAGE, expiryCountdownText } from '../../lib/gallery-policy'
import { formatMediaCount, type MediaCount } from '../../lib/imagesource'
import { refreshRequestInit } from '../../lib/encrypted-refresh'
import type { WebGalleryKeyStore } from '../../lib/key-store'
import { announce } from '../../lib/announce'
import { ActionGroup, ActionRow } from '../ui/ActionRow'
import { Button } from '../ui/Button'
import { DETAILS_ICONS } from '../GalleryDetailsView'

/** The web owner's gallery management, inline in the Settings popover —
 *  what "Manage gallery" used to hand off to the dashboard's Details
 *  surface. The panel owns every fetch and its own edit state so the
 *  viewer only carries props and a title callback. A shell that wants a
 *  Details surface instead (native) never renders this: it passes
 *  onOpenDetails to the viewer and gets the single handoff row. */

export type OwnerGalleryPanelProps = {
  /** The owner's URL segment — share links and the rename redirect. */
  owner: string
  /** The gallery's current slug; the address row edits it. */
  slug: string
  title: string
  caption: string
  sourceLabel: string
  /** Encrypted refresh scans on-device — the key store is keyed by id and
   *  the source URL decides whether the bare POST is enough. Ordinary
   *  sources need neither. */
  galleryId?: string | null
  sourceUrl?: string | null
  temporary: boolean
  expiresAt?: string | null
  mediaCount: MediaCount
  /** Drop the in-place head — the caller hoists it elsewhere (the
   *  Settings popover shows it as the intro above View). */
  headless?: boolean
  /** The owner's library — the post-delete landing and the pipeline
   *  lock's Upgrade link when no `upgradeHref` is passed. */
  libraryHref?: string
  /** The billing/mail upgrade destination — preferred over libraryHref
   *  for the pipeline lock's Upgrade link when the host has one. */
  upgradeHref?: string
  /** An "Open gallery" row — hosts that are not already inside the
   *  gallery (the Library's settings sheet) pass it; the viewer does not. */
  onOpen?: () => void
  /** Reorder stays a dashboard deep-link until Phase B replaces it. */
  onReorder?: () => void
  /** The on-stage photograph at save time — the rename redirect returns
   *  to it via `?photo=` instead of resetting to the first frame. */
  currentPhotoId: () => string
  /** A saved name propagates to the viewer's displayed title. */
  onTitleSaved: (title: string) => void
  /** A saved caption propagates to a host list (the Library's summary
   *  would otherwise reopen the sheet with the stale text). */
  onCaptionSaved?: (caption: string) => void
  /** Absolute API origin — empty means same-origin (web). The desktop
   *  shell talks to manorama.xyz explicitly. */
  apiBase?: string
  /** Bearer token for a cross-origin session (desktop). */
  authToken?: string
  /** Device custody for encrypted refresh — the web's session store is
   *  the default; shells with their own store inject it. */
  keyStore?: WebGalleryKeyStore
  /** The link the Share row copies — defaults to this origin's address. */
  shareHref?: string
  /** Post-rename continuation — defaults to redirecting to the new
   *  address at the same photograph. */
  onRenamed?: (slug: string) => void
  /** Post-refresh continuation — defaults to reloading the page so the
   *  SSR manifest picks up the fresh scan. */
  onRefreshed?: () => void
  /** Post-remove landing — defaults to `libraryHref ?? '/'`. */
  onRemoved?: () => void
}

type EditField = 'name' | 'caption' | 'address'

/** The gallery's identity header — title, the source line ("16
 *  photographs · Dropbox"), and the caption in full. The Settings
 *  popover hoists it to the top as the intro; the panel renders it in
 *  place everywhere else. */
export const OwnerGalleryHead = ({ title, caption, sourceLabel, temporary, expiresAt, mediaCount }: Pick<OwnerGalleryPanelProps, 'title' | 'caption' | 'sourceLabel' | 'temporary' | 'expiresAt' | 'mediaCount'>) => (
  <header class="m-owner-panel-head">
    <div class="m-owner-panel-title">{title}</div>
    <p class="m-owner-panel-meta">
      {formatMediaCount(mediaCount)} · {sourceLabel}
      {temporary ? ` · Temporary gallery${expiresAt ? ` · expires in ${expiryCountdownText(expiresAt, Date.now())}` : ''}` : ''}
    </p>
    {caption ? <p class="m-owner-panel-cap">{caption}</p> : null}
  </header>
)

export default function OwnerGalleryPanel({
  owner,
  slug,
  title,
  caption,
  sourceLabel,
  galleryId,
  sourceUrl,
  temporary,
  headless = false,
  expiresAt,
  mediaCount,
  libraryHref,
  upgradeHref,
  onOpen,
  onReorder,
  currentPhotoId,
  onTitleSaved,
  onCaptionSaved,
  apiBase = '',
  authToken,
  keyStore,
  shareHref,
  onRenamed,
  onRefreshed,
  onRemoved,
}: OwnerGalleryPanelProps) {
  // Same-origin on the web; absolute + bearer on shells that carry their
  // own session. The bearer rides every call because the cross-origin
  // route cannot see the web's cookie.
  const api = (path: string, init?: RequestInit) => fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
  })
  const [liveTitle, setLiveTitle] = useState(title)
  const [liveCaption, setLiveCaption] = useState(caption)
  const [editing, setEditing] = useState<EditField | null>(null)
  const [draft, setDraft] = useState('')
  const [editNote, setEditNote] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const locked = temporary

  // Focus lands in the field when a row opens — once per edit, never on a
  // re-render mid-keystroke.
  useEffect(() => {
    if (!editing) return
    const field = panelRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-owner-edit-field]')
    field?.focus()
    field?.setSelectionRange?.(field.value.length, field.value.length)
  }, [editing])

  const startEdit = (field: EditField) => {
    if (locked || editBusy) return
    setDraft(field === 'name' ? liveTitle : field === 'caption' ? liveCaption : slug)
    setEditNote(null)
    setEditing(field)
  }
  const cancelEdit = () => {
    if (editBusy) return
    setEditing(null)
    setDraft('')
    setEditNote(null)
  }

  // The same validation and request shapes as Admin.saveEditFromDetails —
  // the PATCH route trims and re-validates regardless.
  const saveEdit = () => {
    if (!editing || editBusy) return
    const field = editing
    const value = draft
    if (field === 'name' && !value.trim()) {
      setEditNote('A gallery title cannot be empty')
      return
    }
    if (field === 'address' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.trim().toLowerCase())) {
      setEditNote('Use lowercase letters, numbers, and single hyphens for the gallery URL')
      return
    }
    setEditBusy(true)
    setEditNote(null)
    void (async () => {
      try {
        const response = await api(`/api/galleries/${encodeURIComponent(slug)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(field === 'address' ? { newSlug: value.trim() } : { [field === 'name' ? 'title' : 'caption']: value }),
        })
        const payload = await response.json().catch(() => ({})) as { gallery?: { slug: string; title: string; caption: string }; error?: string }
        if (!response.ok) throw new Error(payload.error || 'That change could not be saved')
        if (field === 'address') {
          // A rename changes the gallery's address — land on the new one at
          // the same photograph rather than staying on a 404.
          const nextSlug = payload.gallery?.slug ?? value.trim()
          if (onRenamed) { onRenamed(nextSlug); return }
          const photo = currentPhotoId()
          window.location.replace(`/${encodeURIComponent(owner)}/${encodeURIComponent(nextSlug)}${photo ? `?photo=${encodeURIComponent(photo)}` : ''}`)
          return
        }
        if (field === 'name') {
          const next = payload.gallery?.title ?? value.trim()
          setLiveTitle(next)
          onTitleSaved(next)
        } else {
          const next = payload.gallery?.caption ?? value.trim()
          setLiveCaption(next)
          onCaptionSaved?.(next)
        }
        announce('Saved')
        setEditing(null)
        setDraft('')
      } catch (error) {
        setEditNote(error instanceof Error ? error.message : 'That change could not be saved')
      } finally {
        setEditBusy(false)
      }
    })()
  }

  // Enter saves a single-line field; a caption keeps Enter for newlines
  // and saves on Cmd/Ctrl+Enter. Escape cancels the edit only — the
  // data-escape-owner marker keeps the sheet's Escape handler out of it,
  // and stopPropagation keeps the viewer's own Escape out too.
  const onFieldKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      cancelEdit()
      return
    }
    const isTextarea = (event.target as HTMLElement | null)?.tagName === 'TEXTAREA'
    if (event.key === 'Enter' && (!isTextarea || event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      saveEdit()
    }
  }

  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  const copyShareLink = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(shareHref ?? `${window.location.origin}/${owner}/${slug}`)
        setLinkCopied(true)
        if (copyResetRef.current) clearTimeout(copyResetRef.current)
        copyResetRef.current = setTimeout(() => setLinkCopied(false), 1600)
      } catch { /* clipboard denied — the address bar still carries it */ }
    })()
  }

  const [readState, setReadState] = useState<'idle' | 'busy' | 'error'>('idle')
  const [readNote, setReadNote] = useState<string | null>(null)
  const readFolderAgain = () => {
    if (readState === 'busy') return
    setReadState('busy')
    setReadNote(null)
    void (async () => {
      try {
        const response = await api(`/api/galleries/${encodeURIComponent(slug)}/refresh`, await refreshRequestInit({ id: galleryId, sourceUrl, keyStore }))
        const payload = await response.json().catch(() => ({})) as { error?: string }
        if (!response.ok) throw new Error(payload.error || 'That folder could not be read again')
        if (onRefreshed) { onRefreshed(); return }
        // The manifest is SSR state — reload into the fresh gallery at the
        // same photograph so the re-read shows what changed.
        const here = new URL(window.location.href)
        const photo = currentPhotoId()
        if (photo) here.searchParams.set('photo', photo)
        window.location.assign(`${here.pathname}${here.search}${here.hash}`)
      } catch (error) {
        setReadState('error')
        setReadNote(error instanceof Error ? error.message : 'That folder could not be read again')
      }
    })()
  }

  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeNote, setRemoveNote] = useState<string | null>(null)
  const removeGallery = () => {
    if (removeBusy) return
    setRemoveBusy(true)
    setRemoveNote(null)
    void (async () => {
      try {
        const response = await api(`/api/galleries/${encodeURIComponent(slug)}`, { method: 'DELETE' })
        const payload = await response.json().catch(() => ({})) as { error?: string }
        if (!response.ok) throw new Error(payload.error || 'That gallery could not be removed')
        if (onRemoved) { onRemoved(); return }
        window.location.assign(libraryHref ?? '/')
      } catch (error) {
        setRemoveBusy(false)
        setRemoveNote(error instanceof Error ? error.message : 'That gallery could not be removed')
      }
    })()
  }

  const editBlock = (label: string, control: Child) => (
    <div class="m-owner-edit" data-escape-owner>
      <span class="m-owner-edit-label">{label}</span>
      {control}
      {editNote ? <p class="m-error" role="alert">{editNote}</p> : null}
      <div class="m-owner-edit-actions">
        <Button variant="secondary" disabled={editBusy} onClick={cancelEdit}>Cancel</Button>
        <Button variant="primary" disabled={editBusy} onClick={saveEdit}>{editBusy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  )
  const onDraft = (event: Event) => {
    setDraft((event.currentTarget as HTMLInputElement).value)
    setEditNote(null)
  }

  return (
    <div class="m-owner-panel" ref={panelRef}>
      {headless ? null : (
        <OwnerGalleryHead
          title={liveTitle}
          caption={liveCaption}
          sourceLabel={sourceLabel}
          temporary={temporary}
          expiresAt={expiresAt}
          mediaCount={mediaCount}
        />
      )}
      {temporary ? (
        <p class="m-note m-owner-panel-lock">
          {PIPELINE_LOCK_MESSAGE}{' '}
          {upgradeHref ?? libraryHref ? <a href={upgradeHref ?? libraryHref}>Upgrade</a> : null}
        </p>
      ) : null}
      <ActionGroup>
        {onOpen ? (
          <ActionRow
            label="Open gallery"
            icon={(
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>
              </svg>
            )}
            onClick={onOpen}
          />
        ) : null}
        <ActionRow
          label={linkCopied ? 'Link copied' : 'Share link'}
          icon={DETAILS_ICONS.share()}
          onClick={copyShareLink}
        />
      </ActionGroup>
      <ActionGroup>
        {editing === 'name' ? editBlock('Name', (
          <input class="m-input" type="text" aria-label="Name" value={draft} maxLength={120} data-owner-edit-field onInput={onDraft} onKeyDown={onFieldKey} />
        )) : (
          <ActionRow label="Name" icon={DETAILS_ICONS.name()} value={liveTitle} onClick={() => startEdit('name')} disabled={locked} />
        )}
        {/* A present caption reads in full on the head — the row only
            carries the empty state, so nothing ellipsizes. */}
        {editing === 'caption' ? editBlock('Caption', (
          <textarea class="m-input" rows={3} aria-label="Caption" value={draft} maxLength={500} data-owner-edit-field onInput={onDraft} onKeyDown={onFieldKey} />
        )) : (
          <ActionRow label="Caption" icon={DETAILS_ICONS.caption()} value={liveCaption ? undefined : 'None'} onClick={() => startEdit('caption')} disabled={locked} />
        )}
        {editing === 'address' ? editBlock('Address', (
          <input class="m-input" type="text" aria-label="Address" value={draft} maxLength={120} data-owner-edit-field onInput={onDraft} onKeyDown={onFieldKey} />
        )) : (
          <ActionRow label="Address" value={slug} onClick={() => startEdit('address')} disabled={locked} />
        )}
      </ActionGroup>
      {onReorder ? (
        <ActionGroup>
          <ActionRow
            label="Reorder photographs"
            icon={DETAILS_ICONS.reorder()}
            value={mediaCount.stills + mediaCount.videos + (mediaCount.hidden ?? 0)}
            onClick={onReorder}
            disabled={locked}
          />
        </ActionGroup>
      ) : null}
      <ActionGroup>
        <ActionRow
          label={readState === 'busy' ? 'Refreshing…' : 'Refresh gallery contents'}
          icon={DETAILS_ICONS.refresh()}
          onClick={readFolderAgain}
          disabled={locked || readState === 'busy'}
        />
      </ActionGroup>
      {readNote ? <p class="m-error" role="alert">{readNote}</p> : null}
      <ActionGroup>
        {confirmingRemove ? (
          <div class="m-owner-confirm" role="group" aria-label={`Confirm removal of ${liveTitle}`}>
            <p class="m-owner-confirm-text">Remove “{liveTitle}”?</p>
            <div class="m-owner-edit-actions">
              <Button variant="secondary" disabled={removeBusy} onClick={() => { setConfirmingRemove(false); setRemoveNote(null) }}>Cancel</Button>
              <Button variant="destructive" disabled={removeBusy} onClick={removeGallery}>{removeBusy ? 'Removing…' : 'Remove'}</Button>
            </div>
            {removeNote ? <p class="m-error" role="alert">{removeNote}</p> : null}
          </div>
        ) : (
          <ActionRow
            label="Remove gallery"
            icon={DETAILS_ICONS.remove()}
            tone="destructive"
            onClick={() => { setConfirmingRemove(true); setRemoveNote(null) }}
          />
        )}
      </ActionGroup>
      <p class="m-owner-panel-note">Removing it leaves every photograph in {sourceLabel}.</p>
    </div>
  )
}
