import { useRef, useState } from 'hono/jsx'
import type { GalleryManifest } from '../lib/imagesource'
import {
  clearGallerySettings,
  defaultGallerySettings,
  loadGallerySettings,
  saveGallerySettings,
  type GallerySettings,
  type ViewerMode,
} from '../lib/gallery-settings'

type Props = { manifest: GalleryManifest }

const download = (filename: string, value: string) => {
  const blob = new Blob([value], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export default function Admin({ manifest }: Props) {
  const [settings, setSettings] = useState<GallerySettings>(() => loadGallerySettings(manifest.slug, manifest))
  const [status, setStatus] = useState('Ready to edit')
  const importRef = useRef<HTMLInputElement | null>(null)

  const update = <K extends keyof GallerySettings>(key: K, value: GallerySettings[K]) => {
    setSettings((previous) => ({ ...previous, [key]: value }))
    setStatus('Unsaved changes')
  }

  const save = () => {
    saveGallerySettings(manifest.slug, settings)
    setStatus('Saved in this browser')
  }

  const reset = () => {
    clearGallerySettings(manifest.slug)
    setSettings(defaultGallerySettings(manifest))
    setStatus('Reset to generated defaults')
  }

  const importSettings = async (event: Event) => {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      setSettings({ ...defaultGallerySettings(manifest), ...parsed })
      setStatus('Imported; save to apply')
    } catch {
      setStatus('That file could not be read')
    }
    if (importRef.current) importRef.current.value = ''
  }

  return (
    <main class="admin-page">
      <header class="admin-header">
        <div>
          <p class="admin-eyebrow">manorama / gallery settings</p>
          <h1>Shape the album before it opens.</h1>
          <p class="admin-intro">A quiet control room for <strong>{manifest.title}</strong>. Changes are scoped to <code>/{manifest.slug}</code> and stored in this browser.</p>
        </div>
        <div class="admin-header-meta">
          <span class="admin-status" role="status" aria-live="polite">{status}</span>
          <a class="admin-text-link" href={`/${manifest.slug}`}>View gallery</a>
        </div>
      </header>

      <form class="admin-form" onSubmit={(event) => { event.preventDefault(); save() }}>
        <section class="admin-section" aria-labelledby="identity-heading">
          <div class="admin-section-heading">
            <div><p class="admin-section-index">01</p><h2 id="identity-heading">Gallery identity</h2></div>
            <p>What visitors meet on the curtain.</p>
          </div>
          <div class="admin-fields admin-fields--two">
            <label class="admin-field"><span>Title</span><input value={settings.title} onInput={(event) => update('title', (event.target as HTMLInputElement).value)} /></label>
            <label class="admin-field"><span>Date</span><input value={settings.date} onInput={(event) => update('date', (event.target as HTMLInputElement).value)} /></label>
          </div>
          <label class="admin-field"><span>Caption</span><textarea rows={3} value={settings.caption} onInput={(event) => update('caption', (event.target as HTMLTextAreaElement).value)} /></label>
        </section>

        <section class="admin-section" aria-labelledby="curtain-heading">
          <div class="admin-section-heading">
            <div><p class="admin-section-index">02</p><h2 id="curtain-heading">Opening curtain</h2></div>
            <p>The first breath of the experience.</p>
          </div>
          <div class="admin-fields admin-fields--two">
            <label class="admin-field"><span>Kicker</span><input value={settings.curtainKicker} onInput={(event) => update('curtainKicker', (event.target as HTMLInputElement).value)} /></label>
            <label class="admin-field"><span>Entry prompt</span><input value={settings.curtainPrompt} onInput={(event) => update('curtainPrompt', (event.target as HTMLInputElement).value)} /></label>
          </div>
        </section>

        <section class="admin-section" aria-labelledby="viewer-heading">
          <div class="admin-section-heading">
            <div><p class="admin-section-index">03</p><h2 id="viewer-heading">Viewer defaults</h2></div>
            <p>Visitors can still change these in the controls dot.</p>
          </div>
          <fieldset class="admin-mode-field">
            <legend>Opening view mode</legend>
            <div class="admin-mode-options">
              {([['strip', 'Strip', 'full-height and continuous'], ['vertical', 'Vertical scroll', 'fit to width'], ['single', 'One at a time', 'advance per gesture']] as Array<[ViewerMode, string, string]>).map(([value, label, description]) => (
                <label class={settings.defaultMode === value ? 'is-selected' : ''}><input type="radio" name="default-mode" value={value} checked={settings.defaultMode === value} onChange={() => update('defaultMode', value)} /><span><strong>{label}</strong><small>{description}</small></span></label>
              ))}
            </div>
          </fieldset>
          <div class="admin-switches">
            <label class="admin-switch"><span><strong>Open with captions</strong><small>Keep image captions available in the modal.</small></span><input type="checkbox" checked={settings.defaultShowCaptions} onChange={(event) => update('defaultShowCaptions', (event.target as HTMLInputElement).checked)} /></label>
            <label class="admin-switch"><span><strong>Open with navigation arrows</strong><small>Arrows remain off by default in the gallery unless enabled here.</small></span><input type="checkbox" checked={settings.defaultShowArrows} onChange={(event) => update('defaultShowArrows', (event.target as HTMLInputElement).checked)} /></label>
          </div>
        </section>

        <section class="admin-section" aria-labelledby="photographs-heading">
          <div class="admin-section-heading">
            <div><p class="admin-section-index">04</p><h2 id="photographs-heading">Photographs</h2></div>
            <p>Stable image IDs are kept intact for future comments.</p>
          </div>
          <div class="admin-images">
            {manifest.images.map((image, index) => (
              <article class="admin-image-row">
                <div class="admin-image-number">{String(index + 1).padStart(2, '0')}</div>
                <div class="admin-image-details">
                  <div class="admin-image-label"><strong>{image.filename}</strong><code>{image.id}</code></div>
                  <label class="admin-field"><span>Alt text</span><input value={settings.imageAlts[image.id] ?? ''} onInput={(event) => update('imageAlts', { ...settings.imageAlts, [image.id]: (event.target as HTMLInputElement).value })} /></label>
                  <label class="admin-field"><span>Caption <em>optional</em></span><textarea rows={2} value={settings.imageCaptions[image.id] ?? ''} onInput={(event) => update('imageCaptions', { ...settings.imageCaptions, [image.id]: (event.target as HTMLTextAreaElement).value })} /></label>
                </div>
              </article>
            ))}
          </div>
        </section>

        <footer class="admin-actions">
          <div><p class="admin-save-note">Local settings are portable. Export a JSON file to carry this gallery configuration to another browser or deployment workflow.</p></div>
          <div class="admin-action-group">
            <button type="button" class="admin-button admin-button--quiet" onClick={reset}>Reset</button>
            <button type="button" class="admin-button admin-button--quiet" onClick={() => importRef.current?.click()}>Import</button>
            <button type="button" class="admin-button admin-button--quiet" onClick={() => download(`${manifest.slug}-settings.json`, JSON.stringify(settings, null, 2))}>Export</button>
            <button type="button" class="admin-button admin-button--solid" onClick={save}>Save settings</button>
          </div>
          <input ref={importRef} class="admin-file-input" type="file" accept="application/json" onChange={importSettings} aria-label="Import gallery settings JSON" />
        </footer>
      </form>
    </main>
  )
}
