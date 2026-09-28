import { useEffect, useState } from 'hono/jsx'
import { Browser } from '@capacitor/browser'
import { RevenueCatBilling } from '../lib/billing'

type Props = {
  billing: RevenueCatBilling
  onClose: () => void
}

export default function Paywall({ billing, onClose }: Props) {
  const [busy, setBusy] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [isPro, setIsPro] = useState(billing.currentState?.isPro ?? false)

  const present = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await billing.presentPaywallIfNeeded()
      setIsPro(result.state.isPro)
      if (result.state.isPro) setMessage('Your subscription is active.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The subscription options are unavailable')
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
      setMessage(state.isPro ? 'Your subscription is active.' : 'Your account is on the free plan.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Customer Center is unavailable')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void present()
  }, [])

  return (
    <main class="native-paywall-shell" aria-live="polite">
      <section class="native-paywall-card">
        <button class="native-paywall-close" type="button" onClick={onClose} aria-label="Close subscription options">
          Close
        </button>
        <p class="native-paywall-kicker">manorama</p>
        <h1>{isPro ? 'Subscription active' : 'Subscription options'}</h1>
        <p>{message ?? (busy ? 'Opening subscription options…' : 'Choose a plan in the secure RevenueCat screen.')}</p>
        <div class="native-paywall-actions">
          <button type="button" onClick={() => void present()} disabled={busy}>
            {busy ? 'Opening…' : 'Open paywall'}
          </button>
          <button type="button" onClick={() => void customerCenter()} disabled={busy}>
            Manage subscription
          </button>
        </div>
        {/* Guideline 3.1.2: an auto-renewing subscription must put the Terms
            of Use and Privacy Policy inside the app, not only on the web. */}
        <p class="native-paywall-legal">
          <button
            type="button"
            onClick={() => void Browser.open({ url: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/' })}
          >
            Terms of Use
          </button>
          {' · '}
          <button
            type="button"
            onClick={() => void Browser.open({ url: 'https://manorama.xyz/privacy' })}
          >
            Privacy Policy
          </button>
        </p>
      </section>
    </main>
  )
}
