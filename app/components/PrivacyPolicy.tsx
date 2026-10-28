import { PRIVACY_POLICY } from '../../packages/core/privacy-policy'
import type { PrivacyInline } from '../../packages/core/privacy-policy'

/**
 * The shared privacy-policy renderer. It is the document body only — the
 * surrounding chrome (page shell, native Back header) belongs to each
 * platform's view. Content comes from `PRIVACY_POLICY`, which transcribes
 * `app/routes/privacy.tsx` verbatim, so every section, link, and the
 * effective date render identically everywhere.
 *
 * Platform seams stay as optional callbacks:
 * - Without `onOpenExternal`, links are plain anchors (the web behavior).
 * - With `onOpenExternal`, the anchor keeps its href but the click is routed
 *   to the callback so a native shell can open an in-app browser. Destinations
 *   never change.
 * - `onPrint` is optional: only when provided does a Print control render, so
 *   a course without a print affordance gets no fake button.
 */

export interface PrivacyPolicyProps {
  onOpenExternal?: (url: string) => void
  onPrint?: () => void
}

const inline = (part: PrivacyInline, index: number, onOpenExternal?: (url: string) => void) => {
  switch (part.kind) {
    case 'text':
      return <span key={index}>{part.text}</span>
    case 'strong':
      return <strong key={index}>{part.text}</strong>
    case 'code':
      return <code key={index}>{part.text}</code>
    case 'link':
      return onOpenExternal ? (
        <a
          key={index}
          href={part.href}
          onClick={(event) => {
            event.preventDefault()
            onOpenExternal(part.href)
          }}
        >
          {part.label}
        </a>
      ) : (
        <a key={index} href={part.href}>
          {part.label}
        </a>
      )
  }
}

export default function PrivacyPolicy({ onOpenExternal, onPrint }: PrivacyPolicyProps) {
  return (
    <article class="policy-document">
      <h1>{PRIVACY_POLICY.title}</h1>
      <p class="policy-updated">Last updated: {PRIVACY_POLICY.updated}</p>
      <p class="policy-lede">{PRIVACY_POLICY.lede}</p>
      {onPrint ? (
        <button type="button" class="policy-print" onClick={onPrint}>
          Print
        </button>
      ) : null}
      {PRIVACY_POLICY.sections.map((section) =>
        section.personas ? (
          <section class="policy-section" key={section.heading}>
            <h2>{section.heading}</h2>
            <div class="policy-personas">
              {section.cards?.map((card) => (
                <section class="policy-card" aria-labelledby={card.headingId} key={card.headingId}>
                  <h3 id={card.headingId}>{card.heading}</h3>
                  <p>{card.paragraph.parts.map((part, index) => inline(part, index, onOpenExternal))}</p>
                </section>
              ))}
            </div>
          </section>
        ) : (
          <section class="policy-section" id={section.id} key={section.heading}>
            <h2>{section.heading}</h2>
            {section.paragraphs?.map((paragraph, index) => (
              <p key={index}>{paragraph.parts.map((part, partIndex) => inline(part, partIndex, onOpenExternal))}</p>
            ))}
          </section>
        ),
      )}
    </article>
  )
}
