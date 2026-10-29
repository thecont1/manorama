import { useEffect, useRef, useState } from 'hono/jsx'
import { applyTheme, readStoredTheme, storeTheme, type Theme } from '../lib/owner-theme'
import type { GalleryImage } from '../lib/imagesource'
import type { GallerySummary } from '../lib/gallery-repository'
import { friendlySourceError } from '../lib/source-errors'
import { PIPELINE_LOCK_MESSAGE, FREE_RETAINED_LIMIT, PAID_RETAINED_LIMIT, isGalleryExpired } from '../lib/gallery-policy'
import type { AuthProvider } from '../lib/identity-repository'
import { encodeStripeAccountRef } from '../lib/stripe-account-ref'
import { readRuntimeFoldLayout, subscribeToRuntimeFoldLayout } from '../../native/lib/fold'
import { CopyIcon, OpenIcon, RefreshIcon, SourceIcon, TrashIcon } from '../components/admin-icons'
import { AddGallerySheet } from '../components/AddGallerySheet'
import { GalleryShareSheet } from '../components/GalleryShareSheet'
import { GalleryDetailsView } from '../components/GalleryDetailsView'
import { GalleryEditSheet, type GalleryEditField } from '../components/GalleryEditSheet'
import { WebSettings, type AccountIdentityWeb } from '../components/WebSettings'
import { WebReorderView } from '../components/WebReorderView'
import { copyText } from '../lib/gallery-share'

type Props = {
  galleries: readonly GallerySummary[]
  owner: string
  ownerName?: string
  publicHost: string
  tier?: 'free' | 'pro'
  accountId?: string
  upgradeUrl?: string
}
type EditableField = 'title' | 'caption' | 'slug'
type Editing = { slug: string; field: EditableField } | null
type ReorderableGalleryImage = GallerySummary['images'][number]
type AccountIdentity = AccountIdentityWeb

const SIGN_IN_METHODS: readonly { provider: AuthProvider; name: string }[] = [
  { provider: 'dropbox', name: 'Dropbox' },
  { provider: 'google', name: 'Google' },
  { provider: 'apple', name: 'Apple' },
]
const signInMethodName = (provider: string) =>
  SIGN_IN_METHODS.find((method) => method.provider === provider)?.name ?? provider

const imagePreview = (image: GalleryImage | ReorderableGalleryImage) => image.variants?.[0]?.src ?? image.src

/** Summary items gain `type: 'video'` only for videos — an absent `type`
 *  is an image, exactly as in the stored manifest. */
const isVideoPreview = (image: ReorderableGalleryImage): image is ReorderableGalleryImage & { type: 'video'; durationSeconds?: number } =>
  (image as { type?: string }).type === 'video'
