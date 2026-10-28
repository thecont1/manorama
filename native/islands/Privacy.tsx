import PrivacyPolicy from '../../app/components/PrivacyPolicy'

/**
 * Full-screen native Privacy view. It is intentionally Capacitor-free: the
 * shell owns the platform, so external links and print arrive as optional
 * callbacks — the parent wires Browser.open / window.print. The Back control
 * is always present; Print only renders when the caller provides onPrint, so
 * a build without a print path shows no fake control.
 */

export interface PrivacyProps {
  onBack: () => void
  onOpenExternal?: (url: string) => void
  onPrint?: () => void
}

export default function Privacy({ onBack, onOpenExternal, onPrint }: PrivacyProps) {
  return (
    <div class="m-owner privacy-view">
      <header class="privacy-header">
        <button type="button" class="privacy-back" onClick={onBack} aria-label="Back">
          Back
        </button>
        {onPrint ? (
          <button type="button" class="privacy-print" onClick={onPrint}>
            Print
          </button>
        ) : null}
      </header>
      <div class="privacy-scroll">
        <PrivacyPolicy onOpenExternal={onOpenExternal} />
      </div>
      <style>{`
        .privacy-view {
          position: fixed;
          inset: 0;
          z-index: 90;
          display: flex;
          flex-direction: column;
          background: var(--m-ground);
          color: var(--m-ink);
        }
        .privacy-header {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: calc(env(safe-area-inset-top) + 8px) 16px 8px;
        }
        .privacy-back,
        .privacy-print {
          min-width: 44px;
          min-height: 44px;
          padding: 0 16px;
          border: 1px solid var(--m-rule);
          border-radius: 22px;
          background: transparent;
          color: var(--m-ink);
          font: inherit;
          font-size: 15px;
        }
        .privacy-scroll {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 0 24px calc(env(safe-area-inset-bottom) + 40px);
        }
        .privacy-scroll .policy-document {
          max-width: 680px;
          margin: 0 auto;
        }
        .privacy-scroll .policy-document h1 {
          margin: 0 0 4px;
          font-size: 28px;
          font-weight: 700;
        }
        .privacy-scroll .policy-document .policy-updated {
          margin: 0 0 16px;
          font-size: 13px;
          letter-spacing: .06em;
          color: var(--m-meta);
        }
        .privacy-scroll .policy-document .policy-lede {
          font-size: 17px;
          line-height: 1.55;
        }
        .privacy-scroll .policy-document p {
          margin: 0 0 16px;
          font-size: 16px;
          line-height: 1.6;
          color: var(--m-ink);
        }
        .privacy-scroll .policy-document h2 {
          margin: 32px 0 12px;
          font-size: 20px;
          font-weight: 700;
        }
        .privacy-scroll .policy-document h3 {
          margin: 0 0 8px;
          font-size: 16px;
          font-weight: 700;
        }
        .privacy-scroll .policy-document code {
          font-family: ui-monospace, 'SF Mono', monospace;
          font-size: 14px;
          background: var(--m-surface);
          padding: 1px 6px;
          border-radius: 3px;
          overflow-wrap: anywhere;
        }
        .privacy-scroll .policy-document a {
          color: inherit;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .privacy-scroll .policy-personas {
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
        }
        .privacy-scroll .policy-card {
          padding: 16px;
          border: 1px solid var(--m-rule);
        }
      `}</style>
    </div>
  )
}
