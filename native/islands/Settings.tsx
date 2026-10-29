import type { Child } from 'hono/jsx'
import { Button } from '../../app/components/ui/Button'
import { TopBar } from '../../app/components/ui/TopBar'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'
import { Segmented } from '../../app/components/ui/Segmented'
import { Switch } from '../../app/components/ui/Switch'
import type { Theme } from '../../app/lib/owner-theme'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import type { AccountIdentity } from '../lib/api'
import type { NativeTier } from '../lib/billing'
import type { VaultLoadPolicy, VaultSettingsController } from '../lib/vault-settings'
import VaultSettings from './VaultSettings'

type HouseCardAction = { label: string; onClick: () => void; disabled?: boolean }

type Props = {
  accountName: string
  ownerSlug: string
  ownerSlugDraft: string
  onOwnerSlugDraft: (value: string) => void
  onSaveOwnerSlug: () => void
  identities: AccountIdentity[] | null
  identityNote?: string | null
  onUnlinkIdentity: (provider: string) => void
  onLinkIdentity: (provider: string) => void
  tier: NativeTier | undefined
  retainedCount: number
  galleryLimit: number
  controller: VaultSettingsController
  loadPolicy: VaultLoadPolicy | null
  loadPolicyBusy: boolean
  onLoadPolicy: (policy: VaultLoadPolicy) => void
  globalViewEnabled: boolean | null
  globalViewBusy: boolean
  onGlobalView: (enabled: boolean) => void
  onOpenPicker: () => void
  deviceGalleries: readonly DeviceGallery[]
  onOpenDeviceGallery: (gallery: DeviceGallery) => void
  theme: Theme
  onTheme: (theme: Theme) => void
  houseCards?: { status: string; actions: HouseCardAction[] }
  onOpenVisionary: () => void
  onOpenPrivacy: () => void
  onOpenAuthor: () => void
  onSignOut: () => void
  deleteConfirming: boolean
  deleting: boolean
  deleteError?: string | null
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  onBack: () => void
}

const providerName = (provider: string) => ({ apple: 'Apple', google: 'Google', dropbox: 'Dropbox' } as Record<string, string>)[provider] ?? provider

/** One owner settings surface. Existing account, billing and vault controllers
 * remain authoritative; this view only moves their controls into one place. */
