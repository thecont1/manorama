import { Sheet } from '../ui/Sheet'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import type { Child } from 'hono/jsx'
import { useId } from 'hono/jsx'

/** The Settings popover: a "View" column (layout, canvas, arrows,
 *  fullscreen and the native device block) then one role-bound `actions`
 *  column the caller composes — the web owner's inline gallery panel, a
 *  member's Add to Library, a visitor's Sign in, native's Details
 *  handoff. Keyboard shortcuts come last, full width. `wide` splits the
 *  body into two columns (owner inline management on roomy viewports);
 *  narrow stacks View → role → shortcuts. Changes apply immediately and
 *  the popover stays open; persistence is the caller's. */

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
  magnifierAvailable?: boolean
  magnifierActive?: boolean
  /** Native only — "On this device" (TODO(P7): lives in Gallery details). */
  deviceControls?: Child
  /** The role-bound ActionGroup rendered beside the view controls. */
  actions?: Child
  /** Two-column body — the owner panel earns the extra width. */
  wide?: boolean
  panelStyle?: Record<string, string | undefined> | undefined
}

export default function SettingsSheet({
  open, onClose, mode, onMode, background, onBackground, arrowsOn, onArrows,
  fullscreenAvailable, fullscreenActive, onFullscreen, showShortcuts,
  magnifierAvailable, magnifierActive, deviceControls, actions, wide = false, panelStyle,
}: SettingsSheetProps) {
  const arrowsDescId = `m-desc-${useId()}`
  const fsDescId = `m-desc-${useId()}`
  const layoutHint =
    mode === 'strip' ? 'Side by side, edge to edge'
    : mode === 'vertical' ? 'Each photograph fits the width'
    : 'One at a time, swipe or tap'
  const canvasHint =
    background === 'none' ? 'No space between photographs'
    : background === 'dark' ? 'Black background, space around images'
    : 'White background, space around images'
  return (
    <div class="m-dark">
      <Sheet open={open} onClose={onClose} title="Settings" popover panelStyle={panelStyle}>
        <div class={`m-sheet-cols${wide ? ' m-sheet-cols--two' : ''}`}>
          <div class="m-sheet-col" data-settings-view>
            <h3 class="m-actiongroup-label">View</h3>
            {deviceControls ? <section class="m-sheet-section"><h3 class="m-sheet-label">On this device</h3>{deviceControls}</section> : null}
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
          {actions ? (
            <div class="m-sheet-col" data-settings-role>
              <section class="m-sheet-section m-sheet-actions" data-settings-actions>{actions}</section>
            </div>
          ) : null}
        </div>
        {showShortcuts ? (
          <section class="m-sheet-section">
            <h3 class="m-sheet-label">Keyboard shortcuts</h3>
            <ul class="m-shortcut-list">
              <li><kbd>G</kbd> photograph selector</li>
              <li><kbd>←</kbd> <kbd>→</kbd> move between photographs</li>
              <li><kbd>Home</kbd> <kbd>End</kbd> jump to the ends</li>
              {magnifierAvailable ? <li><kbd>M</kbd> magnify under the cursor{magnifierActive ? ' (on)' : ''}</li> : null}
              <li><kbd>I</kbd> image info</li>
              <li><kbd>⇧I</kbd> standalone c2pa viewer (new tab)</li>
              <li><kbd>Esc</kbd> close controls</li>
            </ul>
          </section>
        ) : null}
      </Sheet>
    </div>
  )
}
