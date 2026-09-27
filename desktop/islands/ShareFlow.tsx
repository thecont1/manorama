import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { LocalCatalogue, LocalGalleryRecord } from '../lib/catalogue'
import { cancelProviderConnect } from '../lib/providers/oauth'
import { createDropboxUploadProvider } from '../lib/providers/dropbox'
import { createDriveUploadProvider } from '../lib/providers/drive'
import type { UploadProgress, UploadProvider, UploadProviderId } from '../lib/providers/types'
import { UPLOAD_PROVIDER_IDS } from '../lib/providers/types'
import { shareLocalGallery } from '../lib/share'
import type { DesktopSession } from '../lib/session'
import { readFileBytes } from '../lib/tauri'

/**
 * The share sheet: provider → connect → explicit confirmation → progress →
 * the public Manorama gallery URL. It is mounted ONLY by the per-gallery
 * "Share…" button, so nothing here can run on open, rescan, or launch —
 * the confirmation step then gates the first byte.
 */

type ShareStep = 'choose' | 'connecting' | 'confirm' | 'uploading' | 'done' | 'error'

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export default function ShareFlow({
  record,
  catalogue,
  apiBase,
  session,
  onClose,
}: {
  record: LocalGalleryRecord
  catalogue: LocalCatalogue
  apiBase: string
  session: DesktopSession | null
  onClose: () => void
}) {
  const providers = useMemo<Record<UploadProviderId, UploadProvider>>(
    () => ({ dropbox: createDropboxUploadProvider(), drive: createDriveUploadProvider() }),
    [],
  )
  const [step, setStep] = useState<ShareStep>('choose')
  const [providerId, setProviderId] = useState<UploadProviderId | null>(null)
  const [connected, setConnected] = useState<Partial<Record<UploadProviderId, boolean>>>({})
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [result, setResult] = useState<{ shareUrl: string; galleryUrl: string; slug: string } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pasteUrl, setPasteUrl] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      const states: Partial<Record<UploadProviderId, boolean>> = {}
      for (const id of UPLOAD_PROVIDER_IDS) {
        states[id] = await providers[id].isConnected().catch(() => false)
      }
      if (active) setConnected(states)
    })()
    return () => {
      active = false
    }
  }, [providers])

  const provider = providerId ? providers[providerId] : null
  const albumName = record.title
  // A cancelled connect still rejects its promise — the guard keeps that
  // rejection from flashing an error over the provider list.
  const connectActive = useRef(false)

  const beginConnect = (id: UploadProviderId) => {
    setProviderId(id)
    setErrorMessage(null)
    setPasteUrl('')
    connectActive.current = true
    setStep('connecting')
    void providers[id]
      .connect()
      .then(() => {
        if (!connectActive.current) return
        connectActive.current = false
        setConnected((previous) => ({ ...previous, [id]: true }))
        setStep('confirm')
      })
      .catch((reason: unknown) => {
        if (!connectActive.current) return
        connectActive.current = false
        setErrorMessage(reason instanceof Error ? reason.message : 'The provider connection could not be completed.')
        setStep('error')
      })
  }

  const submitPastedRedirect = (event: Event) => {
    event.preventDefault()
    const url = pasteUrl.trim()
    if (!url || !providerId) return
    void providers[providerId]
      .completeConnect(url)
      .then(() => {
        setConnected((previous) => ({ ...previous, [providerId]: true }))
        setPasteUrl('')
        setStep('confirm')
      })
      .catch((reason: unknown) => {
        setErrorMessage(reason instanceof Error ? reason.message : 'The provider connection could not be completed.')
        setStep('error')
      })
  }

  const cancelConnect = () => {
    connectActive.current = false
    cancelProviderConnect()
    setStep('choose')
  }

  // Closing mid-connect abandons the pending flow — settle it so the next
  // attempt does not hit "a connection is already waiting".
  const close = () => {
    connectActive.current = false
    cancelProviderConnect()
    onClose()
  }

  const confirmShare = () => {
    if (!provider || !session) return
    setErrorMessage(null)
    setStep('uploading')
    void shareLocalGallery({
      provider,
      apiBase,
      token: session.token,
      record,
      catalogue,
      readFile: readFileBytes,
      // The gate exists in code, not just layout: resolving the sheet's own
      // confirm action is the only way this resolves true.
      confirm: async () => true,
      onProgress: setProgress,
    }).then((outcome) => {
      if (outcome.status === 'published') {
        setResult({ shareUrl: outcome.shareUrl, galleryUrl: outcome.galleryUrl, slug: outcome.slug })
        setStep('done')
      } else if (outcome.status === 'failed') {
        setErrorMessage(outcome.message)
        setStep('error')
      } else {
        setStep('choose')
      }
    })
  }

  return (
    <section class="desktop-share" aria-label="Share this gallery">
      <header class="desktop-share-header">
        <h3>Share “{record.title}”</h3>
        {step !== 'uploading' ? (
          <button type="button" onClick={close}>Close</button>
        ) : null}
      </header>

      {errorMessage && step === 'error' ? (
        <p class="desktop-notice desktop-error" role="alert">{errorMessage}</p>
      ) : null}

      {!session ? (
        <p class="desktop-notice">Sign in above to publish this gallery — the upload itself waits on you.</p>
      ) : null}

      {step === 'choose' && session ? (
        <div class="desktop-share-providers">
          {UPLOAD_PROVIDER_IDS.map((id) => {
            const p = providers[id]
            const configured = p.configured()
            const isConnected = connected[id] === true
            return (
              <div class="desktop-share-provider" key={id}>
                <span class="desktop-share-provider-name">{p.label}</span>
                {!configured ? (
                  <span class="desktop-share-provider-note">Not configured in this build</span>
                ) : isConnected ? (
                  <button type="button" onClick={() => { setProviderId(id); setStep('confirm') }}>
                    Use {p.label}
                  </button>
                ) : (
                  <button type="button" onClick={() => beginConnect(id)}>
                    Connect
                  </button>
                )}
              </div>
            )
          })}
          <p class="desktop-share-hint">
            Uploading sends the original files to your own Dropbox or Drive account and hands Manorama the
            public link — nothing uploads until you confirm.
          </p>
        </div>
      ) : null}

      {step === 'connecting' && provider ? (
        <div class="desktop-share-connecting">
          <p>Finish connecting {provider.label} in your browser — the app picks the result up automatically.</p>
          <form class="desktop-paste" onSubmit={submitPastedRedirect}>
            <label>
              Redirect link
              <input
                value={pasteUrl}
                onInput={(event) => setPasteUrl((event.currentTarget as HTMLInputElement).value)}
                placeholder={providerId === 'drive' ? 'http://127.0.0.1:…/?code=…&state=…' : 'in.thecontrarian.manorama.desktop://oauth/dropbox?code=…&state=…'}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </label>
            <button type="submit">Complete connection</button>
            <p class="desktop-paste-hint">
              Dev builds cannot receive the redirect — paste the full link the browser lands on.
            </p>
          </form>
          <button type="button" onClick={cancelConnect}>Cancel</button>
        </div>
      ) : null}

      {step === 'confirm' && provider ? (
        <div class="desktop-share-confirm">
          <p>
            Upload {record.itemCount} {record.itemCount === 1 ? 'original' : 'originals'} to {provider.label} as
            “manorama/{albumName}”? The bytes upload exactly as they are — never re-encoded — and the folder
            becomes viewable by anyone with the link. Manorama receives only the public link and scans it there.
          </p>
          <div class="desktop-share-confirm-actions">
            <button type="button" onClick={confirmShare}>
              Upload and publish
            </button>
            <button type="button" onClick={() => setStep('choose')}>Back</button>
          </div>
        </div>
      ) : null}

      {step === 'uploading' ? (
        <div class="desktop-share-progress" role="status">
          {progress ? (
            <>
              <p>
                Uploading {progress.index} of {progress.total} — {progress.fileName}
              </p>
              <p class="desktop-share-hint">{formatBytes(progress.bytesSent)} of {formatBytes(progress.bytesTotal)}</p>
            </>
          ) : (
            <p>Preparing the upload…</p>
          )}
        </div>
      ) : null}

      {step === 'done' && result ? (
        <div class="desktop-share-done">
          <p>
            Published as{' '}
            <a
              href={result.galleryUrl.startsWith('http') ? result.galleryUrl : `${apiBase}${result.galleryUrl}`}
              target="_blank"
              rel="noreferrer"
            >
              {result.galleryUrl.startsWith('http') ? result.galleryUrl : `${apiBase}${result.galleryUrl}`}
            </a>
          </p>
          <p class="desktop-share-hint">
            The {provider?.label ?? 'provider'} folder is <a href={result.shareUrl} target="_blank" rel="noreferrer">publicly linkable</a> —
            this device record now opens the same gallery on your other devices.
          </p>
        </div>
      ) : null}

      {step === 'error' ? (
        <button type="button" onClick={() => setStep('choose')}>Back to providers</button>
      ) : null}
    </section>
  )
}