export default function Settings(props: Props) {
  const {
    accountName, ownerSlugDraft, identities, identityNote, tier, retainedCount, galleryLimit,
    loadPolicy, globalViewEnabled, deviceGalleries, theme, houseCards,
    deleteConfirming, deleting, deleteError,
  } = props
  const linked = new Set((identities ?? []).map((identity) => identity.provider))
  return (
    <main class="m-owner m-screen m-screen--fixed native-settings">
      <TopBar title="Settings" logo={false} start={<Button variant="quiet" onClick={props.onBack} aria-label="Back">‹ Back</Button>} />
      <div class="m-owner-content native-settings-content">
        <ActionGroup label="Account">
          <ActionRow label="Name" value={accountName} chevron={false} />
          <div class="m-panel m-settings-address">
            <label for="settings-owner-address">Address</label>
            <div><span>manorama.xyz/</span><input
              id="settings-owner-address"
              value={ownerSlugDraft}
              aria-label="Your URL — edit to change your address"
              autoCapitalize="none"
              autoCorrect="off"
              spellcheck={false}
              onInput={(event) => props.onOwnerSlugDraft((event.currentTarget as HTMLInputElement).value)}
              onBlur={props.onSaveOwnerSlug}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); props.onSaveOwnerSlug() } }}
            /></div>
          </div>
        </ActionGroup>

        <ActionGroup label="Sign-in methods">
          {identities === null ? <p class="m-note m-panel-note">Reading sign-in methods…</p> : null}
          {identities?.map((identity) => (
            <ActionRow
              label={providerName(identity.provider)}
              chevron={false}
              control={<Button variant="quiet" disabled={identities.length <= 1} onClick={() => props.onUnlinkIdentity(identity.provider)}>Unlink</Button>}
            />
          ))}
          {['apple', 'google', 'dropbox'].filter((provider) => identities !== null && !linked.has(provider)).map((provider) => (
            <ActionRow label={`Connect ${providerName(provider)}`} onClick={() => props.onLinkIdentity(provider)} />
          ))}
          {identityNote ? <p class="m-note m-panel-note" role="status">{identityNote}</p> : null}
          <p class="m-note m-panel-note">Keep at least one way to sign in.</p>
        </ActionGroup>

        <ActionGroup label="Plan">
          <ActionRow label="Plan" value={tier === 'pro' ? 'Visionary' : 'Free'} chevron={false} />
          <ActionRow label="Editable galleries" value={`${retainedCount} of ${galleryLimit}`} chevron={false} />
          <ActionRow label={tier === 'pro' ? 'Manage Visionary' : 'Learn about Visionary'} onClick={props.onOpenVisionary} />
          <p class="m-note m-panel-note">The 30-day limit applies to overflow gallery retention, not to encrypted copies on this device.</p>
        </ActionGroup>

        <ActionGroup label="Appearance">
          <div class="m-panel m-settings-segmented">
            <Segmented
              label="Appearance"
              value={theme}
              options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
              onChange={(value) => props.onTheme(value as Theme)}
            />
          </div>
        </ActionGroup>

        {houseCards ? <ActionGroup label="House cards">
          <p class="m-note m-panel-note">{houseCards.status}</p>
          {houseCards.actions.map((action) => <ActionRow label={action.label} onClick={action.onClick} disabled={action.disabled} />)}
        </ActionGroup> : null}

        <ActionGroup label="This device">
          <div class="m-panel m-settings-control">
            <label for="settings-load-policy">When opening an online gallery</label>
            <select id="settings-load-policy" value={loadPolicy ?? 'vault'} disabled={props.loadPolicyBusy || loadPolicy === null} onChange={(event) => props.onLoadPolicy((event.currentTarget as HTMLSelectElement).value as VaultLoadPolicy)}>
              <option value="vault">Download to encrypted vault (default)</option>
              <option value="stream">Stream from cloud when needed</option>
            </select>
          </div>
          <ActionRow
            label="Expanded photo picker"
            control={<Switch checked={globalViewEnabled === true} label="Keep photos from this device ready to choose in galleries" disabled={props.globalViewBusy || globalViewEnabled === null} onChange={props.onGlobalView} />}
          />
          {globalViewEnabled ? <ActionRow label="Open photo picker" onClick={props.onOpenPicker} /> : null}
          <p class="m-note m-panel-note">Encrypted copies stay app-private. The picker setting expands native scope; the current-gallery selector remains available.</p>
          {deviceGalleries.map((gallery) => <ActionRow label={gallery.title} value={`${gallery.itemCount} photographs`} chevron={Boolean(gallery.publicGallerySlug)} onClick={gallery.publicGallerySlug ? () => props.onOpenDeviceGallery(gallery) : undefined} />)}
          <VaultSettings controller={props.controller} tier={tier} embedded />
        </ActionGroup>

        <ActionGroup label="About">
          <ActionRow label="Privacy Policy" onClick={props.onOpenPrivacy} />
          <ActionRow label="Mahesh Shantaram · thecontrarian.in" onClick={props.onOpenAuthor} />
        </ActionGroup>

        <ActionGroup label="Sign out and delete">
          <ActionRow label="Sign out" onClick={props.onSignOut} />
          {deleteConfirming ? <div class="m-panel m-settings-delete">
            <p>This removes your galleries, device catalogue and sign-in methods from manorama. Nothing at the source is touched. If you subscribe, cancel first — App Store: Settings › Subscriptions; web: your Stripe receipt.</p>
            <div>
              <Button variant="destructive" disabled={deleting || !props.ownerSlugDraft} onClick={props.onConfirmDelete}>{deleting ? 'Deleting…' : 'Delete permanently'}</Button>
              <Button variant="secondary" disabled={deleting} onClick={props.onCancelDelete}>Cancel</Button>
            </div>
          </div> : <ActionRow label="Delete account" tone="destructive" onClick={props.onRequestDelete} />}
          {deleteError ? <p class="m-note m-panel-note" role="alert">{deleteError}</p> : null}
        </ActionGroup>
      </div>
    </main>
  )
}
