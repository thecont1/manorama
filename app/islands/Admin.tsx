import { useRef, useState } from 'hono/jsx'
import type { GalleryImage } from '../lib/imagesource'
import type { GallerySummary } from '../lib/gallery-repository'

type Props = {
  galleries: readonly GallerySummary[]
  owner: string
  publicHost: string
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

const imagePreview = (image: GalleryImage | ReorderableGalleryImage) => image.variants?.[0]?.src ?? image.src
const sortRecent = (items: readonly GallerySummary[]) => [...items].sort((a, b) => {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : 0
  const bTime = b.createdAt ? Date.parse(b.createdAt) : 0
  return bTime - aTime || a.title.localeCompare(b.title)
})

const friendlyDropboxError = (error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  if (/Use a public Dropbox folder link/i.test(message)) return 'Paste a public Dropbox folder link, not a file link.'
  if (/No image files were found/i.test(message)) return 'No supported image files were found in that folder. Add JPG, PNG, WebP, GIF, or TIFF images and try again.'
  if (/401|403|409|not_found|access_denied|shared_link/i.test(message)) return 'Manorama could not read that Dropbox folder. Check that the link is public, downloading is enabled, and the URL points to the folder itself.'
  if (/credentials are not configured/i.test(message)) return 'Manorama is temporarily unable to reach Dropbox. Please try again later.'
  return 'We could not read that Dropbox folder. Check the URL and try again.'
}

const CopyIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
const TrashIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 4h4l1 3H9l1-3ZM8 7l.7 13h6.6L16 7M10 10v7M14 10v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
const OpenIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /><path d="M19 13v5.5A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-11A1.5 1.5 0 0 1 6.5 6H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>

export default function Admin({ galleries: initialGalleries, owner, publicHost }: Props) {
  const [galleries, setGalleries] = useState<GallerySummary[]>(sortRecent(initialGalleries))
  const [dropboxUrl, setDropboxUrl] = useState('')
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const panState = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null)
  const activeTouchPointers = useRef<Set<number>>(new Set())
  const galleryDrag = useRef<GalleryDrag | null>(null)
  const saveEditingInFlight = useRef(false)

  const galleryPath = (slug: string) => `/${owner}/${slug}`
  const galleryAddress = (slug: string) => `${publicHost}${galleryPath(slug)}`

   const persistGalleryOrder = async (gallery: GallerySummary, images: GallerySummary['images']) => {
    if (busy) return
    setBusy(true)
    setStatus('Saving order…')
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: images.map((image) => image.filename) }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      if (!response.ok || !payload.gallery) throw new Error(payload.error || 'That order could not be saved')
      setGalleries((previous) => sortRecent(previous.map((item) => item.slug === payload.gallery!.slug ? payload.gallery! : item)))
      setStatus('Order saved')
    } catch (error) {
      setGalleries((previous) => previous.map((item) => item.slug === gallery.slug ? gallery : item))
      setStatus(error instanceof Error ? error.message : 'That order could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const reorderGallery = (gallery: GallerySummary, from: number, to: number) => {
    if (from === to || to < 0 || to >= gallery.images.length || busy) return
    const images = [...gallery.images]
    const [moved] = images.splice(from, 1)
    if (!moved) return
    images.splice(to, 0, moved)
    setGalleries((previous) => previous.map((item) => item.slug === gallery.slug ? { ...item, images } : item))
    void persistGalleryOrder(gallery, images)
  }

  const startGalleryDrag = (gallery: GallerySummary, index: number, event: PointerEvent) => {
    if (busy || (event.pointerType === 'touch' && !event.isPrimary)) return
    const item = event.currentTarget as HTMLElement
    try { item.setPointerCapture(event.pointerId) } catch {}
    galleryDrag.current = { slug: gallery.slug, pointerId: event.pointerId, startX: event.clientX, startIndex: index, currentIndex: index, images: [...gallery.images] }
    event.preventDefault()
  }

  const moveGalleryDrag = (gallery: GallerySummary, event: PointerEvent) => {
    const drag = galleryDrag.current
    if (!drag || drag.slug !== gallery.slug || drag.pointerId !== event.pointerId) return
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
    const url = dropboxUrl.trim()
    if (!url) return
    setBusy(true)
    setStatus("Manorama-fying…")
    try {
      const response = await fetch("/api/galleries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      if (!response.ok || !payload.gallery) throw new Error(payload.error || "That gallery could not be added")
      setGalleries((previous) => sortRecent([...previous.filter((item) => item.slug !== payload.gallery!.slug), payload.gallery!]))
      setDropboxUrl("")
      setStatus('Done! ' + payload.gallery.title + ' is at the top.')
    } catch (error) {
      setStatus(friendlyDropboxError(error))
    } finally {
      setBusy(false)
    }
  }
  const beginEditing = (gallery: GallerySummary, field: EditableField) => {
    setEditing({ slug: gallery.slug, field })
    setDraft(gallery[field])
    setStatus('')
  }

  const cancelEditing = () => {
    setEditing(null)
    setDraft('')
  }

  const saveEditing = async () => {
    if (!editing || saveEditingInFlight.current) return
    const editingSlug = editing.slug
    const value = draft.trim()
    if (editing.field === 'title' && !value) {
      setStatus('A gallery title cannot be empty')
      return
    }
    if (editing.field === 'slug' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      setStatus('Use lowercase letters, numbers, and single hyphens for the gallery URL')
      return
    }
    saveEditingInFlight.current = true
    setBusy(true)
    setStatus('Saving…')
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(editing.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [editing.field]: value }),
      })
      const payload = await response.json() as { gallery?: GallerySummary; error?: string }
      if (!response.ok || !payload.gallery) throw new Error(payload.error || 'That change could not be saved')
      setGalleries((previous) => sortRecent(previous.map((item) => item.slug === editingSlug ? payload.gallery! : item)))
      setEditing(null)
      setDraft('')
      setStatus('Saved')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'That change could not be saved')
    } finally {
      saveEditingInFlight.current = false
      setBusy(false)
    }
  }

  const copyGalleryAddress = async (gallery: GallerySummary) => {
    const address = `https://${galleryAddress(gallery.slug)}`
    try {
      await navigator.clipboard.writeText(address)
      setStatus('Gallery link copied')
    } catch {
      const field = document.createElement('textarea')
      field.value = address
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      document.execCommand('copy')
      field.remove()
      setStatus('Gallery link copied')
    }
  }

  const removeGallery = async (gallery: GallerySummary) => {
    if (!gallery.sourceUrl || !window.confirm(`Remove “${gallery.title}” from Manorama?`)) return
    setBusy(true)
    setStatus('Removing gallery…')
    try {
      const response = await fetch(`/api/galleries/${encodeURIComponent(gallery.slug)}`, { method: 'DELETE' })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'That gallery could not be removed')
      setGalleries((previous) => previous.filter((item) => item.slug !== gallery.slug))
      setStatus('Gallery removed')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'That gallery could not be removed')
    } finally {
      setBusy(false)
    }
  }

  const editableText = (gallery: GallerySummary, field: EditableField, className: string) => {
    const isEditing = editing?.slug === gallery.slug && editing.field === field
    if (isEditing) {
      const common = {
        value: draft,
        autofocus: true,
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
    return <button type="button" class={`${className} editable-value${gallery[field] ? '' : ' is-empty'}`} aria-label={`Edit gallery ${field}: ${text}`} onClick={() => beginEditing(gallery, field)}>{text}</button>
  }

  return (
    <main class="admin-page admin-page--selector">
      <header class="admin-header">
        <div>
          <h1 class="admin-brand-title">manorama.xyz</h1>
          <p class="admin-intro">adj. a view that is delightful to the mind.<br />Also, simply the wow-est way to share photos with anyone!</p>
        </div>
        <img class="admin-brand-mark" src="/manorama-logo-upright.svg" alt="" aria-hidden="true" />
        {status ? <div class="admin-header-meta"><span class="admin-status" role="status" aria-live="polite">{status}</span></div> : null}
      </header>

      <section class="gallery-import" aria-labelledby="import-heading">
        <div class="gallery-selector-heading"><h2 id="import-heading">Add from Dropbox</h2></div>
        <form class="gallery-import-form" onSubmit={addGallery}>
          <label class="admin-field"><span>Public Dropbox folder URL</span><input type="url" value={dropboxUrl} placeholder="https://www.dropbox.com/scl/fo/..." onInput={(event) => { setDropboxUrl((event.target as HTMLInputElement).value) }} required /></label>
          <button class="admin-button admin-button--solid" type="submit" disabled={busy}>{busy ? 'Working…' : 'Manorama-fy it!'}</button>
        </form>
      </section>

      <section class="gallery-list" aria-label="Published galleries">
        {galleries.length ? <div class="admin-gallery-list">{galleries.map((gallery) => <article class="admin-gallery-card" key={gallery.slug}>
          <div class="admin-gallery-card-body"><div class="admin-gallery-title-row">{editableText(gallery, 'title', 'admin-gallery-title')}<span class="admin-gallery-count" aria-label={`${gallery.imageCount} photos`}>({gallery.imageCount} photos)</span></div>{editableText(gallery, 'caption', 'admin-gallery-caption')}</div>
          <div class="admin-gallery-strip-frame" aria-label={`${gallery.title} images`} onPointerDownCapture={trackTouchPointer} onPointerDown={startStripPan} onPointerMove={moveStripPan} onPointerUp={finishStripPan} onPointerCancel={finishStripPan} onWheel={(event) => { const frame = event.currentTarget as HTMLDivElement; const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY; frame.scrollLeft += delta; event.preventDefault() }}>
            <div class="admin-gallery-strip" role="list" aria-label={`Reorder ${gallery.title} images`}>
              {gallery.images.map((image, imageIndex) => <figure class="admin-gallery-strip-item" role="listitem" key={image.id} data-image-id={image.id} draggable onDragStart={(event) => { setDraggedIndex(imageIndex); event.dataTransfer?.setData('text/plain', image.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }} onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move' }} onDrop={(event) => { event.preventDefault(); if (draggedIndex !== null) reorderGallery(gallery, draggedIndex, imageIndex); setDraggedIndex(null) }} onDragEnd={() => setDraggedIndex(null)} onPointerDown={(event) => startGalleryDrag(gallery, imageIndex, event)} onPointerMove={(event) => moveGalleryDrag(gallery, event)} onPointerUp={(event) => { finishGalleryDrag(gallery, event); finishStripPan(event) }} onPointerCancel={(event) => { finishGalleryDrag(gallery, event); finishStripPan(event) }} tabIndex={0} onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); reorderGallery(gallery, imageIndex, imageIndex - 1) } if (event.key === 'ArrowRight') { event.preventDefault(); reorderGallery(gallery, imageIndex, imageIndex + 1) } }} aria-label={`${image.filename}, image ${imageIndex + 1} of ${gallery.images.length}`}>
                <img src={imagePreview(image)} alt="" loading="lazy" draggable="false" />
              </figure>)}
            </div>
          </div>
          <div class="gallery-card-actions"><div class="admin-gallery-url"><span class="admin-gallery-url-prefix">{publicHost}{galleryPath('').replace(/\/$/, '')}/</span>{editableText(gallery, 'slug', 'admin-gallery-slug')}</div><button type="button" class="admin-icon-action" title="Copy gallery link" aria-label={`Copy ${gallery.title} link`} onClick={() => copyGalleryAddress(gallery)}><CopyIcon /></button><a class="admin-icon-action" title="Open gallery in a new tab" aria-label={`Open ${gallery.title} in a new tab`} href={galleryPath(gallery.slug)} target="_blank" rel="noreferrer"><OpenIcon /></a>{gallery.sourceUrl ? <button type="button" class="admin-icon-action admin-icon-action--delete" title="Delete gallery" aria-label={`Delete ${gallery.title}`} onClick={() => removeGallery(gallery)} disabled={busy}><TrashIcon /></button> : null}</div>
        </article>)}</div> : <p class="quiet-copy">No galleries are published yet. Add one above to begin.</p>}
      </section>

      <p class="admin-privacy-note">Manorama reads only public shared Dropbox folders. Removing a gallery removes Manorama’s reference; it does not delete anything from Dropbox.</p>
    </main>
  )
}
