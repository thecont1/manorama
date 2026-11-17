/**
 * Liquid Glass design-system constants — plain data shared by the CSS gate
 * (scripts/check-glass.test.ts), the freeze spec (specs/glass-freeze.playwright.ts),
 * and any island that needs the numbers. Invariant 8 applies: no CSS strings that
 * assume a platform, no platform code, no DOM. The token *values* themselves live
 * in native/styles/glass.css as --glass-* custom properties; this file carries
 * only what the checks need to reference.
 *
 * Budget sources: Apple HIG "Materials" (https://developer.apple.com/design/human-interface-guidelines/materials)
 * for the functional-layer rule; the numeric ceilings are community-bestpractice
 * values (Meniscus design system) — flagged, not Apple's.
 */

/** Material class names defined in native/styles/glass.css. */
export const glassMaterialClasses = ['lens', 'regular', 'frost', 'tint', 'flat'] as const
export type GlassMaterial = (typeof glassMaterialClasses)[number]

/**
 * Backdrop-blur ceilings for glass *surfaces* (chrome pills, toolbars,
 * popovers, sheets, dialogs). community-bestpractice: 40px on a phone-class
 * viewport, 60px on iPad/Mac-class. The gate applies `larger` as the hard
 * ceiling; surfaces should size under `phone` unless a surface is iPad/Mac-only.
 */
export const glassBlurMaxPx = { phone: 40, larger: 60 } as const

/**
 * Named exempt dims — full-screen dim/scrim surfaces that keep their existing
 * filters (incl. saturate(.16) brightness(.42–.44)), per the owner's
 * no-visual-change decision. They are NOT `.glass-*` surfaces, are not subject
 * to the blur budget, and are excluded from the "no glass ancestor of img"
 * rule. `.viewer-filmstrip` is the picker surface (thumbs inside it), not a
 * scrim — it is exempt by name for the same reason.
 */
export const glassExemptDims = [
  '.native-global-view',
  '.filmstrip-scrim',
  '.curtain',
  '.viewer-filmstrip',
] as const

/**
 * Frost gate — shell-presence markers. Set on every shell version (any OS,
 * including ones with no native takeover). Gates Tier-B *paint* only; a rule
 * carrying one of these attributes must never hide an element.
 */
export const frostGateAttributes = [
  'data-ios-shell',
  'data-android-shell',
  'data-macos-shell',
] as const

/**
 * Takeover gate — set only when a native capsule has replaced the web element
 * (macOS 26+/iOS 26+). The ONLY attributes a `visibility:hidden` chrome rule
 * may key on. Widening hide rules to the frost attributes deletes chrome on
 * iOS 17–25 and Android forever.
 */
export const takeoverGateAttributes = [
  'data-macos-glass',
  'data-ios-glass',
] as const

/**
 * Frozen web selectors — their base declarations serve manorama.xyz and the
 * homepage demo and are never edited. Shell styling reaches them only through
 * overrides scoped under the frost gate. The freeze spec asserts their
 * computed values in a shell-less document.
 */
export const frozenWebSelectors = [
  '.m-chrome-pill',
  '.curtain',
  '.filmstrip-scrim',
  '.viewer-filmstrip',
  '.admin-gallery-strip-frame',
] as const
