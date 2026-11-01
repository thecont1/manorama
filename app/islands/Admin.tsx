import { useEffect, useRef, useState } from 'hono/jsx'
import { applyTheme, readStoredTheme, storeTheme, type Theme } from '../lib/owner-theme'
import type { GalleryImage } from '../lib/imagesource'
import type { GallerySummary } from '../lib/gallery-repository'
import { friendlySourceError } from '../lib/source-errors'
import { PIPELINE_LOCK_MESSAGE, FREE_RETAINED_LIMIT, PAID_RETAINED_LIMIT, isGalleryExpired } from '../lib/gallery-policy'
import type { AuthProvider } from '../lib/identity-repository'
import { encodeStripeAccountRef } from '../lib/stripe-account-ref'
import { readRuntimeFoldLayout, subscribeToRuntimeFoldLayout } from '../../native/lib/fold'
import { AddGallerySheet } from '../components/AddGallerySheet'
import { GalleryShareSheet } from '../components/GalleryShareSheet'
import { Sheet } from '../components/ui/Sheet'
import { GalleryDetailsView } from '../components/GalleryDetailsView'
import { GalleryEditSheet, type GalleryEditField } from '../components/GalleryEditSheet'
import { WebSettings, type AccountIdentityWeb } from '../components/WebSettings'
import { WebReorderView } from '../components/WebReorderView'
import { copyText } from '../lib/gallery-share'
import { houseAdFrameFor, type AdFrame } from '../lib/adframe'

