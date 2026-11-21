# Translucent app surfaces

21 November 2026. Implemented locally on `feat/viewer-optical-ground`; not committed, deployed or installed over the owner's apps.

## What changed

Previously transparent UI controls and content containers now have theme-matched **82%-opaque / 18%-transparent backings**. Dark uses `rgba(22,22,22,.82)`; Light uses `rgba(233,229,220,.82)`. This softens the texture behind text while retaining a faint trace of the approved artwork.

Coverage includes text/Cancel and quiet buttons, Settings, drawer/menu actions, destructive controls, switches and inactive segmented options, input fields, account-ad containers, gallery cards, compact cards and preview strips. Existing solid primary buttons, selected states, focus rings and disabled behavior stay unchanged. Layout-only wrappers, photograph elements/buttons, gallery stage frames, in-gallery ad plates and endcards are not repainted.

Only `background-color` is added. No element opacity, blur, filter, extra DOM layer, layout, scrolling, hit-box or photograph-size change is introduced. Dark viewer surfaces stay dark independently of the owner theme. Reduced transparency, increased contrast or the native shell's existing reduced-transparency stamp makes the backing fully opaque.

**Blank remains the gallery default.** Gallery Canvas choices, 10px Dark/Light margins, the 256px repeat, stronger ink palette and frozen source artwork are unchanged. The public marketing homepage stays excluded.

## Reviewed previews

[Dark Library](web-library-dark.png) · [Light Library](web-library-light.png)

Both are 1440×900 browser captures of the actual local app, taken after fonts, texture decode and finite transitions settled. They were reviewed and copied byte-for-byte, without cropping, resizing, annotation or photograph re-encoding. They are not native-shell evidence or production screenshots. The encrypted MEGA row honestly displays its existing locked-source placeholder.

## Verification

| Check | Final result |
| --- | --- |
| Root TypeScript | Pass |
| Complete mirrored unit/privacy suite | **2,421 pass / 0 fail**, 33,550 assertions, 196 files, 55.35 seconds |
| Web/Worker, native-web, desktop-web production builds | All pass |
| Canvas and translucent-surface browser contracts | **51/51 pass**, phone 375×812 touch/DPR3, desktop 1440×900, wide 2560×1440; 1.6 minutes |
| Public Dark/Light SVG versus copies in all three bundles | Byte-identical |
| Uploaded JSON versus retained source | Exact SHA-256 match: `16c19ef3be3c830d7ef5a8f8d0fb27c670c1995a765d96667e4cbec9f072565d` |
| Patch whitespace | Pass |

The new browser contracts load real web/native/desktop stylesheets. They prove paired alpha fills, dark-scope isolation, opaque accessibility fallbacks, unchanged primary/selected colors, retained disabled opacity, unchanged dimensions/hit boxes and excluded photograph/ad/endcard surfaces. Existing gallery/default/geometry/input/accessibility contracts remain intact.

The first root unit run caught native ad class names in shared app sources. The implementation now uses the container's existing `[data-account-ad]` styling hook; the native-only placement guard was not weakened or edited and passes in the final complete suite. The final browser run used a fresh direct-CSS response and all four real provider seeds. Failed diagnostic logs remain available in working storage rather than being labelled green.

## Remaining release gates

The earlier broader viewer acceptance suite remains red/incomplete with baseline/fixture blockers documented in `docs/gallery-ground.md`. Fresh six-state iPhone, landscape iPad and macOS native-shell captures are still required before commit. The earlier 1024px native captures and current browser CSS fixtures cannot substitute for that evidence.

The previously identified faint native-web Light opening footer still needs foreground-contrast review; this follow-up does not claim complete AA certification of every text tier. No protected session fixture, GUI takeover, installed-app modification, remote migration, provider write, commit, push, PR or deployment was performed. Temporary task-owned verification services are stopped after review.
