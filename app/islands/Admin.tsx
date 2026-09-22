import { useEffect, useRef, useState } from 'hono/jsx'
import type { GalleryImage } from '../lib/imagesource'
import type { GallerySummary } from '../lib/gallery-repository'
import { friendlySourceError } from '../lib/source-errors'
import { FREE_RETENTION_DISCLOSURE, PIPELINE_LOCK_MESSAGE, FREE_RETAINED_LIMIT, PAID_RETAINED_LIMIT, isGalleryExpired, paidGalleryLimitError } from '../lib/gallery-policy'
import SeededDoodleBackground from './SeededDoodleBackground'
import { BACKGROUND_EVENT, backgroundEnabled, loadBackgroundPreference, saveBackgroundPreference } from '../lib/background-preference'

type Props = {
  galleries: readonly GallerySummary[]
  owner: string
  ownerName?: string
  publicHost: string
  tier?: 'free' | 'pro'
}
type EditableField = 'title' | 'caption' | 'slug'
type Editing = { slug: string; field: EditableField } | null
type ReorderableGalleryImage = GallerySummary['images'][number]
type GalleryDrag = {
  slug: string
  pointerId: number
  startX: number
  startIndex: number
  currentIndex: number
  images: GallerySummary['images']
}
type Theme = 'light' | 'dark'

const THEME_KEY = 'manorama:theme'
const themeControlLabel = (theme: Theme) => theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
const setDoodlePreference = (enabled: boolean) => saveBackgroundPreference(enabled ? 'doodle' : 'flat')

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

const CopyIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
const TrashIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 4h4l1 3H9l1-3ZM8 7l.7 13h6.6L16 7M10 10v7M14 10v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
const OpenIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /><path d="M19 13v5.5A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-11A1.5 1.5 0 0 1 6.5 6H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
const RefreshIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.66-5.66L20 8M20 4v4h-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /><path d="M20 12a8 8 0 0 1-13.66 5.66L4 16M4 20v-4h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
const SourceIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 8.5v9A1.5 1.5 0 0 0 5 19h14a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 19 8h-7.5L9.5 5.5A1.5 1.5 0 0 0 8.5 5H5a1.5 1.5 0 0 0-1.5 1.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /><path d="M3.5 8.5h17" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>

