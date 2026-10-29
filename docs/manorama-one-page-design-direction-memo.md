# manorama — one-page design-direction memo

## What to keep

Keep the core idea that manorama is a quiet place for photographs.

The strongest thing in the product is the sense that the photographs should dominate the experience, not the interface. The viewer surfaces already hint at the right product identity: dark canvas, large images, minimal interruption, and a feeling that the app should recede when the pictures are doing their work.

Keep the idea that this is **not** a social feed, not a busy asset manager, and not a generic photo grid. It should feel more like a calm presentation environment for images, with just enough tooling around it to make publishing and management possible.

Keep the functional breadth only where it matters:
- users can sign in,
- users can add a gallery from a public cloud link,
- users can browse their galleries,
- users can open a gallery in different viewing modes,
- users can manage order/captions/basic settings,
- and users can rely on device-local encrypted behavior.

Those capabilities appear real and important. What is negotiable is not the existence of those jobs, but how visibly and how often they should appear.

## What to challenge

Challenge almost every current grouping of interface elements.

The current app appears to put too many product layers side by side: brand, account, gallery creation, gallery library, gallery actions, subscription messaging, help text, device behavior, and display settings. The result is not just visual clutter; it is conceptual clutter.

Challenge the assumption that all settings belong in one sheet. Challenge the assumption that all gallery actions need first-level visibility. Challenge the assumption that the user needs so much explanatory prose. Challenge the assumption that brand should be large and emphatic on every surface. Challenge the assumption that monetization belongs close to the primary act of looking at photographs.

Most importantly, challenge the idea that the current screens are a useful wireframe. They are better understood as a list of product obligations.

## Design direction

Design manorama from the inside out, beginning with the act of viewing photographs.

Start with the viewer and define the minimum shell needed for image navigation, orientation, and exit. Then design the library/dashboard as a separate operational space for owners and curators. Then place maintenance tasks, device behavior, and subscription logic in tertiary locations with much lower visual pressure.

A good direction would likely establish three clear layers:
- **Primary:** viewing photographs.
- **Secondary:** choosing, opening, and organizing galleries.
- **Tertiary:** editing, device behavior, account limits, subscription, and advanced controls.

This is where “Swiss” can be useful, not as a stylistic cliché but as a discipline of hierarchy, reduction, and separation of concerns. Fewer elements per screen. Stronger grid logic. Less decorative insistence. Fewer simultaneous emphasis levels. More trust in scale, spacing, and typography to do the work.

## Questions to resolve first

Before high-fidelity design, answer these:

1. What is the one-sentence definition of manorama?
2. What is the default post-sign-in screen?
3. What is the minimum interface needed to open and enjoy a gallery?
4. Which controls belong inside the viewer, and which must live outside it?
5. Which gallery-card actions deserve immediate visibility, and which should move into a menu?
6. Which settings are truly display settings, and which are really storage/device settings?
7. How should subscription status appear without hijacking the experience?
8. Should owner workflows and pure viewing workflows look and feel meaningfully different?

## Working principle

Do not redesign the current app. Redesign the product that is trapped inside it.
