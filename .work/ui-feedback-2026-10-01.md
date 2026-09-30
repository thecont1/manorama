# Owner UI notes — 1 Oct 2026, 02:45

Owner was viewing DeviceHub ("iPhone 13 Pro Max capture"), which shows whatever
was last installed — the `screens/ios/` PNGs are newer than the live device.

## Done

| # | Note | Where |
| --- | --- | --- |
| 2 | Buttons must not be visible on the curtain. The web app already gets this right. | `native/styles.css` — chrome hidden while `body` lacks `gallery-entered` |
| 4 | Close button should sit in line with the logo, same height. | `native/styles.css` — `.controls-panel-topbar` brand and `.panel-close` share `--native-chrome-height` |

Both are appended at the end of `native/styles.css`, so they win on order without
disturbing the blocks above. Rebuilt into `native/dist` and recaptured next pass.

## Open

| # | Note | Where it lives |
| --- | --- | --- |
| 1 | Opening screen: black bar at the bottom; make the background full-bleed edge to edge. | `.native-landing` (native/styles.css ~463) and the footer row |
| 3 | First image: rearrange the controls. The index is always a circle, so there is room for a more elegant arrangement than three equal-width pills. | `native/styles.css` — the `.stage-arrows` grid and the `.control-logo` width/offset pair |
| 5 | Account/admin screen is confusing and needs restructuring: thumbnails get their own row inside the gallery container; below it, gallery title + item count, subtitle and URL each on their own line. The copy "on your mac", "gallery loading", "plates hidden", "hide today", "hide in this region" is not self-explanatory and needs rewriting. | `native/islands/GalleryList.tsx` (markup and copy), `native/styles.css` |
| — | 05 and 06 screenshots are still the 30 Sep 23:06 captures — they need a signed-in session and the owner's photo library, which cannot be produced on this machine. | — |

## Note on the attachments

Two screenshots were attached during this session (02:14 and 02:30). Both live in
`/var/folders/.../TemporaryItems/NSIRD_screencaptureui_*/`, which the execution
sandbox refuses to read, with or without escalation. They were described in the
message instead, so the notes above are from the wording, not the pixels.
---

## Screen 03 — implemented (unverified)

The row is now a text pill and two circles: `[ wordmark ][ index ][ forward ]`.
The index and the forward arrow are `aspect-ratio: 1` at `--native-chrome-height`,
so they are true circles; the wordmark spans the remaining width and stays
anchored to the row's leading edge.

**The wordmark stays.** It is the only route into the settings modal, and the
modal is the single home for every control. Removing it would leave the modal
reachable only by a gesture nobody has been told about.

Appended to `native/styles.css`, ready for a recapture pass.

## Screen 05 — the copy, located

Every string the owner flagged, with the line it lives on. These are all in
`native/islands/GalleryList.tsx`.

| Line | As it reads now | Problem | Proposed |
| --- | --- | --- | --- |
| 912–913 | `aria-label="On your Mac"` / `<h2>On your Mac</h2>` | Web copy inside an iOS app. Also the section that confuses "device" with "Mac". | `This device` |
| 978 | `Plates hidden` / `Plates shown` | "Plates" is internal vocabulary for ad slots. | `House cards hidden` / `House cards shown` |
| 994 | `Hide today` | Today where? Hides what? | `Hide for the rest of today` |
| 1013 | `<h2>Gallery loading</h2>` | Reads as a stuck state, not a preference. | `How galleries load` |
| 526 | `The gallery loading preference could not be saved on this device.` | Says "gallery loading" as a noun nobody has been introduced to. | `That preference could not be saved on this device.` |

`native/islands/GalleryList.account.test.tsx:574` asserts `'On your Mac'`, so the
test moves with the copy — this is a code change, not a find-and-replace.

## Screen 05 — the layout

Order the account surface as the owner described:

1. **Thumbnails get their own row inside the gallery container.** One horizontal
   row, same fixed viewport-relative height as the photo picker, zero gaps,
   width following each source's aspect ratio, active photograph in shocking
   pink. (AGENTS.md already sets this convention for the picker and editor; the
   admin surface should follow it rather than invent a second treatment.)
2. **Then, each on its own line:** gallery title with the item count, the
   subtitle, and the URL.
3. Then the preferences, with the rewritten copy above.

The preferences block is currently doing too much at once — device, visibility,
region and load policy all read as one undifferentiated list. Grouping them under
the rewritten headings is what turns it from "screaming confusion" into three
recognisable questions.