/** Renders the owner's dashboard for importing, editing, and managing galleries. */
export default function Admin({ galleries: initialGalleries, owner, ownerName, publicHost, tier = 'free' }: Props) {
  const [galleries, setGalleries] = useState<GallerySummary[]>(sortRecent(initialGalleries))
  const [sourceUrl, setSourceUrl] = useState('')
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
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
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])
  const [ownerSlugDraft, setOwnerSlugDraft] = useState(owner)
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof localStorage === 'undefined') return 'dark'
    try {
      return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  // App-wide display chrome, shared with the public viewer. Start flat for
  // SSR/hydration, then reconcile the persisted preference on mount.
  const [doodle, setDoodle] = useState(false)

  useEffect(() => {
    setDoodle(backgroundEnabled(loadBackgroundPreference()))
    const sync = () => setDoodle(backgroundEnabled(loadBackgroundPreference()))
    window.addEventListener('storage', sync)
    window.addEventListener(BACKGROUND_EVENT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(BACKGROUND_EVENT, sync)
    }
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
    announce('Your shared link is ready to add — press Manorama-fy to finish.')
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'light') root.classList.add('light')
    else root.classList.remove('light')
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch { /* private browsing */ }
  }, [theme])
  const panState = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null)
  const activeTouchPointers = useRef<Set<number>>(new Set())
  const galleryDrag = useRef<GalleryDrag | null>(null)
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
      announce('Use at least 3 lowercase letters, numbers, and single hyphens')
      return
    }
    if (value === owner) {
      cancelOwnerSlugEditing()
      return
    }
    if (busy) return
    setBusy(true)
    announce('Saving…', true)
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
      announce(error instanceof Error ? error.message : 'That URL could not be saved')
      setBusy(false)
    }
  }

   const persistGalleryOrder = async (gallery: GallerySummary, images: GallerySummary['images']) => {
    if (blockPipelineEdit(gallery)) return
    if (busy) return
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
    } catch (error) {
      setGalleries((previous) => previous.map((item) => item.slug === gallery.slug ? gallery : item))
      announce(error instanceof Error ? error.message : 'That order could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const reorderGallery = (gallery: GallerySummary, from: number, to: number) => {
    if (blockPipelineEdit(gallery)) return
    if (from === to || to < 0 || to >= gallery.images.length || busy) return
    const images = [...gallery.images]
    const [moved] = images.splice(from, 1)
    if (!moved) return
    images.splice(to, 0, moved)
    setGalleries((previous) => previous.map((item) => item.slug === gallery.slug ? { ...item, images } : item))
    void persistGalleryOrder(gallery, images)
  }

  const startGalleryDrag = (gallery: GallerySummary, index: number, event: PointerEvent) => {
    if (blockPipelineEdit(gallery)) { event.preventDefault(); return }
    if (busy || (event.pointerType === 'touch' && !event.isPrimary)) return
    const item = event.currentTarget as HTMLElement
    try { item.setPointerCapture(event.pointerId) } catch {}
    galleryDrag.current = { slug: gallery.slug, pointerId: event.pointerId, startX: event.clientX, startIndex: index, currentIndex: index, images: [...gallery.images] }
    event.preventDefault()
  }

  const moveGalleryDrag = (gallery: GallerySummary, event: PointerEvent) => {
    const drag = galleryDrag.current
    if (!drag || drag.slug !== gallery.slug || drag.pointerId !== event.pointerId) return
    if (blockPipelineEdit(gallery)) return
    const strip = (event.currentTarget as HTMLElement).parentElement
    if (!strip) return
    const items = Array.from(strip.children) as HTMLElement[]
    if (items.length < 2 || Math.abs(event.clientX - drag.startX) < 8) return
    let target = items.findIndex((item) => {
      const rect = item.getBoundingClientRect()
      return event.clientX >= rect.left && event.clientX <= rect.right
    })
    if (target < 0) target = event.clientX < items[0].getBoundingClientRect().left ? 0 : items.length - 1
    if (target === drag.currentIndex) return
    const images = [...drag.images]
    const [moved] = images.splice(drag.currentIndex, 1)
    if (!moved) return
    images.splice(target, 0, moved)
    drag.images = images
    drag.currentIndex = target
    setGalleries((previous) => previous.map((item) => item.slug === gallery.slug ? { ...item, images } : item))
    event.preventDefault()
  }

  const finishGalleryDrag = (gallery: GallerySummary, event: PointerEvent) => {
    const drag = galleryDrag.current
    if (!drag || drag.slug !== gallery.slug || drag.pointerId !== event.pointerId) return
    if (blockPipelineEdit(gallery)) return
    galleryDrag.current = null
    if (drag.currentIndex !== drag.startIndex) void persistGalleryOrder(gallery, drag.images)
  }

  const trackTouchPointer = (event: PointerEvent) => {
    if (event.pointerType === 'touch') activeTouchPointers.current.add(event.pointerId)
  }

  const startStripPan = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      if (activeTouchPointers.current.size < 2) return
      galleryDrag.current = null
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

  const addGallery = async (event: Event) => {
    event.preventDefault()
    const url = sourceUrl.trim()
    if (!url) return
    setBusy(true)
    announce("Manorama-fying…", true)
    try {
      const response = await fetch("/api/galleries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      // 409 "already exists" still carries the gallery — that is a
      // successful reopen, not a scan failure: keep the card, point at it,
      // and say so instead of showing a could-not-read error.
      if (response.status === 409 && payload.gallery) {
        setGalleries((previous) => sortRecent([...previous.filter((item) => item.slug !== payload.gallery!.slug), payload.gallery!]))
        setSourceUrl("")
        scrollToGalleryCard(payload.gallery.slug)
        announce(payload.error || 'That link is already one of your galleries.')
        return
      }
      if (!response.ok || !payload.gallery) {
        if (response.status === 403) { announce(payload.error || "That gallery could not be added"); return }
        throw new Error(payload.error || "That gallery could not be added")
      }
      setGalleries((previous) => sortRecent([...previous.filter((item) => item.slug !== payload.gallery!.slug), payload.gallery!]))
      setSourceUrl("")
      scrollToGalleryCard(payload.gallery.slug)
      announce('Done! ' + payload.gallery.title + ' is at the top.')
    } catch (error) {
      announce(friendlySourceError(error))
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

  return (
    <>
      <SeededDoodleBackground enabled={doodle} />
      <main class={`admin-page admin-page--selector${doodle ? ' has-doodle' : ''}`}>
      <header class="admin-header">
        <div>
          <form method="post" action="/auth/logout" class="admin-brand-form">
            <h1 class="admin-brand-title"><button type="submit" class="admin-brand-logo-button" aria-label="Sign out and return to the homepage" title="Sign out"><span class="brand-mark-wrap"><img class="admin-brand-logo" src="/manorama-merged-logo.png" alt="manorama" /><span class="brand-tld" aria-hidden="true">.xyz</span></span></button></h1>
          </form>
          <p class="admin-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
          <div class="admin-greeting">
            <p class="admin-greeting-url">manorama.xyz/<input
              class="admin-owner-slug-input"
              type="text"
              value={ownerSlugDraft}
              disabled={busy}
              aria-label="Your URL — edit to change your address"
              spellcheck={false}
              onInput={(event) => setOwnerSlugDraft((event.target as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') cancelOwnerSlugEditing()
                if (event.key === 'Enter') { event.preventDefault(); void saveOwnerSlug() }
              }}
              onBlur={() => { void saveOwnerSlug() }}
            /></p>
            <p><br/>Hello <mark class="admin-greeting-name">{ownerName}</mark>. Welcome to manorama.xyz. This is where you maintain your galleries. Choose any username you like, as often as you like, by editing the link above. Whenever you're done, feel free to <form method="post" action="/auth/logout" class="admin-signout-form"><button type="submit" class="admin-signout">sign out</button></form> <br/><br/>Or not. This is your manoramic world.</p>
          </div>
        </div>
        <div class="admin-display-toggles" aria-label="Display preferences">
          <button type="button" class="admin-background-toggle" onClick={() => { const next = !doodle; setDoodle(next); setDoodlePreference(next) }} aria-label={doodle ? 'Use flat background' : 'Use doodle background'} aria-pressed={doodle} title={doodle ? 'Use flat background' : 'Use doodle background'}>
            <span aria-hidden="true">{doodle ? '▦' : '□'}</span>
          </button>
          <button type="button" class="admin-theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={themeControlLabel(theme)} aria-pressed={theme === 'light'} title={themeControlLabel(theme)}>
            <img src={theme === 'light' ? '/icons/thin-sunglasses_23303233.svg' : '/icons/regular-sunglasses_28c9e1cf.svg'} alt="" />
          </button>
        </div>
      </header>

      <section class="gallery-import" aria-labelledby="import-heading">
        <div class="gallery-selector-heading"><h2 id="import-heading">Add a gallery</h2></div>
        {(() => {
          const retained = galleries.filter((gallery) => gallery.retention !== 'pipeline').length
          return <div class="admin-retention-policy">
            <p class="admin-limit-count" aria-live="polite">{retained} retained {retained === 1 ? 'gallery' : 'galleries'}{tier === 'pro' ? ` · ${Math.max(0, PAID_RETAINED_LIMIT - retained)} available` : ` · ${Math.max(0, FREE_RETAINED_LIMIT - retained)} editable slots available`}</p>
            {tier === 'free' ? <p>{FREE_RETENTION_DISCLOSURE}</p> : <p>Paid accounts retain up to 99 galleries. Retained galleries stay until you delete them.</p>}
            {tier === 'pro' && retained >= PAID_RETAINED_LIMIT ? <p>{paidGalleryLimitError().message}</p> : null}
          </div>
        })()}
        <form class="gallery-import-form" onSubmit={addGallery}>
          <label class="admin-field"><span>Public Dropbox, Google Drive, iCloud, or MEGA link</span><input type="url" value={sourceUrl} placeholder="Dropbox folder, Drive folder, iCloud album, or MEGA link" onInput={(event) => { setSourceUrl((event.target as HTMLInputElement).value) }} required /></label>
          <button class="admin-button admin-button--solid" type="submit" disabled={busy}>{busy ? 'Working…' : 'Manorama-fy it!'}</button>
        </form>
        <p class="admin-privacy-note">Manorama reads only public shared folders and albums. Removing a gallery removes Manorama’s reference; it does not delete anything from Dropbox, Google Drive, iCloud, or MEGA.</p>
      </section>

      <section class="gallery-list" aria-label="Published galleries">
        {liveGalleries.length ? <div class="admin-gallery-list">{liveGalleries.map((gallery) => <article class="admin-gallery-card" key={gallery.slug} data-gallery-card={gallery.slug} data-retention={gallery.retention}>
          <div class="admin-gallery-card-body"><div class="admin-gallery-title-row">{editableText(gallery, 'title', 'admin-gallery-title')}<span class="admin-gallery-count" aria-label={`${gallery.imageCount} photos`}>({gallery.imageCount} photos)</span></div>{editableText(gallery, 'caption', 'admin-gallery-caption')}</div>
          {isLocked(gallery) && gallery.expiresAt ? <div class="admin-gallery-retention" id={`retention-${gallery.slug}`}>
            <p>Temporary · {Math.max(0, Math.ceil((Date.parse(gallery.expiresAt) - now) / 86_400_000))} days left</p>
            <p>Expires <time dateTime={gallery.expiresAt}>{gallery.expiresAt.replace('T', ' ').replace('.000Z', ' UTC')}</time>. Permanently removed from Manorama after 30 days unless you upgrade before expiry.</p>
            <p>{PIPELINE_LOCK_MESSAGE} <a href="mailto:mahesh@thecontrarian.in?subject=Manorama%20upgrade">Upgrade</a></p>
          </div> : null}
          <div class="gallery-card-url-row"><button type="button" class="admin-icon-action" title="Copy gallery link" aria-label={`Copy ${gallery.title} link`} onClick={() => copyGalleryAddress(gallery)}><CopyIcon /></button><div class="admin-gallery-url"><span class="admin-gallery-url-prefix">{publicHost}{galleryPath('').replace(/\/$/, '')}/</span>{editableText(gallery, 'slug', 'admin-gallery-slug')}</div></div>
          <div class="admin-gallery-strip-frame" aria-label={`${gallery.title} images`} onPointerDownCapture={trackTouchPointer} onPointerDown={startStripPan} onPointerMove={moveStripPan} onPointerUp={finishStripPan} onPointerCancel={finishStripPan} onWheel={(event) => { const frame = event.currentTarget as HTMLDivElement; const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY; frame.scrollLeft += delta; event.preventDefault() }}>
            <div class="admin-gallery-strip" role="list" aria-label={`Reorder ${gallery.title} images`}>
              {gallery.images.map((image, imageIndex) => <figure class="admin-gallery-strip-item" role="listitem" key={image.id} data-image-id={image.id} draggable={!isLocked(gallery)} aria-disabled={isLocked(gallery) ? 'true' : undefined} onDragStart={(event: DragEvent) => { if (blockPipelineEdit(gallery)) { event.preventDefault(); return } setDraggedIndex(imageIndex); event.dataTransfer?.setData('text/plain', image.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }} onDragOver={(event: DragEvent) => { if (isLocked(gallery)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move' }} onDrop={(event: DragEvent) => { if (isLocked(gallery)) return; event.preventDefault(); if (draggedIndex !== null) reorderGallery(gallery, draggedIndex, imageIndex); setDraggedIndex(null) }} onDragEnd={() => setDraggedIndex(null)} onPointerDown={(event) => startGalleryDrag(gallery, imageIndex, event)} onPointerMove={(event) => moveGalleryDrag(gallery, event)} onPointerUp={(event) => { finishGalleryDrag(gallery, event); finishStripPan(event) }} onPointerCancel={(event) => { finishGalleryDrag(gallery, event); finishStripPan(event) }} tabIndex={0} onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); reorderGallery(gallery, imageIndex, imageIndex - 1) } if (event.key === 'ArrowRight') { event.preventDefault(); reorderGallery(gallery, imageIndex, imageIndex + 1) } }} aria-label={`${image.filename}, ${itemKind(image)} ${imageIndex + 1} of ${gallery.images.length}`}>
                <img src={imagePreview(image)} alt="" loading="lazy" draggable="false" onLoad={(event: Event) => (event.currentTarget as HTMLImageElement).classList.add('is-loaded')} />
                {isVideoPreview(image) ? <span class="admin-strip-badge" aria-hidden="true">{videoBadge(image)}</span> : null}
              </figure>)}
            </div>
          </div>
          <div class="gallery-card-actions"><a class="admin-icon-action" title="Open gallery in a new tab" aria-label={`Open ${gallery.title} in a new tab`} href={galleryPath(gallery.slug)} target="_blank" rel="noreferrer"><OpenIcon /></a>{gallery.sourceUrl ? <a class="admin-icon-action" title={gallery.sourceUrl} aria-label={`Open the ${gallery.title} source at ${gallery.sourceUrl}`} href={gallery.sourceUrl} target="_blank" rel="noreferrer"><SourceIcon /></a> : null}{gallery.sourceUrl ? <button type="button" class="admin-icon-action" title={isLocked(gallery) ? PIPELINE_LOCK_MESSAGE : 'Refresh from source'} aria-label={`Refresh ${gallery.title} from its source link`} aria-disabled={isLocked(gallery) ? 'true' : undefined} aria-describedby={isLocked(gallery) ? `retention-${gallery.slug}` : undefined} onClick={() => refreshGallery(gallery)} disabled={busy}><RefreshIcon /></button> : null}<button type="button" class="admin-icon-action admin-icon-action--delete" title="Delete gallery" aria-label={`Delete ${gallery.title}`} onClick={() => removeGallery(gallery)} disabled={busy}><TrashIcon /></button></div>
        </article>)}</div> : <p class="quiet-copy">No galleries are published yet. Add one above to begin.</p>}
      </section>

      {status ? <div class="admin-toast" role="status" aria-live="polite">{status}</div> : null}
      <footer class="site-footer">
        <a class="site-footer-link" href="/privacy">Privacy Policy</a>
        <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a href="https://thecontrarian.in">thecontrarian.in</a></p>
      </footer>
      </main>
    </>
  )
}
