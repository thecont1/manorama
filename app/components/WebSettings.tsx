import { ActionGroup, ActionRow } from './ui/ActionRow'
import { Button } from './ui/Button'
import { Segmented } from './ui/Segmented'
import { TopBar } from './ui/TopBar'
import type { AuthProvider } from '../lib/identity-repository'
import type { Theme } from '../lib/owner-theme'
import { FREE_RETENTION_DISCLOSURE, paidGalleryLimitError } from '../lib/gallery-policy'

export type AccountIdentityWeb = { provider: AuthProvider; displayName?: string; email?: string }

const SIGN_IN_METHODS: readonly { provider: AuthProvider; name: string }[] = [
  { provider: 'dropbox', name: 'Dropbox' },
  { provider: 'google', name: 'Google' },
  { provider: 'apple', name: 'Apple' },
]
const signInMethodName = (provider: AuthProvider) =>
  SIGN_IN_METHODS.find((method) => method.provider === provider)?.name ?? provider

type Props = {
  ownerName?: string
  ownerSlug: string
  ownerSlugDraft: string
  onOwnerSlugDraft: (value: string) => void
  onSaveOwnerSlug: () => void
  ownerSlugBusy: boolean
  ownerSlugNote?: string | null
  identities: AccountIdentityWeb[] | null
  identityNote?: string | null
  onUnlinkIdentity: (provider: AuthProvider) => void
  tier: 'free' | 'pro'
  retainedCount: number
  retainedLimit: number
  /** Already-composed by the container: either the Stripe payment link with
   *  the encoded client reference, or the plain mailto fallback. */
  upgradeHref: string
  theme: Theme
  onTheme: (theme: Theme) => void
  deleteConfirm: string
  onDeleteConfirmChange: (value: string) => void
  deleteBusy: boolean
  deleteNote?: string | null
  onDeleteAccount: () => void
  onBack: () => void
}

/** Web owner Settings — one full-screen surface holding every account,
 *  plan, appearance and deletion control. The web has no device controls:
 *  no vault, no offline copies, no purge (invariant 7). */
export function WebSettings(props: Props) {
  const linked = new Set((props.identities ?? []).map((identity) => identity.provider))
  const deleteReady = !props.deleteBusy && props.deleteConfirm.trim() === props.ownerSlug
  return (
    <main class="m-owner m-screen m-screen--fixed web-settings" data-screen="settings">
      <TopBar
        title="Settings"
        logo={false}
        start={<Button variant="quiet" onClick={props.onBack} aria-label="Back">‹ Back</Button>}
      />
      <div class="m-owner-content">
        <ActionGroup label="Account">
          <ActionRow label="Name" value={props.ownerName} chevron={false} />
          <div class="m-panel m-settings-address">
            <label for="web-settings-owner-address">Address</label>
            <div>
              <span>manorama.xyz/</span>
              <input
                id="web-settings-owner-address"
                class="m-input"
                value={props.ownerSlugDraft}
                disabled={props.ownerSlugBusy}
                aria-label="Your URL — edit to change your address"
                autoCapitalize="none"
                autoCorrect="off"
                spellcheck={false}
                onInput={(event) => props.onOwnerSlugDraft((event.currentTarget as HTMLInputElement).value)}
                onBlur={props.onSaveOwnerSlug}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') props.onOwnerSlugDraft(props.ownerSlug)
                  if (event.key === 'Enter') { event.preventDefault(); props.onSaveOwnerSlug() }
                }}
              />
            </div>
          </div>
          {props.ownerSlugNote ? <p class="m-error m-panel-note" role="alert">{props.ownerSlugNote}</p> : null}
        </ActionGroup>

        <ActionGroup label="Sign-in methods">
          {props.identities === null ? <p class="m-note m-panel-note">Reading sign-in methods…</p> : null}
          {props.identities?.map((identity) => (
            <ActionRow
              key={identity.provider}
              label={signInMethodName(identity.provider)}
              chevron={false}
              control={(
                <Button
                  variant="quiet"
                  disabled={props.identities!.length <= 1}
                  onClick={() => props.onUnlinkIdentity(identity.provider)}
                >
                  Unlink
                </Button>
              )}
            />
          ))}
          {props.identities !== null ? SIGN_IN_METHODS.filter((method) => !linked.has(method.provider)).map((method) => (
            <ActionRow key={method.provider} label={`Connect ${method.name}`} href={`/auth/${method.provider}?link=1`} />
          )) : null}
          {props.identityNote ? <p class="m-note m-panel-note" role="status">{props.identityNote}</p> : null}
          <p class="m-note m-panel-note">Keep at least one way to sign in.</p>
        </ActionGroup>

        <ActionGroup label="Plan">
          <ActionRow label="Plan" value={props.tier === 'pro' ? 'Visionary' : 'Free'} chevron={false} />
          <ActionRow label="Editable galleries" value={`${props.retainedCount} of ${props.retainedLimit}`} chevron={false} />
          {props.tier === 'free' ? <ActionRow label="Upgrade" href={props.upgradeHref} /> : null}
          {props.tier === 'pro' ? (
            <>
              <p class="m-note m-panel-note">Paid accounts retain up to 99 galleries. Retained galleries stay until you delete them.</p>
              {props.retainedCount >= props.retainedLimit ? (
                <p class="m-note m-panel-note" role="status">{paidGalleryLimitError().message}</p>
              ) : null}
            </>
          ) : (
            <p class="m-note m-panel-note">{FREE_RETENTION_DISCLOSURE}</p>
          )}
        </ActionGroup>

        <ActionGroup label="Appearance">
          <div class="m-panel m-settings-segmented">
            <Segmented
              label="Appearance"
              value={props.theme}
              options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
              onChange={(value) => props.onTheme(value as Theme)}
            />
          </div>
        </ActionGroup>

        <ActionGroup label="About">
          <ActionRow label="Privacy Policy" href="/privacy" />
        </ActionGroup>

        <ActionGroup label="Sign out and delete">
          <ActionRow
            label="Session"
            control={(
              <form method="post" action="/auth/logout" class="m-signout-form">
                <Button variant="quiet" type="submit">Sign out</Button>
              </form>
            )}
          />
          <div class="m-panel m-settings-delete">
            <p>
              This removes your galleries, device catalogue and sign-in methods from manorama. Nothing in your
              Dropbox, Google Drive, iCloud or MEGA is touched. If you subscribe, cancel first — web: your Stripe receipt.
            </p>
            <label class="admin-delete-confirm">
              Type your URL name ({props.ownerSlug}) to confirm
              <input
                class="m-input"
                type="text"
                value={props.deleteConfirm}
                autoCapitalize="none"
                autoCorrect="off"
                spellcheck={false}
                disabled={props.deleteBusy}
                onInput={(event) => props.onDeleteConfirmChange((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <Button
              variant="destructive"
              disabled={!deleteReady}
              onClick={props.onDeleteAccount}
            >
              {props.deleteBusy ? 'Deleting…' : 'Delete my account'}
            </Button>
            {props.deleteNote ? <p class="m-error" role="alert">{props.deleteNote}</p> : null}
          </div>
        </ActionGroup>
      </div>
    </main>
  )
}

export default WebSettings
