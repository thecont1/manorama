import { useState } from 'hono/jsx'
import { Browser } from '@capacitor/browser'
import { RevenueCatBilling } from '../lib/billing'
import { nativeDeviceLabel } from '../lib/device-label'
import { Button } from '../../app/components/ui/Button'
import { ActionRow } from '../../app/components/ui/ActionRow'
import { Sheet } from '../../app/components/ui/Sheet'

type Props = {
  billing: RevenueCatBilling
  onClose: () => void
  onOpenPrivacy?: () => void
}

/** Visionary is an introduction first — a sheet, one tap from the store. The
 *  numbers are stated as before-and-after, never a price: that comes from the
 *  App Store sheet opened by the explicit CTA. Restore, customer center and
 *  legal links stay available alongside it. */
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
    <main class="m-owner m-screen native-visionary" aria-live="polite">
      <Sheet
        open
        title="manorama Visionary"
        onClose={onClose}
        footer={
          <Button variant="primary" block onClick={() => void present()} disabled={busy}>
            {busy ? 'Opening…' : isPro ? 'Review subscription options' : 'See price in the App Store'}
          </Button>
        }
      >
        <div class="native-visionary-body">
          {isPro ? <p class="native-visionary-note" role="status">Your Visionary subscription is active.</p> : null}
          <dl class="native-visionary-kv">
            <dt>Galleries kept</dt><dd>3 → 99</dd>
            <dt>Room on {nativeDeviceLabel()}</dt><dd>256 MB → larger</dd>
            <dt>Galleries over the limit</dt><dd>Kept, not for 30 days</dd>
          </dl>
          <p class="native-visionary-note">An annual subscription, billed by the App Store. Your galleries and photographs are the same on either plan.</p>
          {message ? <p class="m-note" role="status">{message}</p> : null}
          <div class="m-panel native-visionary-more">
            <ActionRow label="Restore purchases" onClick={() => void restore()} disabled={busy} />
            <ActionRow label="Manage subscription" onClick={() => void customerCenter()} disabled={busy} />
            <ActionRow label="Terms of Use" onClick={() => void Browser.open({ url: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/' })} />
            <ActionRow label="Privacy Policy" onClick={onOpenPrivacy ?? (() => void Browser.open({ url: 'https://manorama.xyz/privacy' }))} />
          </div>
        </div>
      </Sheet>
    </main>
  )
}
