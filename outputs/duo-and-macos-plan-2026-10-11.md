# manorama: an adaptive photographic workbench

The account pane should be an optional working surface, not a permanent tax on the photographs. A labelled tab at the middle of the left edge is the right entry point on the dashboard. It must never appear on the gallery stage: viewing remains photography-first, and account administration remains a separate task.

## Immediate repairs

The new web pane combined dark text in Light mode with a hard-coded dark surface. Its action hover styles also forced white text. The wordmark retained the old two-column layout's wide intrinsic size, and the pane had no dedicated close button even though the capture runner looked for one. These are product defects, not just slow hydration.

The repair introduces a theme-aware admin surface, legible secondary copy, a fitted original wordmark, a 44-pixel left-edge tab, and a labelled close button. The pane slides from the left using transform-only motion and disables that motion when reduced motion is requested. Escape, backdrop dismissal, focus trapping, focus restoration, and page-scroll locking are covered by browser tests. Repeated “Photo Editor” labels are removed; the accessible rail labels remain.

A separate tooling defect caused false evidence failures: HonoX restarts on file additions/removals throughout its watched root. Exporting screenshots or writing native build artifacts could restart the very server being tested, clear its in-memory galleries, and disconnect its SSR graph. Generated capture, test, and build directories must be excluded from the watcher.

## Duo: two layouts, not a different app for every pose

Apple recommends compact and regular size-class layouts rather than a custom UI per pose, retaining functionality and state as the device changes shape. Its HIG specifically describes a split view expanding on the inner display and collapsing on the outer display. [1]

**Compact presentation:** galleries use the available width; the left-edge tab raises a modal account pane. Keep the trigger inside actual safe-area bounds, not the physical screen edge. Avoid stealing system back gestures: a tap opens the pane; do not install a whole-screen edge-swipe recognizer. The import field, title, caption, URL, and rail actions remain reachable with the software keyboard open.

**Regular presentation:** when the user opens the account pane and there is genuinely enough usable width for both surfaces, offer an inline account column beside the gallery workbench. Keep it closed by default. Use the same content and state as the compact pane, not a second copy of the form. On a real divided display, size the two working regions against the actual division, not an assumed midpoint or a device-name breakpoint.

**A transition is not a reload:** retain the import draft, edited gallery, selected image, rail position, and open/closed state when folding, unfolding, rotating, or entering Split View. A deliberate document refresh still resets transient presentation state and leaves a clean URL.

**No control on the fold:** Apple exposes division and occlusion reserved regions; the division is inactive with zero width while the device is flat and active when folded. UIKit's `UIView.reservedRegions` supplies the corresponding frames. [3] Connect those real frames and safe-area/size-class changes to the existing platform-free `packages/core/fold.ts` model. Do not infer a hinge merely from a wide viewport. Audit tab, pane close button, import submit, gallery actions, viewer dot, and modal fields against those regions.

**The photographs are not ordinary form controls:** keep strip mode as the default continuous canvas. Preserve honest pixel sizing, aspect ratio, ICC and C2PA bytes, and navigation physics. A photographic diptych is an explicit optional viewing mode; do not automatically switch modes just because the phone unfolds. Picker and Global View remain vertically scrolling, aspect-true matrices. The web editor remains one bounded horizontal row per gallery.

### Implementation sequence and release gates

1. Land and verify the current theme/tab repair at phone, iPad, desktop, and wide widths in both themes, with reduced motion on and off.
2. Implement the regular-width inline pane as a single-content adaptive presentation. Make focus management modal only in overlay presentation and nonmodal when inline; preserve drafts and selection while changing layout.
3. In the native lane owned by issue #35, implement the actual UIKit reserved-region bridge and safe-area update delivery. Reuse `packages/core/fold.ts`; keep Worker and device APIs out of core. The current repository has geometry support, but that does not prove the WebView receives live native region updates.
4. Build with Xcode 27.1/iOS 27.1 and verify in Device Hub on Duo. Apple's preparation talk states that 27.1 enables the full-edge layout and provides open/close/rotate/fold controls in Device Hub. [2] Custom Capacitor controls do not automatically become native vertical bars.
5. Test closed, flat-open, partially folded book pose, rotated, resized/Split View, camera-active reserved regions, keyboard open, VoiceOver, pointer, touch, and external keyboard. A browser segment simulation is useful geometry coverage, not a substitute for that native evidence.

Record fresh six-state screenshots from real builds. For iPad, verify the app window really fills a landscape canvas before exporting 2752×2064 captures. A missing `simctl` rotation verb does not prove landscape capture is impossible; use the supported Simulator/Device Hub UI. Do not stretch, rotate a portrait screenshot, crop a letterboxed canvas, or fabricate a native result.

## macOS: restore the existing native product

The user-authored commit `2862ef7` removed `src-tauri` to simplify the repo toward a non-desktop deployment. It did not remove the desktop TypeScript catalogue, viewer, local source adapters, or Tauri dependencies. Previous release tag `v0.2.1` and the existing desktop plan provide a recoverable baseline. Restoring that exact shell is preferable to introducing Electron, a second Capacitor bootstrap, or a new native architecture.

The local build in this task restores the removed Rust crate and its least-privilege capability file. It reuses `desktop/`, loads locally selected folders in place, limits file access to explicitly granted roots, and does not copy or publish photographs. Desktop and web admin are different entry points; the shared viewer and core do not mean the Tauri catalogue automatically receives a web-dashboard redesign.

### Build and acceptance sequence

1. Compile the restored locked Rust graph and fresh desktop frontend; produce a local test `.app` with embedded assets. Keep this clearly distinct from a signed/notarized distribution build.
2. Launch the actual `.app`, inspect its opening surface, and exercise folder selection with an authorized photo folder. Verify local images render, selected-root permissions stay narrow, removable-media absence is graceful, and original bytes are unchanged.
3. Verify keyboard shortcuts, trackpad/wheel/drag navigation, window resizing, menu actions, account handoff, and no accidental publication. Keep P2P, RAW/TIFF support, background folder monitoring, and ambient modes out of this restoration.
4. Bring the desktop catalogue's account controls into the same visual family: theme-aware material, fitted branding, and the optional left-edge pane. Share presentation primitives where practical, but keep platform session/storage adapters separate.
5. Capture opening, curtain, first image, display settings, signed-in account/catalogue, and selector from the built macOS app. Do not label a Chromium screenshot as native macOS evidence.
6. Prepare Developer ID signing, hardened runtime, notarization, and installation acceptance for external distribution. These are separate owner/release gates; this task does not submit or publish an app.

## Evidence standard

Screenshots demonstrate an actual state only when the test verifies its visibility, interaction result, geometry, and theme. Counting files is insufficient: a hidden pane can exist in the DOM, a curtain can still intercept a click, and old screenshots can survive a failed rerun. Failures must have a nonzero exit status and an incremental report. Contrast, overflow, focus, and input behavior must be asserted; cross-width success cannot excuse a failure on a phone.

## References

[1]: https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo "Apple HIG: Designing for iPhone Duo"
[2]: https://developer.apple.com/videos/play/tech-talks/111461/ "Apple Tech Talk: Prepare your app for iPhone Duo"
[3]: https://developer.apple.com/videos/play/tech-talks/111463/ "Apple Tech Talk: Strike a pose with adaptive layouts on iPhone Duo"
