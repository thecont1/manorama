import { useEffect, useState } from 'hono/jsx'
import type { NativeTier } from '../lib/billing'
import type { OfflineGallerySummary } from '../lib/offline-gallery'
import type { VaultCapPreference, VaultSettingsController, VaultSettingsSnapshot } from '../lib/vault-settings'
import { FREE_VAULT_CAP_BYTES } from '../lib/vault-settings'
import '../styles/vault-settings.css'

type Props = {
  controller: VaultSettingsController
  tier?: NativeTier
  onClose?: () => void
}

const MIB = 1024 * 1024

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * MIB) return `${(bytes / MIB).toFixed(1)} MiB`
  return `${(bytes / (1024 * MIB)).toFixed(2)} GiB`
}

const formatCap = (cap: number | null): string =>
  cap === null ? 'Unlimited' : formatBytes(cap)

const FREE_CAP_CHOICES = [64, 128, 256].map((mib) => mib * MIB)
const PRO_CAP_CHOICES = [512, 1024, 2048].map((mib) => mib * MIB)

type PendingAction =
  | { kind: 'cap' }
  | { kind: 'purge'; galleryId: string }
  | { kind: 'forget' }

/** On-device vault settings: honest byte usage, a storage-limit control, and
 *  destructive per-gallery / whole-vault purges behind explicit confirmation.
 *  Nothing here touches the server or a provider — every byte lives only on
 *  this device. */
export default function VaultSettings({ controller, tier, onClose }: Props) {
  const isPro = tier === 'pro'
  const [snapshot, setSnapshot] = useState<VaultSettingsSnapshot | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [armed, setArmed] = useState<PendingAction | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const refresh = async () => {
    try {
      setSnapshot(await controller.snapshot())
      setFailure(null)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Storage details are unavailable')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const run = async (action: PendingAction, work: () => Promise<unknown>) => {
    setPending(action)
    setFailure(null)
    try {
      await work()
      setArmed(null)
      await refresh()
    } catch (error) {
      // A failed purge stays armed for retry rather than pretending it worked.
      setFailure(error instanceof Error ? error.message : 'The change could not be completed')
    } finally {
      setPending(null)
    }
  }

  const selectCap = (raw: string) => {
    const preference: VaultCapPreference = raw === 'unlimited' ? null : Number(raw)
    void run({ kind: 'cap' }, () => controller.selectCap(preference))
  }

  const purgeGallery = (galleryId: string) => {
    const action: PendingAction = { kind: 'purge', galleryId }
    if (!sameAction(armed, action)) {
      setArmed(action)
      return
    }
    void run(action, () => controller.purgeGallery(galleryId))
  }

  const forgetEverything = () => {
    const action: PendingAction = { kind: 'forget' }
    if (!sameAction(armed, action)) {
      setArmed(action)
      return
    }
    void run(action, () => controller.forgetEverything())
  }

  const capChoices = isPro ? [...FREE_CAP_CHOICES, ...PRO_CAP_CHOICES] : FREE_CAP_CHOICES
  const currentCapValue = snapshot?.cap === null ? 'unlimited' : String(snapshot?.cap ?? FREE_VAULT_CAP_BYTES)

  const galleryLabel = (gallery: OfflineGallerySummary): string =>
    gallery.status === 'cached' ? gallery.title : 'Unreadable cache'

  return (
    <main class="native-vault-shell" aria-live="polite" aria-busy={snapshot === null}>
      <section class="native-vault-card">
        <header class="native-vault-header">
          <div>
            <h1>On-device storage</h1>
            <p class="native-vault-lede">
              Encrypted copies of the galleries you open. Everything here lives only on this device.
            </p>
          </div>
          {onClose ? (
            <button type="button" class="native-vault-close" onClick={onClose} aria-label="Close storage settings">
              Close
            </button>
          ) : null}
        </header>

        {snapshot ? (
          <dl class="native-vault-usage">
            <div>
              <dt>Photographs</dt>
              <dd>{formatBytes(snapshot.usage.entryBytes)}</dd>
            </div>
            <div>
              <dt>Index &amp; leftovers</dt>
              <dd>{formatBytes(snapshot.usage.indexBytes + snapshot.usage.tempBytes + snapshot.usage.orphanBytes)}</dd>
            </div>
            <div class="native-vault-usage-total">
              <dt>Total on this device</dt>
              <dd>{formatBytes(snapshot.usage.measuredBytes)}</dd>
            </div>
          </dl>
        ) : (
          <p class="native-vault-note">Measuring encrypted storage…</p>
        )}

        <label class="native-vault-cap">
          <span>Storage limit</span>
          <select
            value={currentCapValue}
            disabled={pending !== null || snapshot === null}
            onChange={(event: Event) => selectCap((event.currentTarget as HTMLSelectElement).value)}
          >
            {capChoices.map((bytes) => (
              <option key={bytes} value={String(bytes)}>{formatBytes(bytes)}</option>
            ))}
            {isPro ? <option value="unlimited">Unlimited</option> : null}
          </select>
        </label>
        <p class="native-vault-note">
          The limit is an upper bound, not reserved space — the vault still needs free disk to write.
          {!isPro ? ` Larger limits and unlimited storage come with manorama Pro.` : ''}
        </p>

        <h2>Cached galleries</h2>
        {snapshot && snapshot.galleries.length > 0 ? (
          <ul class="native-vault-galleries">
            {snapshot.galleries.map((gallery) => {
              const measured = snapshot.usage.galleries.find((entry) => entry.galleryId === gallery.galleryId)?.measuredBytes
              const purgeAction: PendingAction = { kind: 'purge', galleryId: gallery.galleryId }
              const isArmed = sameAction(armed, purgeAction)
              const isPending = sameAction(pending, purgeAction)
              return (
                <li key={gallery.galleryId} data-vault-gallery={gallery.galleryId}>
                  <div class="native-vault-gallery-meta">
                    <strong>{galleryLabel(gallery)}</strong>
                    <span>
                      {gallery.status === 'cached'
                        ? `${gallery.images} photograph${gallery.images === 1 ? '' : 's'}`
                        : 'Needs a fresh connection to open'}
                      {measured !== undefined ? ` · ${formatBytes(measured)}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="native-vault-danger"
                    disabled={isPending}
                    onClick={() => purgeGallery(gallery.galleryId)}
                  >
                    {isPending ? 'Removing…' : isArmed ? 'Tap again to remove' : 'Remove'}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p class="native-vault-note">No galleries are stored on this device.</p>
        )}

        <button
          type="button"
          class="native-vault-forget"
          disabled={pending !== null}
          onClick={forgetEverything}
        >
          {pending?.kind === 'forget'
            ? 'Erasing…'
            : armed?.kind === 'forget'
              ? 'Tap again to erase everything'
              : 'Forget everything'}
        </button>
        <p class="native-vault-note">
          Forgetting erases every encrypted copy and destroys the keys that unlock them.
          Galleries stay on manorama — only this device's copies are removed.
        </p>

        {failure ? (
          <p class="native-vault-failure" role="alert">
            {failure} — your galleries were not changed. Tap the same action to try again.
          </p>
        ) : null}
      </section>
    </main>
  )
}

const sameAction = (a: PendingAction | null, b: PendingAction): boolean =>
  !!a && a.kind === b.kind && (a.kind !== 'purge' || (b.kind === 'purge' && a.galleryId === b.galleryId))
