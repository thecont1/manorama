import { useState } from 'hono/jsx'
import { Browser } from '@capacitor/browser'
import { RevenueCatBilling } from '../lib/billing'
import { TopBar } from '../../app/components/ui/TopBar'
import { Button } from '../../app/components/ui/Button'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'

type Props = {
  billing: RevenueCatBilling
  onClose: () => void
  onOpenPrivacy?: () => void
}

/** Visionary is an introduction first. The store opens only after its explicit
 * CTA; restore, customer center and legal links stay available alongside it. */
export default function Paywall({ billing, onClose, onOpenPrivacy }: Props) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isPro, setIsPro] = useState(billing.currentState?.isPro ?? false)

  const present = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const offering = await billing.offerings()
      if (!offering || offering.availablePackages.length === 0) {
        setMessage('Subscriptions are unavailable right now. Please try again shortly.')
        return
      }
      const result = await billing.presentPaywallIfNeeded()
      setIsPro(result.state.isPro)
      setMessage(result.state.isPro ? 'Your Visionary subscription is active.' : 'You can review the options in the store whenever you are ready.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The subscription options are unavailable')
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const state = await billing.restore()
      setIsPro(state.isPro)
      setMessage(state.isPro ? 'Your Visionary subscription is active.' : 'No active Visionary subscription was found.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Purchases could not be restored')
    } finally {
      setBusy(false)
    }
  }

  const customerCenter = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const state = await billing.presentCustomerCenter()
      setIsPro(state.isPro)
      setMessage(state.isPro ? 'Your Visionary subscription is active.' : 'Your account is on the free plan.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Customer Center is unavailable')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main class="m-owner m-screen m-screen--fixed native-visionary" aria-live="polite">
      <TopBar title="Visionary" logo={false} start={<Button variant="quiet" onClick={onClose} aria-label="Back">‹ Back</Button>} />
      <div class="m-owner-content native-visionary-content">
        <header class="native-visionary-intro">
          <p class="native-visionary-kicker">manorama Visionary</p>
          <h1>{isPro ? 'Your subscription is active.' : 'More room for the work you want to keep.'}</h1>
          <p>Visionary raises the editable gallery limit from 3 to 99, allows larger configurable encrypted vaults where supported, and promotes every unexpired temporary gallery.</p>
          <p>The 30-day limit concerns overflow gallery retention. It is not a timer on encrypted copies stored on your device.</p>
        </header>
        <ActionGroup label="Subscription">
          <div class="native-visionary-cta"><Button variant="primary" block onClick={() => void present()} disabled={busy}>{busy ? 'Opening…' : isPro ? 'Review subscription options' : 'View subscription options'}</Button></div>
          <ActionRow label="Restore purchases" onClick={() => void restore()} disabled={busy} />
          <ActionRow label="Manage subscription" onClick={() => void customerCenter()} disabled={busy} />
          {message ? <p class="m-note m-panel-note" role="status">{message}</p> : null}
        </ActionGroup>
        <ActionGroup label="Legal">
          <ActionRow label="Terms of Use" onClick={() => void Browser.open({ url: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/' })} />
          <ActionRow label="Privacy Policy" onClick={onOpenPrivacy ?? (() => void Browser.open({ url: 'https://manorama.xyz/privacy' }))} />
        </ActionGroup>
      </div>
    </main>
  )
}
