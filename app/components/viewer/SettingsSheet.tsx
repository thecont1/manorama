import { useEffect, useId, useRef, useState } from 'hono/jsx'
import { Sheet } from '../ui/Sheet'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { ActionGroup, ActionRow } from '../ui/ActionRow'
import { Button } from '../ui/Button'
import type { Child } from 'hono/jsx'

/** The Settings popover: a "View" group (layout, canvas, arrows,
 *  fullscreen) then one role-bound slot — the member's Add to Library, a
 *  visitor's Sign in, or, for an owner with a `galleryPanel`, a single
 *  "Gallery settings" row that drills into the gallery's own page (the
 *  hoisted head plus the panel). Changes apply immediately and the
 *  popover stays open; persistence is the caller's. Keyboard shortcuts
 *  left the popover — the foot row opens ShortcutsSheet. */

export type SettingsSheetProps = {
  open: boolean
  onClose: () => void
  mode: 'strip' | 'vertical' | 'single'
  onMode: (mode: 'strip' | 'vertical' | 'single') => void
  background: 'none' | 'dark' | 'light'
  onBackground: (background: 'none' | 'dark' | 'light') => void
  arrowsOn: boolean
  onArrows: (on: boolean) => void
  fullscreenAvailable: boolean
  fullscreenActive: boolean
  onFullscreen: () => void
  /** (pointer: fine) only — the shortcuts row means nothing on touch. */
  showShortcuts: boolean
  /** The role-bound ActionGroup rendered beside the view controls —
   *  ignored while `galleryPanel` is present (the Gallery settings row
   *  takes the slot instead). */
  actions?: Child
  /** The owner's gallery panel (OwnerGalleryPanel, headless) — its
   *  presence turns the role slot into the Gallery settings drill-in. */
  galleryPanel?: Child
  /** The gallery's identity header (OwnerGalleryHead), rendered at the
   *  top of the gallery page under its heading. */
  galleryIntro?: Child
  /** Opens the shortcuts sheet — the foot row's only job. */
  onOpenShortcuts?: () => void
  panelStyle?: Record<string, string | undefined> | undefined
}

export default function SettingsSheet({
  open, onClose, mode, onMode, background, onBackground, arrowsOn, onArrows,
  fullscreenAvailable, fullscreenActive, onFullscreen, showShortcuts,
  actions, galleryPanel, galleryIntro, onOpenShortcuts, panelStyle,
}: SettingsSheetProps) {
  const arrowsDescId = `m-desc-${useId()}`
  const fsDescId = `m-desc-${useId()}`
  const [page, setPage] = useState<'view' | 'gallery'>('view')
  const galleryHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const galleryRowWrapRef = useRef<HTMLDivElement | null>(null)
  const wasPageRef = useRef(page)

  // Reopening always lands on the view page; the drill-in is per-open.
  useEffect(() => {
    if (!open) setPage('view')
  }, [open])

  // Focus follows the drill: the gallery page's heading on push, the
  // "Gallery settings" row on the way back — never the sheet's own title,
  // which stays put across both pages.
  useEffect(() => {
    if (page === 'gallery' && wasPageRef.current !== 'gallery') {
      galleryHeadingRef.current?.focus()
    } else if (page === 'view' && wasPageRef.current === 'gallery') {
      galleryRowWrapRef.current?.querySelector<HTMLElement>('button')?.focus()
    }
    wasPageRef.current = page
  })

  const layoutHint =
    mode === 'strip' ? 'Side by side, edge to edge'
    : mode === 'vertical' ? 'Each photograph fits the width'
    : 'One at a time, swipe or tap'
  const canvasHint =
    background === 'none' ? 'No space between photographs'
    : background === 'dark' ? 'Black background, space around images'
    : 'White background, space around images'

  /** Escape and the scrim share one dismissal path: inside the gallery
   *  page they step back to the view page first; on the view page they
   *  close the popover. */
  const handleClose = () => {
    if (page === 'gallery') setPage('view')
    else onClose()
  }
  /** The gallery page's Back button — returns to the view page. */
  const goBack = () => setPage('view')

  return (
    <div class="m-dark">
      <Sheet open={open} onClose={handleClose} title="Settings" popover panelStyle={panelStyle}>
        {page === 'gallery' ? (
          <>
            <Button variant="quiet" onClick={goBack} class="m-backbtn" aria-label="Back to Settings">
              <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 6l-6 6 6 6"/></svg>
              Settings
            </Button>
            <h3 class="m-actiongroup-label" tabIndex={-1} ref={galleryHeadingRef}>Gallery settings</h3>
            {galleryIntro ? <div class="m-sheet-intro">{galleryIntro}</div> : null}
            {galleryPanel}
          </>
        ) : (
          <>
            <div class="m-sheet-cols">
              <div class="m-sheet-col" data-settings-view>
                <h3 class="m-actiongroup-label">View</h3>
                <section class="m-sheet-section">
                  <div class="m-sheet-field">
                    <h3 class="m-sheet-label">Layout</h3>
                    <span class="m-sheet-hint">{layoutHint}</span>
                    <Segmented
                      label="Layout"
                      value={mode}
                      onChange={(v) => onMode(v as 'strip' | 'vertical' | 'single')}
                      options={[
                        { value: 'strip', label: 'Strip' },
                        { value: 'vertical', label: 'Scroll' },
                        { value: 'single', label: 'One by one' },
                      ]}
                    />
                  </div>
                </section>
                <section class="m-sheet-section">
                  <div class="m-sheet-field">
                    <h3 class="m-sheet-label">Canvas</h3>
                    <span class="m-sheet-hint">{canvasHint}</span>
                    <Segmented
                      label="Canvas"
                      value={background}
                      onChange={(v) => onBackground(v as 'none' | 'dark' | 'light')}
                      options={[
                        { value: 'none', label: 'Blank' },
                        { value: 'dark', label: 'Dark' },
                        { value: 'light', label: 'Light' },
                      ]}
                    />
                  </div>
                </section>
                <section class="m-sheet-section">
                  <div class="m-sheet-field">
                    <Switch
                      checked={arrowsOn}
                      onChange={onArrows}
                      label="Arrows"
                      describedBy={arrowsDescId}
                    />
                    <span class="m-sheet-hint" id={arrowsDescId}>Show next and previous buttons</span>
                  </div>
                  {fullscreenAvailable ? (
                    <div class="m-sheet-field">
                      <Switch checked={fullscreenActive} onChange={() => onFullscreen()} label="Fullscreen" describedBy={fsDescId} />
                      <span class="m-sheet-hint" id={fsDescId}>Fill the screen</span>
                    </div>
                  ) : null}
                </section>
              </div>
              {galleryPanel ? (
                <div class="m-sheet-col" data-settings-role>
                  <section class="m-sheet-section m-sheet-actions" data-settings-actions>
                    <ActionGroup>
                      <div data-gallery-settings-row ref={galleryRowWrapRef}>
                        <ActionRow label="Gallery settings" onClick={() => setPage('gallery')} />
                      </div>
                    </ActionGroup>
                  </section>
                </div>
              ) : actions ? (
                <div class="m-sheet-col" data-settings-role>
                  <section class="m-sheet-section m-sheet-actions" data-settings-actions>{actions}</section>
                </div>
              ) : null}
            </div>
            {showShortcuts && onOpenShortcuts ? (
              <section class="m-sheet-section">
                <ActionGroup>
                  <ActionRow label="Keyboard shortcuts" onClick={onOpenShortcuts} />
                </ActionGroup>
              </section>
            ) : null}
          </>
        )}
      </Sheet>
    </div>
  )
}
