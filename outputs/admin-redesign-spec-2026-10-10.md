# Admin redesign — approved direction

10 October 2026. **Specification only: no redesign source changes have been made in this turn.** Local terminal execution still fails with a closed connection; branch inspection, build, test and Xcode capture are unavailable. Existing fixes and captures from the earlier task remain separate.

## 1. iOS account introduction

Replace the cramped, inline tier/name/sign-out paragraph with a considered editorial introduction:

> Hello, Mahesh Shantaram. Welcome to manorama.xyz. You are a Free User. You have used 1 of your 3 gallery limit.

Name, tier, retained count and allowance remain dynamic. Use `Pro User` for the paid tier rather than inventing another membership name. Do not show a fabricated count while account data is loading; render a quiet loading state instead.

Visual order:

1. Wordmark at the left; 44px hamburger account button at the right.
2. Existing short brand definition beneath, with restrained line height and consistent spacing.
3. Editable public address on its own line, able to wrap gracefully around a long username.
4. Greeting split into readable visual paragraphs without changing its wording: hello/welcome, then tier/allowance.
5. Gallery import and list remain directly on the page, not hidden in the menu.

No sign-out button inside prose. No membership label wedged between “Hello” and the person's name. The name can use the web's subtle highlight treatment without becoming another badge.

## 2. Account menu

The requested hamburger belongs to **admin/account pages only**. It must not add any control to the photograph viewer.

- iOS: an account drawer containing the labelled dark/light action and sign out.
- Web: replace the permanently occupied left account column with a slide-out account pane, closed by default.
- The web pane contains the existing wordmark, definition, editable public address, exact greeting, sign-in methods, existing account deletion flow, theme action, sign out and legal links.
- A compact, non-sticky web header carries a small wordmark, “Your galleries” and the account/menu button.
- Theme controls are labelled actions inside the pane, not floating sunglasses beside unrelated content.
- The wordmark is not a hidden sign-out action; sign out has its own explicit button/form.
- Preserve the existing account deletion safeguards and provider unlink behavior; do not introduce new destructive actions.

Accessibility and behavior:

- Trigger has an accessible account-menu label, `aria-expanded` and `aria-controls`.
- Drawer has an accessible name, close button, Esc dismissal and backdrop dismissal.
- Trap focus while modal; restore focus to the trigger on close.
- Keep the underlying page inert while open; maintain its scroll position.
- Animate transform/opacity only; honor reduced motion.
- Refresh starts with the drawer closed. No query parameters or fragments encode menu state.

## 3. Shared gallery title and subtitle

Use the web gallery metadata's typography on native rather than shrinking it to generic 15px row text:

- Title: existing Bricolate Grotesque/Bricolage family, approximately 24px desktop and 22–24px phone, weight 500, tight but legible tracking, line-height near 1.15.
- Subtitle: separate line, quieter 12–14px text, line-height around 1.6, matching the web caption's contrast.
- Count: secondary to the title; may wrap to avoid truncating a long title.
- Public URL: separate line below the subtitle, with reliable long-address overflow handling.
- Keep native cover photographs aspect-true and independently sized. Typography alignment does not authorize cropping or upscaling.
- Share tokens/classes where practical so subsequent platform overrides do not drift.

This is a presentation change, not authorization to add native inline metadata editing.

## 4. Wider web workbench

The account drawer frees the gallery list from its half-width column. Use one fluid content column with considered page gutters; do not simply stretch every text paragraph to the viewport width. Import prose and subtitle line lengths remain bounded, while the editor uses the available gallery-card width.

Each gallery remains an editorial section with title, subtitle, public URL, Photo Editor row and existing actions. Keep gallery-opening links in new tabs.

## 5. Approved web Photo Editor exception

The owner explicitly approved on 10 October 2026:

> Single-row web Photo Editor; keep Photo Picker/Global View as matrices.

Document this scoped exception in repository guidance during implementation. It does **not** change native Photo Picker, Global View, or the photograph viewer.

Web editor behavior:

- Exactly one non-wrapping horizontal row per gallery.
- Fixed viewport-relative thumbnail height; width follows each source aspect ratio.
- Zero image gaps, pink active selection, no crops or stretching.
- Frame constrained to the gallery section width; no viewport-wide bleed or vertical thumbnail wrapping.
- Horizontal native scrolling with trackpad/touch. Wheel input may pan the row only while interacting with it; avoid gratuitous page-scroll hijacking at the row boundaries.
- Preserve drag reordering and keyboard reordering.
- Update drag auto-scroll and pan math from vertical to horizontal where applicable, not just CSS `flex-wrap`.
- Focused/reordered items remain visible inside the row.
- Reserve aspect-ratio dimensions before image decode; do not introduce row shifts.

## 6. Implementation and validation

Likely scope: `app/islands/Admin.tsx`, `native/islands/GalleryList.tsx`, shared account-menu component/hook in `app/components`, `app/styles.css`, `native/styles.css`, native account tests, web admin acceptance tests and the documented web-editor exception in `AGENTS.md`. Inspect nested instructions and issue ownership before edits.

Validate exact dynamic greeting, title/subtitle hierarchy, long names/titles/URLs, empty/loading accounts, drawer focus/close behavior, dark/light contrast, unchanged import flow, and all editor input methods. Run typecheck, the full mirrored unit suite, web acceptance at 375×812 / 1440×900 / 2560×1440, and fresh iPhone/iPad evidence from Xcode bundles. Do not treat old captures or the earlier 1,057 passing unit tests as validation of this redesign.

The attached reference screenshot could not be read because its temporary-folder access was denied twice. Reattach it from a readable folder before claiming an exact screenshot match. Existing web component and stylesheet readings establish the typography reference, but not the unseen attachment's specific composition.
