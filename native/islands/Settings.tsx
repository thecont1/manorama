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
 * remain authoritative; this view only moves their controls into one place.
 * The groups follow the prototype: Account, Plan, This iPhone, About. */
export default function Settings(props: Props) {
  const {
    accountName, ownerSlugDraft, identities, identityNote, tier, retainedCount, galleryLimit,
    loadPolicy, globalViewEnabled, deviceGalleries, theme, houseCards,
    deleteConfirming, deleting, deleteError,
  } = props
  const linked = new Set((identities ?? []).map((identity) => identity.provider))
  return (
    <main class="m-owner m-screen m-screen--fixed native-settings" data-screen="settings">
      <TopBar
        start={(
          <Button variant="quiet" onClick={props.onBack} aria-label="Back to the library" class="m-backbtn">
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 6l-6 6 6 6"/></svg>
            Library
          </Button>
        )}
      />
      <div class="m-owner-content native-settings-content">
        <div class="native-settings-heading">
          <h1>Settings</h1>
        </div>
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
          {identities !== null ? <p class="m-note m-panel-note">Keep at least one way to sign in.</p> : null}
        </ActionGroup>

        <ActionGroup label="Plan">
          <div class="m-settings-plan">
            <div class="m-settings-usage"><b>{tier === 'pro' ? 'Visionary' : 'Free'}</b><span>{retainedCount} of {galleryLimit} galleries</span></div>
            {/* The pink data hue marks the count; the bar itself is the
                measure, so it carries the progressbar role. */}
            <span
              class="m-meter-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={galleryLimit}
              aria-valuenow={retainedCount}
              aria-label={`${retainedCount} of ${galleryLimit} galleries in use`}
            ><i class="m-meter-fill" style={{ width: `${Math.min(100, (retainedCount / Math.max(1, galleryLimit)) * 100)}%` }} /></span>
            <p class="m-note">Visionary keeps up to 99 galleries and gives more room on this iPhone.</p>
            <Button variant="secondary" block onClick={props.onOpenVisionary}>{tier === 'pro' ? 'Manage Visionary' : 'Go Visionary'}</Button>
          </div>
        </ActionGroup>

        <ActionGroup label="This iPhone" note="These settings stay on this device.">
          <div class="m-panel m-settings-control">
            <label>Appearance</label>
            <Segmented
              label="Appearance"
              value={theme}
              options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
              onChange={(value) => props.onTheme(value as Theme)}
            />
          </div>
          <div class="m-panel m-settings-control">
            <label>New galleries</label>
            {loadPolicy === null
              ? <p class="m-note">Reading…</p>
              : <Segmented
                  label="New galleries"
                  value={loadPolicy}
                  options={[{ value: 'vault', label: 'Keep a copy' }, { value: 'stream', label: 'Stream only' }]}
                  onChange={(value) => { if (!props.loadPolicyBusy) props.onLoadPolicy(value as VaultLoadPolicy) }}
                />}
          </div>
          <ActionRow
            label="Photo picker"
            control={<Switch checked={globalViewEnabled === true} label="Let galleries show photographs already saved on this iPhone" disabled={props.globalViewBusy || globalViewEnabled === null} onChange={props.onGlobalView} />}
          />
          {globalViewEnabled ? <ActionRow label="Open photo picker" onClick={props.onOpenPicker} /> : null}
          <p class="m-note m-panel-note">Everything stays encrypted and on the device. The picker lets galleries show photographs already saved on this iPhone.</p>
          {deviceGalleries.map((gallery) => <ActionRow label={gallery.title} value={`${gallery.itemCount} photographs`} chevron={Boolean(gallery.publicGallerySlug)} onClick={gallery.publicGallerySlug ? () => props.onOpenDeviceGallery(gallery) : undefined} />)}
          <VaultSettings controller={props.controller} tier={tier} embedded />
        </ActionGroup>

        {houseCards ? <ActionGroup label="House cards">
          <p class="m-note m-panel-note">{houseCards.status}</p>
          {houseCards.actions.map((action) => <ActionRow label={action.label} onClick={action.onClick} disabled={action.disabled} />)}
        </ActionGroup> : null}

        <ActionGroup label="About">
          <ActionRow label="Privacy Policy" onClick={props.onOpenPrivacy} />
          <ActionRow label="Mahesh Shantaram · thecontrarian.in" onClick={props.onOpenAuthor} />
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
