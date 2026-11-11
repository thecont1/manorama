/**
 * The display face shared by the public headings. The quick-add interstitial
 * imports this too, so the two public surfaces share one heading treatment
 * without touching app/styles.css.
 *
 * It moved here from `app/components/PublicWelcome.tsx` when that component
 * became the marketing homepage: the quick-add heading must look identical
 * afterwards, so the constant has to live somewhere both surfaces can reach.
 */
export const PUBLIC_HEADING_FONT_FAMILY =
  "'Bricolage Grotesque', 'Manrope', ui-sans-serif, system-ui, sans-serif"