type Props = {
  galleries: readonly GallerySummary[]
  owner: string
  ownerName?: string
  publicHost: string
  tier?: 'free' | 'pro'
  accountId?: string
  upgradeUrl?: string
  /** `?details=<slug>` carried in by the URL — resolving it at first render
   *  lets SSR paint the Details surface instead of the Library flashing by
   *  before the mount effect swaps it in. */
  initialDetails?: string
}
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
export default function Admin({ galleries: initialGalleries, owner, ownerName, publicHost, tier = 'free', accountId, upgradeUrl, initialDetails }: Props) {
  const [galleries, setGalleries] = useState<GallerySummary[]>(sortRecent(initialGalleries))
  const [sourceUrl, setSourceUrl] = useState('')
  const [addName, setAddName] = useState('')
  const [addCaption, setAddCaption] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // The link is verified before the optional fields appear — the scanned
  // title doubles as the flag and the Name placeholder.
  const [addVerifiedTitle, setAddVerifiedTitle] = useState<string | null>(null)
  const [addChecking, setAddChecking] = useState(false)
  const [reorderSlug, setReorderSlug] = useState<string | null>(null)
  // A failed draft save stays visible inside the reorder overlay instead of
  // only in the toast behind it.
  const [reorderNote, setReorderNote] = useState<string | null>(null)
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
  const [detailsSlug, setDetailsSlug] = useState<string | null>(() =>
    initialDetails && initialGalleries.some((gallery) => gallery.slug === initialDetails) ? initialDetails : null)
  const [editField, setEditField] = useState<GalleryEditField | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editNote, setEditNote] = useState<string | null>(null)
  // The card overflow sheet (···) and the share sheet it can open are keyed
  // by slug so they work without Details being mounted underneath.
  const [shareSlug, setShareSlug] = useState<string | null>(null)
  const [menuSlug, setMenuSlug] = useState<string | null>(null)
  // Remove runs as an inline confirm on the card, like the native list —
  // never a window.confirm dialog.
  const [removeSlug, setRemoveSlug] = useState<string | null>(null)
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
  const [accountAd, setAccountAd] = useState<AdFrame | null>(null)
  const [theme, setTheme] = useState<Theme>(() =>
    readStoredTheme(typeof localStorage === 'undefined' ? null : localStorage))

  // The web account surface carries the same sponsored slot the native
  // Library does. The slot stays empty until the switch answers — a
  // suppressed day should never flash the plate — but a failed fetch
  // still means show: suppression is a courtesy switch, not a gate.
  useEffect(() => {
    let live = true
    // Seeded client-side — the daily creative can't be part of the SSR
    // markup or a midnight straddle would hydrate it into the wrong frame.
    setAccountAd(houseAdFrameFor('library'))
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
        setShareSlug(null)
      } else if (state?.surface === 'settings') {
        setSettingsOpen(true)
      } else {
        setDetailsSlug(null)
        setSettingsOpen(false)
        setShareSlug(null)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const openDetails = (slug: string) => {
    if (!galleries.some((gallery) => gallery.slug === slug)) return
    setDetailsSlug(slug)
    setDetailsNote(null)
    setShareSlug(null)
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
  // Rail items are links now, so a drag that began on one must not also
  // navigate on release. The tracker watches displacement independent of
  // whether the gesture became a pan; the click is suppressed only past
  // the threshold — an ordinary tap still activates the anchor.
  const railDrag = useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null)
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
  const persistGalleryOrder = async (gallery: GallerySummary, orderKeys: readonly string[], hiddenKeys: readonly string[]): Promise<string | null> => {
    if (blockPipelineEdit(gallery)) return PIPELINE_LOCK_MESSAGE
    if (busy) return 'Still saving — try again in a moment.'
    setBusy(true)
    announce('Saving order…', true)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: [...orderKeys], hidden: [...hiddenKeys] }),
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

  const saveDraftOrder = async (gallery: GallerySummary, orderKeys: readonly string[], hiddenKeys: readonly string[]) => {
    const byKey = new Map(gallery.images.map((image) => [image.ref ?? image.filename, image]))
    const images = orderKeys.map((key) => byKey.get(key)).filter((image): image is GallerySummary['images'][number] => image !== undefined)
    if (images.length !== gallery.images.length) {
      setReorderNote('That order could not be saved')
      announce('That order could not be saved')
      return
    }
    const failure = await persistGalleryOrder(gallery, orderKeys, hiddenKeys)
    if (failure) { setReorderNote(failure); return }
    setReorderNote(null)
    setReorderSlug(null)
  }

  const trackTouchPointer = (event: PointerEvent) => {
    if (event.pointerType === 'touch') activeTouchPointers.current.add(event.pointerId)
    railDrag.current = { pointerId: event.pointerId, startX: event.clientX, moved: false }
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
    if (railDrag.current?.pointerId === event.pointerId && Math.abs(event.clientX - railDrag.current.startX) > 6) railDrag.current.moved = true
    if (panState.current?.pointerId !== event.pointerId) return
    const frame = event.currentTarget as HTMLDivElement
    frame.scrollLeft = panState.current.startScrollLeft - (event.clientX - panState.current.startX)
    event.preventDefault()
  }

  const finishStripPan = (event: PointerEvent) => {
    if (event.pointerType === 'touch') activeTouchPointers.current.delete(event.pointerId)
    if (panState.current?.pointerId === event.pointerId) panState.current = null
    // A cancelled gesture cannot end in a click; a released one may, so the
    // flag survives pointerup and is consumed by the click handler.
    if (event.type === 'pointercancel') railDrag.current = null
  }

  const suppressDraggedClick = (event: MouseEvent) => {
    if (!railDrag.current?.moved) return
    event.preventDefault()
    event.stopPropagation()
    railDrag.current = null
  }

  // Verify runs the same dry scan the create endpoint will run again —
  // a second provider call is the price of not asking for metadata on a
  // link that was never going to work.
  const addVerifySeq = useRef(0)
  const addVerifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resetAddVerification = () => {
    if (addVerifyTimer.current) clearTimeout(addVerifyTimer.current)
    addVerifySeq.current += 1
    setAddVerifiedTitle(null)
    setAddChecking(false)
  }
  const verifyAddUrl = async (url: string) => {
    const seq = ++addVerifySeq.current
    setAddChecking(true)
    try {
      const response = await fetch('/api/galleries/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const payload = await response.json() as { scan?: { title?: string }; error?: string }
      if (seq !== addVerifySeq.current) return
      if (!response.ok || !payload.scan) {
        setAddVerifiedTitle(null)
        setAddError(payload.error || 'That link could not be read')
        return
      }
      setAddError(null)
      const title = payload.scan.title ?? ''
      setAddVerifiedTitle(title)
      // The scanned name pre-fills only an untouched field — a name the
      // owner typed while the scan was in flight is never clobbered.
      setAddName((current) => current.trim() ? current : title)
    } catch {
      if (seq === addVerifySeq.current) setAddError('That link could not be checked — try again')
    } finally {
      if (seq === addVerifySeq.current) setAddChecking(false)
    }
  }
  const onAddUrlChange = (value: string) => {
    setSourceUrl(value)
    setAddError(null)
    resetAddVerification()
    const url = value.trim()
    // A plausible URL earns a debounced verify; anything shorter still
    // reads as "typing" and costs no request.
    if (/^https?:\/\/\S+\.\S+/.test(url)) {
      addVerifyTimer.current = setTimeout(() => void verifyAddUrl(url), 700)
    }
  }
  const onAddUrlCommit = (value: string) => {
    setSourceUrl(value)
    setAddError(null)
    resetAddVerification()
    const url = value.trim()
    if (/^https?:\/\/\S+\.\S+/.test(url)) void verifyAddUrl(url)
  }

  const addGallerySubmit = async (input: { url: string; name: string; caption: string }) => {
    const url = input.url.trim()
    if (!url) return
    setAddError(null)
    setBusy(true)
    announce('Adding gallery…', true)
    try {
      const response = await fetch('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, ...(input.name ? { title: input.name } : {}), ...(input.caption ? { caption: input.caption } : {}) }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      // 409 "already exists" still carries the gallery — that is a
      // successful reopen, not a scan failure: keep the card, point at it,
      // and say so instead of showing a could-not-read error.
      if (response.status === 409 && payload.gallery) {
        setGalleries((previous) => sortRecent([...previous.filter((item) => item.slug !== payload.gallery!.slug), payload.gallery!]))
        setSourceUrl('')
        setAddName('')
        setAddCaption('')
        resetAddVerification()
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
      setAddCaption('')
      resetAddVerification()
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
  const removeGallery = async (gallery: GallerySummary) => {
    setBusy(true)
    announce('Removing gallery…', true)
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}`, { method: 'DELETE' })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'That gallery could not be removed')
      setGalleries((previous) => previous.filter((item) => item.slug !== gallery.slug))
      setRemoveSlug(null)
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
      setShareSlug(null)
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
    // Reorder takes over the surface in place — it must NOT run closeDetails'
    // history.back(): Details opened from the viewer's ?details= link is this
    // tab's current entry, so popping it walks back to the gallery page and
    // unloads the dashboard under the overlay.
    setDetailsSlug(null)
    setShareSlug(null)
    const params = new URLSearchParams(window.location.search)
    // `photo` is the viewer's own back-target — dead weight on the library URL.
    params.delete('details')
    params.delete('photo')
    const query = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }

  // A card can cross its expiry while the dashboard stays open (the `now`
  // ticker rerenders every minute): expired pipeline galleries are already
  // gone logically and drop out of the next fetch, so skip them here too.
  const liveGalleries = galleries.filter((gallery) => !isGalleryExpired(gallery, new Date(now).toISOString()))
  const retainedCount = liveGalleries.filter((gallery) => gallery.retention !== 'pipeline').length
  const retainedLimit = tier === 'pro' ? PAID_RETAINED_LIMIT : FREE_RETAINED_LIMIT
  const temporaryCount = liveGalleries.filter(isLocked).length
  const detailsGallery = detailsSlug ? liveGalleries.find((gallery) => gallery.slug === detailsSlug) ?? null : null
  const menuGallery = menuSlug ? liveGalleries.find((gallery) => gallery.slug === menuSlug) ?? null : null
  const shareGallery = shareSlug ? liveGalleries.find((gallery) => gallery.slug === shareSlug) ?? null : null
  // client_reference_id is how the Stripe webhook maps a completed checkout
  // back to this account — hex-encoded because Stripe drops ids outside its
  // safe charset. Never strip it.
  const upgradeHref = upgradeUrl && accountId ? `${upgradeUrl}?client_reference_id=${encodeStripeAccountRef(accountId)}` : 'mailto:mahesh@thecontrarian.in?subject=Manorama%20upgrade'

  return (
    <>
      <main class="admin-page admin-page--selector" ref={pageRef}>
      {/* The chrome is the shared top bar: centred mark, Settings gear right.
          The edge tab and account drawer are gone (D6) — Settings is the
          pushed surface it always was, Privacy lives on it and in the site
          footer. */}
      {/* The top bar is gone — its 52px was dead space once the wordmark
          moved into the column. Settings is a pill beside Add Gallery, and
          the pushed surface it opens is unchanged: Privacy lives on it and
          in the site footer. */}
      {/* Import and curation remain usable at any window or segment width. */}
      <div class="admin-content">
      <section class={adsShow && accountAd ? 'gallery-list gallery-list--has-ad' : 'gallery-list'} aria-labelledby="galleries-heading">
        {/* The owner header leads with the wordmark in the content column —
            the mark's left edge is the heading's left edge, so the "m" sits
            squarely over the "L" of Library. */}
        <img class="admin-brand-mark" src="/manorama-merged-logo.png" alt="manorama" width="280" height="94" />
        <div class="admin-library-heading">
          <h1 class="admin-galleries-heading" id="galleries-heading">Library</h1>
          <div class="admin-heading-actions">
            <button type="button" class="admin-button admin-button--solid admin-add-pill" onClick={() => { setAddError(null); setAddOpen(true) }} disabled={busy}><span aria-hidden="true">+</span> Add Gallery</button>
            <button type="button" class="admin-button admin-settings-pill" aria-label="Settings" onClick={openSettings}>
              <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" /></svg>
            </button>
          </div>
        </div>
        <p class="admin-library-sub">{tier === 'pro' ? (
          <>You are a manorama Visionary user. You are hosting {retainedCount} of {PAID_RETAINED_LIMIT} permanent galleries.</>
        ) : (
          <>You are a manorama Free user. You are hosting {retainedCount} of {FREE_RETAINED_LIMIT} permanent galleries{temporaryCount ? ` and ${temporaryCount} temporary ${temporaryCount === 1 ? 'gallery' : 'galleries'}` : ''}. <a class="admin-upgrade-link" href={upgradeHref}>Upgrade to Visionary?</a></>
        )}</p>
        {adsShow && accountAd ? (
          /* The sponsored panel sits between the Library heading and the
             cards — the same portrait-shaped house slot as native. */
          <aside class="account-ad" aria-label={`${accountAd.badge}: ${accountAd.advertiser}`}>
            <span class="account-ad-badge">{accountAd.badge}</span>
            <div class="account-ad-media">
              {accountAd.image ? (
                accountAd.cta ? (
                  <a class="account-ad-media-link" href={accountAd.cta.url} target="_blank" rel="noopener" aria-label={accountAd.cta.label}>
                    <img src={accountAd.image.src} width={accountAd.image.width} height={accountAd.image.height} alt="" />
                  </a>
                ) : (
                  <img src={accountAd.image.src} width={accountAd.image.width} height={accountAd.image.height} alt="" />
                )
              ) : (
                <span class="account-ad-placeholder">Vertical photograph, fit to height</span>
              )}
            </div>
            <div class="account-ad-copy">
              <strong class="account-ad-headline">{accountAd.headline ?? accountAd.advertiser}</strong>
              <span class="account-ad-sub">A placeholder until sponsored photographs arrive.</span>
              {accountAd.cta ? <a class="account-ad-cta" href={accountAd.cta.url} target="_blank" rel="noopener">{accountAd.cta.label}</a> : null}
            </div>
          </aside>
        ) : null}
        {liveGalleries.length ? <ul class="lib-list">{liveGalleries.map((gallery) => {
          const title = gallery.title || gallery.slug
          const locked = isLocked(gallery)
          return <li key={gallery.slug}><article class="lib-card" data-gallery-card={gallery.slug} data-retention={gallery.retention}>
            <div class="admin-gallery-strip-frame" aria-label={`${title} images`} onPointerDownCapture={trackTouchPointer} onPointerDown={startStripPan} onPointerMove={moveStripPan} onPointerUp={finishStripPan} onPointerCancel={finishStripPan} onClickCapture={suppressDraggedClick} onWheel={(event) => { const frame = event.currentTarget as HTMLDivElement; const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX; frame.scrollLeft += delta; event.preventDefault() }}>
              <ul class="admin-gallery-strip" aria-label={`${title} photographs`}>
                {gallery.images.map((image, imageIndex) => <li class={`admin-gallery-strip-item${image.hidden ? ' is-hidden' : ''}`} key={image.id} data-image-id={image.id}>
                  <a href={galleryPath(gallery.slug)} draggable="false" aria-label={`${title}, ${image.hidden ? 'hidden ' : ''}${itemKind(image)} ${imageIndex + 1} of ${gallery.images.length}`}>
                    <img src={imagePreview(image)} alt="" loading="lazy" draggable="false" style={{ aspectRatio: `${image.width} / ${image.height}` }} onLoad={(event: Event) => {
                      const img = event.currentTarget as HTMLImageElement
                      // Stored dims are the placeholder's shape — the decoded
                      // derivative (an EXIF-rotated frame, a video poster) owns
                      // the real ratio once it lands.
                      if (img.naturalWidth && img.naturalHeight) img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
                      img.classList.add('is-loaded')
                    }} onError={(event: Event) => {
                      // A transient upstream 5xx otherwise leaves a permanent
                      // hole — the viewer's stall watchdog answers the same
                      // problem for frames; one bounded retry covers thumbs.
                      // The marker tracks the source that failed, so a src
                      // swapped in later earns its own retry, the retried
                      // load failing again does not reschedule, and the
                      // callback only fires while that source is still set.
                      const img = event.currentTarget as HTMLImageElement
                      const baseOf = (src: string) => src.replace(/([?&])mreload=\d+&?/, '$1').replace(/[?&]$/, '')
                      const failed = baseOf(img.getAttribute('src') ?? '')
                      if (!failed || img.dataset.retriedSrc === failed) return
                      img.dataset.retriedSrc = failed
                      window.setTimeout(() => {
                        if (baseOf(img.getAttribute('src') ?? '') === failed) {
                          img.src = `${failed}${failed.includes('?') ? '&' : '?'}mreload=1`
                        }
                      }, 1500)
                    }} />
                    {isVideoPreview(image) ? <span class="admin-strip-badge" aria-hidden="true">{videoBadge(image)}</span> : null}
                    {image.hidden
                      ? <span class="admin-strip-badge admin-strip-badge--hidden" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><path d="m4 4 16 16"/></svg></span>
                      : null}
                  </a>
                </li>)}
              </ul>
            </div>
            <div class="lib-card-head">
              <a class="lib-card-title" href={galleryPath(gallery.slug)} draggable="false">{title}</a>
              <button type="button" class="lib-card-menu" aria-label={`${title} actions`} aria-haspopup="dialog" onClick={() => setMenuSlug(gallery.slug)}>···</button>
            </div>
            <p class="lib-card-sub">
              {gallery.imageCount} {gallery.imageCount === 1 ? 'photograph' : 'photographs'} from {sourceLabelFor(gallery.sourceUrl)}
              {locked ? ` · Temporary gallery${gallery.expiresAt ? ` · expires ${gallery.expiresAt.slice(0, 10)}` : ''}` : ''}
            </p>
            {gallery.caption?.trim() ? <p class="lib-card-caption">{gallery.caption}</p> : null}
            {removeSlug === gallery.slug ? <div class="lib-remove-confirm" role="group" aria-label={`Confirm removal of ${title}`}>
              <p>Remove “{title}” from manorama?{gallery.sourceUrl ? ` Every photograph stays in ${sourceLabelFor(gallery.sourceUrl)}.` : ''}</p>
              <button type="button" disabled={busy} onClick={() => void removeGallery(gallery)}>Remove gallery</button>
              <button type="button" disabled={busy} onClick={() => setRemoveSlug(null)}>Cancel</button>
            </div> : null}
          </article></li>
        })}</ul> : (
          <div class="lib-empty">
            <h3>No galleries yet</h3>
            <p>Paste a link to a folder or album you already share. Nothing is copied or moved.</p>
            <button type="button" class="m-btn m-btn--primary" onClick={() => { setAddError(null); setAddOpen(true) }} disabled={busy}>Add a gallery</button>
          </div>
        )}
      </section>
      </div>

      {status ? <div class="admin-toast" role="status" aria-live="polite">{status}</div> : null}
      </main>

      <AddGallerySheet
        open={addOpen}
        url={sourceUrl}
        name={addName}
        caption={addCaption}
        checking={addChecking}
        verifiedTitle={addVerifiedTitle}
        busy={busy}
        error={addError}
        onUrlChange={onAddUrlChange}
        onVerify={onAddUrlCommit}
        onNameChange={(value) => setAddName(value)}
        onCaptionChange={(value) => setAddCaption(value)}
        onClose={() => { if (!busy) { setAddOpen(false); setAddError(null); resetAddVerification() } }}
        onSubmit={(input) => void addGallerySubmit(input)}
      />

      {menuGallery ? (
        <Sheet open onClose={() => setMenuSlug(null)} title={menuGallery.title || menuGallery.slug}>
          {/* Native buttons and links, not menu/menuitem roles: there is no
              arrow-key roving focus here, so the menu role would overpromise. */}
          <div class="lib-menu">
            <button type="button" onClick={() => { setShareSlug(menuGallery.slug); setMenuSlug(null) }}>Share link</button>
            <button type="button" onClick={() => { openDetails(menuGallery.slug); setMenuSlug(null) }}>Gallery details</button>
            <button
              type="button"
              disabled={busy || isLocked(menuGallery)}
              title={isLocked(menuGallery) ? PIPELINE_LOCK_MESSAGE : undefined}
              onClick={() => { setReorderNote(null); setReorderSlug(menuGallery.slug); setMenuSlug(null) }}
            >Reorder photographs</button>
            {menuGallery.sourceUrl ? <a href={menuGallery.sourceUrl} target="_blank" rel="noreferrer">Open source</a> : null}
            {menuGallery.sourceUrl ? (
              <button
                type="button"
                disabled={busy || isLocked(menuGallery)}
                title={isLocked(menuGallery) ? PIPELINE_LOCK_MESSAGE : undefined}
                onClick={() => { void refreshGallery(menuGallery); setMenuSlug(null) }}
              >Read the folder again</button>
            ) : null}
            <button type="button" class="lib-menu-danger" disabled={busy} onClick={() => { setRemoveSlug(menuGallery.slug); setMenuSlug(null) }}>Remove gallery</button>
          </div>
        </Sheet>
      ) : null}

      {shareGallery ? (
        <GalleryShareSheet
          payload={{
            title: shareGallery.title,
            caption: shareGallery.caption,
            url: `https://${galleryAddress(shareGallery.slug)}`,
          }}
          onClose={() => setShareSlug(null)}
          onCopy={copyText}
        />
      ) : null}

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
            onShare={() => { setDetailsNote(null); setShareSlug(detailsGallery.slug) }}
            onEditName={() => { setEditField('name'); setEditValue(detailsGallery.title); setEditNote(null) }}
            onEditCaption={() => { setEditField('caption'); setEditValue(detailsGallery.caption || ''); setEditNote(null) }}
            onEditAddress={() => { setEditField('address'); setEditValue(detailsGallery.slug); setEditNote(null) }}
            onReorder={() => reorderFromDetails(detailsGallery)}
            onRefresh={() => void refreshGalleryFromDetails(detailsGallery)}
            onRemove={() => void removeGalleryFromDetails(detailsGallery)}
            upgradeHref={upgradeHref}
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
              hidden: image.hidden,
            }))}
            onCancel={() => { setReorderNote(null); setReorderSlug(null) }}
            onSave={(orderKeys, hiddenKeys) => { void saveDraftOrder(reorderGallery, orderKeys, hiddenKeys) }}
          />
        )
      })()}
    </>
  )
}
