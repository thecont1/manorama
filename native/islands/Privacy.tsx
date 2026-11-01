import PrivacyPolicy from '../../app/components/PrivacyPolicy'
import { Button } from '../../app/components/ui/Button'
import { TopBar } from '../../app/components/ui/TopBar'

/**
 * Full-screen native Privacy view with the shared owner chrome: the centred
 * wordmark and a back control that names where it returns to (Settings when
 * opened from Settings, Back otherwise). It is intentionally Capacitor-free:
 * the shell owns the platform, so external links and print arrive as optional
 * callbacks — the parent wires Browser.open / window.print. Print only
 * renders when the caller provides onPrint, so a build without a print path
 * shows no fake control.
 */

export interface PrivacyProps {
  onBack: () => void
  /** The word the back control carries — 'Settings' when opened from there. */
  backLabel?: string
  onOpenExternal?: (url: string) => void
  onPrint?: () => void
}

export default function Privacy({ onBack, backLabel = 'Back', onOpenExternal, onPrint }: PrivacyProps) {
  return (
    <div class="m-owner m-screen m-screen--fixed privacy-view" data-screen="privacy">
      <TopBar
        start={(
          <Button
            variant="quiet"
            class="m-backbtn"
            onClick={onBack}
            aria-label={backLabel === 'Back' ? 'Back' : `Back to ${backLabel.toLowerCase()}`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 6l-6 6 6 6"/></svg>
            {backLabel}
          </Button>
        )}
        end={onPrint ? (
          <Button variant="quiet" onClick={onPrint} aria-label="Print the privacy policy">
            Print
          </Button>
        ) : undefined}
      />
      <div class="privacy-scroll">
        <PrivacyPolicy onOpenExternal={onOpenExternal} />
      </div>
      <style>{`
        .privacy-scroll {
          padding: 0 24px calc(env(safe-area-inset-bottom) + 40px);
        }
        .privacy-scroll .policy-document {
          margin: 0 auto;
        }
      `}</style>
    </div>
  )
}