const itemKind = (image: ReorderableGalleryImage) => isVideoPreview(image) ? 'video' : 'image'
const videoBadge = (image: ReorderableGalleryImage) => {
  const seconds = isVideoPreview(image) ? image.durationSeconds : undefined
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '▶'
  const total = Math.round(seconds)
  return `▶ ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
const sortRecent = (items: readonly GallerySummary[]) => [...items].sort((a, b) => {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : 0
  const bTime = b.createdAt ? Date.parse(b.createdAt) : 0
  return bTime - aTime || a.title.localeCompare(b.title)
})

const isLocked = (gallery: GallerySummary) => gallery.retention === 'pipeline'

/** After a new gallery card mounts, bring it fully into view: centered with
 *  breathing room when it fits, top-parked with a margin when it doesn't.
 *  Fires in the same frame the card renders — just as its strip images begin
 *  streaming in. */
const scrollToGalleryCard = (slug: string) => {
  requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(`[data-gallery-card="${slug}"]`)
    if (!card) return
    const rect = card.getBoundingClientRect()
    const margin = Math.min(96, Math.max(24, Math.round(window.innerHeight * 0.08)))
    const fits = rect.height + margin * 2 <= window.innerHeight
    const top = window.scrollY + (fits ? rect.top - (window.innerHeight - rect.height) / 2 : rect.top - margin)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' })
  })
}

/** The Details "Source" line names the provider behind a gallery's link. */
const sourceLabelFor = (url?: string): string => {
  if (!url) return 'Manorama'
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host.includes('dropbox.com')) return 'Dropbox'
    if (host.includes('drive.google.com')) return 'Google Drive'
    if (host.includes('icloud.com')) return 'iCloud'
    if (host.includes('mega.nz')) return 'MEGA'
  } catch {
    // Fall through to the generic label.
  }
  return 'shared folder'
}

/** Renders the owner's dashboard for importing, editing, and managing galleries. */
export default function Admin({ galleries: initialGalleries, owner, ownerName, publicHost, tier = 'free', accountId, upgradeUrl }: Props) {
  const [galleries, setGalleries] = useState<GallerySummary[]>(sortRecent(initialGalleries))
  const [sourceUrl, setSourceUrl] = useState('')
  const [addName, setAddName] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [reorderSlug, setReorderSlug] = useState<string | null>(null)
  // A failed draft save stays visible inside the reorder overlay instead of
  // only in the toast behind it.
  const [reorderNote, setReorderNote] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // In-progress messages are sticky: they hold until the outcome
  // announcement replaces them, so the toast never outlives "Working…".
  const announce = (message: string, sticky = false) => {
    setStatus(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    if (!sticky && message) toastTimer.current = setTimeout(() => setStatus(''), 5000)
  }
  const blockPipelineEdit = (gallery: GallerySummary) => {
    if (!isLocked(gallery)) return false
    announce(PIPELINE_LOCK_MESSAGE)
    return true
  }
  // Flash messages survive the redirect that follows an owner-slug change.
  const flashChecked = useRef(false)
  if (!flashChecked.current && typeof sessionStorage !== 'undefined') {
    flashChecked.current = true
    const flash = sessionStorage.getItem('manorama-toast')
    if (flash) { sessionStorage.removeItem('manorama-toast'); announce(flash) }
  }
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // The account's sign-in methods — null until the identities answer lands.
  const [identities, setIdentities] = useState<AccountIdentity[] | null>(null)
  const [identityNote, setIdentityNote] = useState('')
  // Account deletion waits on a typed URL name so a stray tap cannot fire it.
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteNote, setDeleteNote] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  // Owner slug save errors surface inside Settings, not in a toast that the
  // fixed surface would cover.
  const [settingsNote, setSettingsNote] = useState('')
  // Actions taken inside Details (refresh, remove, save) announce in the
  // Details surface itself; the library toast lives behind it.
  const [detailsNote, setDetailsNote] = useState<string | null>(null)
  const [detailsSlug, setDetailsSlug] = useState<string | null>(null)
  const [editField, setEditField] = useState<GalleryEditField | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editNote, setEditNote] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])

  const refreshIdentities = async () => {
    try {
      const response = await fetch('/api/account/identities')
      const payload = await response.json() as { identities?: AccountIdentity[] }
      if (response.ok && payload.identities) setIdentities(payload.identities)
    } catch {
      // A failed read just leaves the methods list hidden.
    }
  }

  // The OAuth link callback lands back here on `?linked=` / `?link=conflict`;
  // the params become a one-line note and are stripped so a refresh is quiet.
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await fetch('/api/account/identities')
        const payload = await response.json() as { identities?: AccountIdentity[] }
        if (active && response.ok && payload.identities) setIdentities(payload.identities)
      } catch {
        // A failed read just leaves the methods list hidden.
      }
    })()
    const params = new URLSearchParams(window.location.search)
    const linked = params.get('linked')
    if (linked) {
      setIdentityNote(`${signInMethodName(linked)} connected.`)
    } else if (params.get('link') === 'conflict') {
      setIdentityNote('That sign-in method belongs to a different account.')
    }
    if (params.has('linked') || params.has('link')) {
      params.delete('linked')
      params.delete('link')
      window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`)
    }
    return () => { active = false }
  }, [])

  const removeIdentity = async (provider: AuthProvider) => {
    try {
      const response = await fetch(`/api/account/identities/${provider}`, { method: 'DELETE' })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) {
        setIdentityNote(payload.error === 'last-identity'
          ? 'Keep at least one way to sign in.'
          : 'That sign-in method could not be removed.')
        return
      }
      setIdentityNote('')
      await refreshIdentities()
    } catch {
      setIdentityNote('That sign-in method could not be removed.')
    }
  }

  const removeAccount = async () => {
    setDeleteNote('')
    setDeleteBusy(true)
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: deleteConfirm.trim() }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Your account could not be deleted right now')
      // The API has already expired the session cookie; leaving for the
      // landing drops the owner straight into the signed-out state.
      window.location.assign('/')
    } catch (error) {
      setDeleteNote(error instanceof Error ? error.message : 'Your account could not be deleted right now')
      setDeleteBusy(false)
    }
  }

  const [ownerSlugDraft, setOwnerSlugDraft] = useState(owner)
  const [adsShow, setAdsShow] = useState(false)
  const [theme, setTheme] = useState<Theme>(() =>
    readStoredTheme(typeof localStorage === 'undefined' ? null : localStorage))

  // The web account surface carries the same sponsored slot the native
  // Library does. Undefined (offline, unanswered) means show — suppression
  // is a courtesy switch, not a gate.
  useEffect(() => {
    let live = true
    void fetch('/api/ads/visibility')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        if (live) setAdsShow(payload !== null ? (payload as { show?: boolean }).show !== false : true)
      })
      .catch(() => { if (live) setAdsShow(true) })
    return () => { live = false }
  }, [])

  // Quick-add resume. The `manorama_oauth_next` cookie is the real record
  // of an interrupted /<share-url> flow; this is the fallback for when it
  // expired (10 min) but the visitor did finish signing in. Cleared on
  // read either way, so it can never fire twice.
  useEffect(() => {
    let pending: string | null = null
    try {
      pending = localStorage.getItem('manorama:pending-source')
      if (pending) localStorage.removeItem('manorama:pending-source')
    } catch {
      return
    }
    if (!pending) return
    // Already handled by the OAuth `next` redirect if a gallery from this
    // link exists — addGallery's 409 path reports that harmlessly.
    setSourceUrl(pending)
    setAddOpen(true)
    announce('Your shared link is ready to add — press Add gallery to finish.')
  }, [])

  useEffect(() => {
    applyTheme(theme, document.documentElement)
    storeTheme(localStorage, theme)
  }, [theme])

  // The account lives in a slide-out pane so the galleries can use the page's
  // full width. It opens closed on every load and is never encoded in the URL.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const pageRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    pageRef.current?.setAttribute('data-admin-ready', 'true')
    const sync = () => {
      const page = pageRef.current
      if (!page) return
      const [left, right] = readRuntimeFoldLayout().controlRegions
      const segmented = Boolean(left && right && right.x > left.x + left.width)
      page.toggleAttribute('data-admin-segmented', segmented)
      if (segmented) {
        page.style.setProperty('--admin-left-end', `${left.x + left.width}px`)
        page.style.setProperty('--admin-right-start', `${right.x}px`)
        page.style.setProperty('--admin-pane-limit', `${left.x + left.width}px`)
      } else {
        for (const name of ['--admin-left-end', '--admin-right-start', '--admin-pane-limit']) page.style.removeProperty(name)
      }
    }
    sync()
    return subscribeToRuntimeFoldLayout(sync)
  }, [])
  const closeMenu = () => {
    setMenuOpen(false)
    menuButtonRef.current?.focus()
  }
  // Focus enters the pane, Tab stays inside it, and Esc hands the caret back to
  // the button that opened it.
  useEffect(() => {
    if (!menuOpen) return
    const panel = drawerRef.current
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), summary')]
        .filter((element) => element.getClientRects().length > 0)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
    }
  }, [menuOpen])

  // Browser Back/Forward across the Details and Settings surfaces. Each full
  // surface occupies one history entry ({surface} state + search param); a
  // popstate moves the app back to whichever surface the entry names, and a
  // plain library entry closes everything. Opening Details from the viewer's
  // `?details=<slug>&photo=<id>` navigation needs no push — Back from there
  // falls through to the viewer page itself.
  const initialDetailsRef = useRef<string | null>(null)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const slug = params.get('details')
    if (slug && galleries.some((gallery) => gallery.slug === slug)) {
      initialDetailsRef.current = slug
      setDetailsSlug(slug)
    } else if (params.get('settings') === '1') {
      setSettingsOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const state = event.state as { surface?: string; slug?: string } | null
      if (state?.surface === 'details') {
        setDetailsSlug(state.slug ?? null)
        setShareOpen(false)
      } else if (state?.surface === 'settings') {
        setSettingsOpen(true)
      } else {
        setDetailsSlug(null)
        setSettingsOpen(false)
        setShareOpen(false)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const openDetails = (slug: string) => {
    if (!galleries.some((gallery) => gallery.slug === slug)) return
    setDetailsSlug(slug)
    setDetailsNote(null)
    setShareOpen(false)
    const params = new URLSearchParams(window.location.search)
    params.set('details', slug)
    window.history.pushState({ surface: 'details', slug }, '', `${window.location.pathname}?${params}`)
  }
  const closeDetails = () => {
    if (!detailsSlug) return
    window.history.back()
  }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = () => {
    setMenuOpen(false)
    setSettingsOpen(true)
    setSettingsNote('')
    const params = new URLSearchParams(window.location.search)
    params.set('settings', '1')
    window.history.pushState({ surface: 'settings' }, '', `${window.location.pathname}?${params}`)
  }
  const closeSettings = () => {
    if (!settingsOpen) return
    window.history.back()
  }

  const panState = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null)
  const activeTouchPointers = useRef<Set<number>>(new Set())
  const saveEditingInFlight = useRef(false)

  const galleryPath = (slug: string) => `/${owner}/${slug}`
  const galleryAddress = (slug: string) => `${publicHost}${galleryPath(slug)}`

  const cancelOwnerSlugEditing = () => {
    setOwnerSlugDraft(owner)
  }

  /** Changes the owner URL and follows the dashboard to its new address.
   * The gentle reminder below the field notes the consequence before the
   * save, not after. */
  const saveOwnerSlug = async () => {
    const value = ownerSlugDraft.trim().toLowerCase()
    if (value.length < 3 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      setSettingsNote('Use at least 3 lowercase letters, numbers, and single hyphens')
      return
    }
    if (value === owner) {
      cancelOwnerSlugEditing()
      return
    }
    if (busy) return
    setBusy(true)
    setSettingsNote('')
    try {
      const response = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerSlug: value }),
      })
      const payload = await response.json() as { ownerSlug?: string; error?: string }
      if (!response.ok || !payload.ownerSlug) throw new Error(payload.error || 'That URL could not be saved')
      sessionStorage.setItem('manorama-toast', `Your address is now manorama.xyz/${payload.ownerSlug}`)
      window.location.assign(`/${payload.ownerSlug}`)
    } catch (error) {
      setSettingsNote(error instanceof Error ? error.message : 'That URL could not be saved')
      setBusy(false)
    }
  }

  // Resolves to the failure message so the open reorder view can show it
  // beside its status line; null means the order was saved.
  const persistGalleryOrder = async (gallery: GallerySummary, images: GallerySummary['images']): Promise<string | null> => {
    if (blockPipelineEdit(gallery)) return PIPELINE_LOCK_MESSAGE
    if (busy) return 'Still saving — try again in a moment.'
    setBusy(true)
    announce('Saving order…', true)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: images.map((image) => image.ref ?? image.filename) }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      if (!response.ok || !payload.gallery) throw new Error(payload.error || 'That order could not be saved')
      setGalleries((previous) => sortRecent(previous.map((item) => item.slug === payload.gallery!.slug ? payload.gallery! : item)))
      announce('Order saved')
      return null
    } catch (error) {
      setGalleries((previous) => previous.map((item) => item.slug === gallery.slug ? gallery : item))
      const message = error instanceof Error ? error.message : 'That order could not be saved'
      announce(message)
      return message
    } finally {
      setBusy(false)
    }
  }

  const saveDraftOrder = async (gallery: GallerySummary, orderKeys: readonly string[]) => {
    const byKey = new Map(gallery.images.map((image) => [image.ref ?? image.filename, image]))
    const images = orderKeys.map((key) => byKey.get(key)).filter((image): image is GallerySummary['images'][number] => image !== undefined)
    if (images.length !== gallery.images.length) {
      setReorderNote('That order could not be saved')
      announce('That order could not be saved')
      return
    }
    const failure = await persistGalleryOrder(gallery, images)
    if (failure) { setReorderNote(failure); return }
    setReorderNote(null)
    setReorderSlug(null)
  }

  const trackTouchPointer = (event: PointerEvent) => {
    if (event.pointerType === 'touch') activeTouchPointers.current.add(event.pointerId)
  }

  const startStripPan = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      if (activeTouchPointers.current.size < 2) return
    } else if (event.target !== event.currentTarget) {
      return
    }
    const frame = event.currentTarget as HTMLDivElement
    try { frame.setPointerCapture(event.pointerId) } catch {}
    panState.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: frame.scrollLeft }
    event.preventDefault()
  }

  const moveStripPan = (event: PointerEvent) => {
    if (panState.current?.pointerId !== event.pointerId) return
    const frame = event.currentTarget as HTMLDivElement
    frame.scrollLeft = panState.current.startScrollLeft - (event.clientX - panState.current.startX)
    event.preventDefault()
  }

  const finishStripPan = (event: PointerEvent) => {
    if (event.pointerType === 'touch') activeTouchPointers.current.delete(event.pointerId)
    if (panState.current?.pointerId === event.pointerId) panState.current = null
  }

  const addGallerySubmit = async (input: { url: string; name: string }) => {
    const url = input.url.trim()
    if (!url) return
    setAddError(null)
    setBusy(true)
    announce('Adding gallery…', true)
    try {
      const response = await fetch('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, ...(input.name ? { title: input.name } : {}) }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      // 409 "already exists" still carries the gallery — that is a
      // successful reopen, not a scan failure: keep the card, point at it,
      // and say so instead of showing a could-not-read error.
      if (response.status === 409 && payload.gallery) {
        setGalleries((previous) => sortRecent([...previous.filter((item) => item.slug !== payload.gallery!.slug), payload.gallery!]))
        setSourceUrl('')
        setAddName('')
        setAddOpen(false)
        scrollToGalleryCard(payload.gallery.slug)
        announce(payload.error || 'That link is already one of your galleries.')
        return
      }
      if (!response.ok || !payload.gallery) {
        if (response.status === 403) { announce(''); setAddError(payload.error || 'That gallery could not be added'); return }
        throw new Error(payload.error || 'That gallery could not be added')
      }
      setGalleries((previous) => sortRecent([...previous.filter((item) => item.slug !== payload.gallery!.slug), payload.gallery!]))
      setSourceUrl('')
      setAddName('')
      setAddOpen(false)
      scrollToGalleryCard(payload.gallery.slug)
      announce('Done! ' + payload.gallery.title + ' is at the top.')
    } catch (error) {
      announce('')
      setAddError(friendlySourceError(error))
    } finally {
      setBusy(false)
    }
  }
  const beginEditing = (gallery: GallerySummary, field: EditableField) => {
    if (blockPipelineEdit(gallery)) return
    setEditing({ slug: gallery.slug, field })
    setDraft(gallery[field])
    announce('')
  }

  const cancelEditing = () => {
    setEditing(null)
    setDraft('')
  }

  const saveEditing = async () => {
    if (!editing || saveEditingInFlight.current) return
    const current = galleries.find((item) => item.slug === editing.slug)
    if (current && blockPipelineEdit(current)) return
    const editingSlug = editing.slug
    const value = draft.trim()
    if (editing.field === 'title' && !value) {
      announce('A gallery title cannot be empty')
      return
    }
    if (editing.field === 'slug' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      announce('Use lowercase letters, numbers, and single hyphens for the gallery URL')
      return
    }
    saveEditingInFlight.current = true
    setBusy(true)
    announce('Saving…', true)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(editing.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // The URL slug is the resource identity; a rename is `newSlug`.
        body: JSON.stringify(editing.field === 'slug' ? { newSlug: value } : { [editing.field]: value }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      if (!response.ok || !payload.gallery) throw new Error(payload.error || 'That change could not be saved')
      setGalleries((previous) => sortRecent(previous.map((item) => item.slug === editingSlug ? payload.gallery! : item)))
      setEditing(null)
      setDraft('')
      announce('Saved')
    } catch (error) {
      announce(error instanceof Error ? error.message : 'That change could not be saved')
    } finally {
      saveEditingInFlight.current = false
      setBusy(false)
    }
  }

  const copyGalleryAddress = async (gallery: GallerySummary) => {
    const address = `https://${galleryAddress(gallery.slug)}`
    try {
      await navigator.clipboard.writeText(address)
      announce('Gallery link copied')
    } catch {
      const field = document.createElement('textarea')
      field.value = address
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      document.execCommand('copy')
      field.remove()
      announce('Gallery link copied')
    }
  }

  const removeGallery = async (gallery: GallerySummary) => {
    if (!window.confirm(`Remove “${gallery.title}” from Manorama?`)) return
    setBusy(true)
    announce('Removing gallery…', true)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}`, { method: 'DELETE' })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'That gallery could not be removed')
      setGalleries((previous) => previous.filter((item) => item.slug !== gallery.slug))
      announce('Gallery removed')
    } catch (error) {
      announce(error instanceof Error ? error.message : 'That gallery could not be removed')
    } finally {
      setBusy(false)
    }
  }

  const refreshGallery = async (gallery: GallerySummary) => {
    if (blockPipelineEdit(gallery)) return
    if (!gallery.sourceUrl) return
    setBusy(true)
    announce(`Refreshing “${gallery.title}”…`, true)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}/refresh`, { method: 'POST' })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      if (!response.ok) throw new Error(payload.error || 'That gallery could not be refreshed')
      if (payload.gallery) {
        setGalleries((previous) => previous.map((item) => item.slug === gallery.slug ? payload.gallery! : item))
      }
      announce(`“${gallery.title}” refreshed`)
    } catch (error) {
      announce(error instanceof Error ? error.message : 'That gallery could not be refreshed')
    } finally {
      setBusy(false)
    }
  }

  // Details-surface variants of the same management commands: they report in
  // the Details note slot because the library toast sits behind the fixed
  // surface. Remove closes the surface, returning where the owner came from.
  const refreshGalleryFromDetails = async (gallery: GallerySummary) => {
    if (blockPipelineEdit(gallery)) return
    if (!gallery.sourceUrl) return
    setBusy(true)
    setDetailsNote(null)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}/refresh`, { method: 'POST' })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      if (!response.ok) throw new Error(payload.error || 'That gallery could not be refreshed')
      if (payload.gallery) {
        setGalleries((previous) => previous.map((item) => item.slug === gallery.slug ? payload.gallery! : item))
      }
      setDetailsNote(`“${gallery.title}” refreshed`)
    } catch (error) {
      setDetailsNote(error instanceof Error ? error.message : 'That gallery could not be refreshed')
    } finally {
      setBusy(false)
    }
  }

  const removeGalleryFromDetails = async (gallery: GallerySummary) => {
    if (!window.confirm(`Remove “${gallery.title}” from Manorama?`)) return
    setBusy(true)
    setDetailsNote(null)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}`, { method: 'DELETE' })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'That gallery could not be removed')
      setGalleries((previous) => previous.filter((item) => item.slug !== gallery.slug))
      setShareOpen(false)
      if (initialDetailsRef.current === gallery.slug) {
        // Deep-linked from the viewer: the gallery the viewer was showing is
        // gone, so land on the library instead of walking back into a 404.
        window.location.assign(galleryPath('').replace(/\/$/, ''))
      } else {
        window.history.back()
      }
    } catch (error) {
      setDetailsNote(error instanceof Error ? error.message : 'That gallery could not be removed')
    } finally {
      setBusy(false)
    }
  }

  const saveEditFromDetails = async (value: string) => {
    if (!editField || !detailsSlug || saveEditingInFlight.current) return
    const gallery = galleries.find((item) => item.slug === detailsSlug)
    if (!gallery) return
    if (blockPipelineEdit(gallery)) return
    const field = editField
    if (field === 'name' && !value) {
      setEditNote('A gallery title cannot be empty')
      return
    }
    if (field === 'address' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      setEditNote('Use lowercase letters, numbers, and single hyphens for the gallery URL')
      return
    }
    saveEditingInFlight.current = true
    setBusy(true)
    setEditNote(null)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(field === 'address' ? { newSlug: value } : { [field === 'name' ? 'title' : 'caption']: value }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      if (!response.ok || !payload.gallery) throw new Error(payload.error || 'That change could not be saved')
      const updated = payload.gallery
      setGalleries((previous) => sortRecent(previous.map((item) => item.slug === gallery.slug ? updated : item)))
      setEditField(null)
      setEditValue('')
      setDetailsNote('Saved')
      if (updated.slug !== gallery.slug) {
        // A rename changes the Details target: retarget the entry so
        // refresh and Back/Forward keep pointing at the same gallery.
        setDetailsSlug(updated.slug)
        const params = new URLSearchParams(window.location.search)
        params.set('details', updated.slug)
        window.history.replaceState({ surface: 'details', slug: updated.slug }, '', `${window.location.pathname}?${params}`)
      }
    } catch (error) {
      setEditNote(error instanceof Error ? error.message : 'That change could not be saved')
    } finally {
      saveEditingInFlight.current = false
      setBusy(false)
    }
  }

  const openGalleryTab = (gallery: GallerySummary) => {
    const anchor = document.createElement('a')
    anchor.href = `https://${galleryAddress(gallery.slug)}`
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const reorderFromDetails = (gallery: GallerySummary) => {
    if (blockPipelineEdit(gallery)) return
    setReorderNote(null)
    setReorderSlug(gallery.slug)
    closeDetails()
  }

  const editableText = (gallery: GallerySummary, field: EditableField, className: string) => {
    const isEditing = editing?.slug === gallery.slug && editing.field === field
    if (isEditing) {
      const common = {
        value: draft,
        ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
          if (!el || el === document.activeElement) return
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        },
        'aria-label': `Edit gallery ${field}`,
        disabled: busy,
        onInput: (event: Event) => setDraft((event.target as HTMLInputElement | HTMLTextAreaElement).value),
        onBlur: () => { void saveEditing() },
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key === 'Escape') cancelEditing()
          if (event.key === 'Enter' && (field === 'title' || field === 'slug')) { event.preventDefault(); void saveEditing() }
          if (event.key === 'Enter' && field === 'caption' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void saveEditing() }
        },
      }
      return field === 'caption' ? <textarea class={`${className} is-editing`} rows={3} {...common} /> : <input class={`${className} is-editing`} type="text" {...common} />
    }
    const text = gallery[field] || (field === 'caption' ? 'Add a caption' : gallery.title)
    const displayText = text
    return <button type="button" class={`${className} editable-value${gallery[field] ? '' : ' is-empty'}`} aria-label={`Edit gallery ${field}: ${text}`} aria-disabled={isLocked(gallery) ? 'true' : undefined} aria-describedby={isLocked(gallery) ? `retention-${gallery.slug}` : undefined} title={isLocked(gallery) ? PIPELINE_LOCK_MESSAGE : undefined} onClick={() => beginEditing(gallery, field)}>{displayText}</button>
  }

  // A card can cross its expiry while the dashboard stays open (the `now`
  // ticker rerenders every minute): expired pipeline galleries are already
  // gone logically and drop out of the next fetch, so skip them here too.
  const liveGalleries = galleries.filter((gallery) => !isGalleryExpired(gallery, new Date(now).toISOString()))
  const retainedCount = liveGalleries.filter((gallery) => gallery.retention !== 'pipeline').length
  const retainedLimit = tier === 'pro' ? PAID_RETAINED_LIMIT : FREE_RETAINED_LIMIT
  const detailsGallery = detailsSlug ? liveGalleries.find((gallery) => gallery.slug === detailsSlug) ?? null : null
  const upgradeHref = upgradeUrl && accountId ? `${upgradeUrl}?client_reference_id=${encodeStripeAccountRef(accountId)}` : 'mailto:mahesh@thecontrarian.in?subject=Manorama%20upgrade'

  return (
    <>
      <main class="admin-page admin-page--selector" ref={pageRef}>
      {/* Account tools live at the edge; the photographs keep the page width.
          The tab belongs to the dashboard only, never to the viewing stage. */}
      <button
        type="button"
        class="admin-edge-tab"
        aria-label="Account menu"
        aria-expanded={menuOpen ? 'true' : 'false'}
        aria-controls="admin-account-drawer"
        ref={menuButtonRef}
        onClick={() => setMenuOpen(true)}
      >
        <span class="admin-tab-label" aria-hidden="true">Account</span>
        <svg class="admin-hamburger" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        <svg class="admin-tab-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      {/* The account drawer is now a short navigation menu: the account and
          plan controls live on the full Settings surface. */}
      <div class="admin-drawer" id="admin-account-drawer" data-account-drawer hidden={!menuOpen}>
      <div class="admin-drawer-scrim" aria-hidden="true" onClick={closeMenu} />
      <aside class="admin-drawer-panel" role="dialog" aria-modal="true" aria-label="Account" ref={drawerRef}>
      <button type="button" class="admin-drawer-close" aria-label="Close account menu" onClick={closeMenu}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      <div class="admin-left">
      <header class="admin-header">
        <div>
          <p class="admin-brand-title"><span class="brand-mark-wrap"><img class="admin-brand-logo" src="/manorama-merged-logo.png" alt="manorama" /><span class="brand-tld" aria-hidden="true">.xyz</span></span></p>
        </div>
      </header>
      <nav class="admin-account-nav" aria-label="Account">
        <button type="button" class="admin-account-nav-item" onClick={() => { closeMenu(); openSettings() }}>Settings</button>
        <a class="admin-account-nav-item" href="/privacy">Privacy Policy</a>
      </nav>
      <footer class="site-footer">
        <a class="site-footer-link" href="/privacy">Privacy Policy</a>
        <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a href="https://thecontrarian.in">thecontrarian.in</a></p>
      </footer>
      </div>
      </aside>
      </div>

      {/* Import and curation remain usable at any window or segment width. */}
      <div class="admin-content">
      <section class="gallery-list" aria-labelledby="galleries-heading">
        <div class="admin-library-heading">
          <h1 class="admin-galleries-heading" id="galleries-heading">Library</h1>
          <button type="button" class="admin-button admin-button--solid" onClick={() => { setAddError(null); setAddOpen(true) }} disabled={busy}>Add</button>
        </div>
        {adsShow ? (
          /* The sponsored panel sits between the Library heading and the
             cards — the same portrait-shaped house slot as native. */
          <aside class="account-ad" aria-label="Sponsored: manorama">
            <span class="account-ad-badge">Sponsored</span>
            <div class="account-ad-slot">
              <div class="account-ad-frame">
                <span class="account-ad-placeholder">Vertical photograph, fit to height</span>
              </div>
              <div class="account-ad-copy">
                <strong class="account-ad-headline">More photographs, quietly shared.</strong>
                <span class="account-ad-sub">A placeholder until sponsored photographs arrive.</span>
                <a class="account-ad-cta" href="https://manorama.xyz" target="_blank" rel="noopener">Explore manorama</a>
              </div>
            </div>
          </aside>
        ) : null}
        {liveGalleries.length ? <div class="admin-gallery-list">{liveGalleries.map((gallery) => <article class="admin-gallery-card" key={gallery.slug} data-gallery-card={gallery.slug} data-retention={gallery.retention}>
          <div class="admin-gallery-card-body"><div class="admin-gallery-title-row">{editableText(gallery, 'title', 'admin-gallery-title')}<span class="admin-gallery-count" aria-label={`${gallery.imageCount} photos`}>({gallery.imageCount} photos)</span></div>{editableText(gallery, 'caption', 'admin-gallery-caption')}</div>
          {isLocked(gallery) && gallery.expiresAt ? <div class="admin-gallery-retention" id={`retention-${gallery.slug}`}>
            <p>Temporary · {Math.max(0, Math.ceil((Date.parse(gallery.expiresAt) - now) / 86_400_000))} days left</p>
            <p>Expires <time dateTime={gallery.expiresAt}>{gallery.expiresAt.replace('T', ' ').replace('.000Z', ' UTC')}</time>. Permanently removed from Manorama after 30 days unless you upgrade before expiry.</p>
            {/* client_reference_id is how the Stripe webhook maps a
                completed checkout back to this account — hex-encoded because
                Stripe drops ids outside its safe charset. Never strip it. */}
            <p>{PIPELINE_LOCK_MESSAGE} <a href={upgradeHref}>Upgrade</a></p>
          </div> : null}
          <div class="gallery-card-url-row"><button type="button" class="admin-icon-action" title="Copy gallery link" aria-label={`Copy ${gallery.title} link`} onClick={() => copyGalleryAddress(gallery)}><CopyIcon /></button><div class="admin-gallery-url"><span class="admin-gallery-url-prefix">{publicHost}{galleryPath('').replace(/\/$/, '')}/</span>{editableText(gallery, 'slug', 'admin-gallery-slug')}</div></div>
          <div class="admin-gallery-strip-frame" aria-label={`${gallery.title} images`} onPointerDownCapture={trackTouchPointer} onPointerDown={startStripPan} onPointerMove={moveStripPan} onPointerUp={finishStripPan} onPointerCancel={finishStripPan} onWheel={(event) => { const frame = event.currentTarget as HTMLDivElement; const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX; frame.scrollLeft += delta; event.preventDefault() }}>
            <div class="admin-gallery-strip" role="list" aria-label={`${gallery.title} photographs`}>
              {gallery.images.map((image, imageIndex) => <figure class="admin-gallery-strip-item" role="listitem" key={image.id} data-image-id={image.id} aria-label={`${image.filename}, ${itemKind(image)} ${imageIndex + 1} of ${gallery.images.length}`}>
                <img src={imagePreview(image)} alt="" loading="lazy" draggable="false" onLoad={(event: Event) => (event.currentTarget as HTMLImageElement).classList.add('is-loaded')} />
                {isVideoPreview(image) ? <span class="admin-strip-badge" aria-hidden="true">{videoBadge(image)}</span> : null}
              </figure>)}
            </div>
          </div>
          <div class="gallery-card-actions"><button type="button" class="admin-button admin-button--secondary admin-details-button" aria-label={`Open details for ${gallery.title}`} onClick={() => openDetails(gallery.slug)} disabled={busy}>Details</button><a class="admin-icon-action" title="Open gallery in a new tab" aria-label={`Open ${gallery.title} in a new tab`} href={galleryPath(gallery.slug)} target="_blank" rel="noreferrer"><OpenIcon /></a>{gallery.sourceUrl ? <a class="admin-icon-action" title={gallery.sourceUrl} aria-label={`Open the ${gallery.title} source at ${gallery.sourceUrl}`} href={gallery.sourceUrl} target="_blank" rel="noreferrer"><SourceIcon /></a> : null}{gallery.sourceUrl ? <button type="button" class="admin-icon-action" title={isLocked(gallery) ? PIPELINE_LOCK_MESSAGE : 'Refresh from source'} aria-label={`Refresh ${gallery.title} from its source link`} aria-disabled={isLocked(gallery) ? 'true' : undefined} aria-describedby={isLocked(gallery) ? `retention-${gallery.slug}` : undefined} onClick={() => refreshGallery(gallery)} disabled={busy}><RefreshIcon /></button> : null}<button type="button" class="admin-icon-action admin-icon-action--delete" title="Delete gallery" aria-label={`Delete ${gallery.title}`} onClick={() => removeGallery(gallery)} disabled={busy}><TrashIcon /></button></div>
        </article>)}</div> : <p class="quiet-copy">No galleries are published yet. Add one above to begin.</p>}
      </section>
      {/* The plan line is the only account copy on the Library — quiet
          normally; Settings › Plan carries the detail. */}
      <footer class="admin-lib-foot">
        <span>{retainedCount <= retainedLimit ? `${retainedCount} of ${retainedLimit} galleries` : `${retainedCount} galleries`} · {tier === 'pro' ? 'Visionary' : 'Free'}</span>
        <button type="button" class="admin-button admin-button--secondary" onClick={openSettings}>Plan</button>
      </footer>
      </div>

      {status ? <div class="admin-toast" role="status" aria-live="polite">{status}</div> : null}
      </main>

      <AddGallerySheet
        open={addOpen}
        url={sourceUrl}
        name={addName}
        busy={busy}
        error={addError}
        onUrlChange={(value) => { setSourceUrl(value); setAddError(null) }}
        onNameChange={(value) => setAddName(value)}
        onClose={() => { if (!busy) { setAddOpen(false); setAddError(null) } }}
        onSubmit={(input) => void addGallerySubmit(input)}
      />

      {settingsOpen ? (
        <WebSettings
          ownerName={ownerName}
          ownerSlug={owner}
          ownerSlugDraft={ownerSlugDraft}
          onOwnerSlugDraft={(value) => { setOwnerSlugDraft(value); setSettingsNote('') }}
          onSaveOwnerSlug={() => void saveOwnerSlug()}
          ownerSlugBusy={busy}
          ownerSlugNote={settingsNote}
          identities={identities}
          identityNote={identityNote}
          onUnlinkIdentity={(provider) => void removeIdentity(provider)}
          tier={tier}
          retainedCount={retainedCount}
          retainedLimit={retainedLimit}
          upgradeHref={upgradeHref}
          theme={theme}
          onTheme={setTheme}
          deleteConfirm={deleteConfirm}
          onDeleteConfirmChange={setDeleteConfirm}
          deleteBusy={deleteBusy}
          deleteNote={deleteNote}
          onDeleteAccount={() => void removeAccount()}
          onBack={closeSettings}
        />
      ) : null}

      {detailsGallery ? (
        <>
          <GalleryDetailsView
            title={detailsGallery.title}
            caption={detailsGallery.caption}
            address={`${publicHost}/${owner}/${detailsGallery.slug}`}
            imageCount={detailsGallery.imageCount}
            sourceLabel={sourceLabelFor(detailsGallery.sourceUrl)}
            temporary={isLocked(detailsGallery)}
            expiresAt={detailsGallery.expiresAt}
            editable={!isLocked(detailsGallery)}
            busy={busy}
            note={detailsNote}
            streamOnly={false}
            platform="web"
            onStreamOnlyChange={() => {}}
            onPurge={() => {}}
            onBack={closeDetails}
            onOpen={() => openGalleryTab(detailsGallery)}
            onShare={() => { setDetailsNote(null); setShareOpen(true) }}
            onEditName={() => { setEditField('name'); setEditValue(detailsGallery.title); setEditNote(null) }}
            onEditCaption={() => { setEditField('caption'); setEditValue(detailsGallery.caption || ''); setEditNote(null) }}
            onEditAddress={() => { setEditField('address'); setEditValue(detailsGallery.slug); setEditNote(null) }}
            onReorder={() => reorderFromDetails(detailsGallery)}
            onRefresh={() => void refreshGalleryFromDetails(detailsGallery)}
            onRemove={() => void removeGalleryFromDetails(detailsGallery)}
          />
          <GalleryEditSheet
            open={editField !== null}
            field={editField}
            value={editValue}
            busy={busy}
            note={editNote}
            onValueChange={(value) => { setEditValue(value); setEditNote(null) }}
            onSubmit={(value) => void saveEditFromDetails(value)}
            onClose={() => { if (!busy) { setEditField(null); setEditNote(null) } }}
          />
          {shareOpen ? (
            <GalleryShareSheet
              payload={{
                title: detailsGallery.title,
                caption: detailsGallery.caption,
                url: `https://${galleryAddress(detailsGallery.slug)}`,
              }}
              onClose={() => setShareOpen(false)}
              onCopy={copyText}
            />
          ) : null}
        </>
      ) : null}
      {(() => {
        const reorderGallery = reorderSlug ? galleries.find((item) => item.slug === reorderSlug) : undefined
        if (!reorderGallery) return null
        return (
          <WebReorderView
            title={reorderGallery.title}
            busy={busy}
            note={reorderNote}
            images={reorderGallery.images.map((image) => ({
              id: image.id,
              orderKey: image.ref ?? image.filename,
              width: image.width,
              height: image.height,
              src: imagePreview(image),
              label: image.filename,
            }))}
            onCancel={() => { setReorderNote(null); setReorderSlug(null) }}
            onSave={(orderKeys) => { void saveDraftOrder(reorderGallery, orderKeys) }}
          />
        )
      })()}
    </>
  )
}
