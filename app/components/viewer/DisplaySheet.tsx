import { Sheet } from '../ui/Sheet'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import type { Child } from 'hono/jsx'
import { useId } from 'hono/jsx'

/** The Display sheet: view layout, canvas, arrows and fullscreen — the
 *  old controls-modal's semantics on the P1 sheet. Changes apply
 *  immediately and the sheet stays open; persistence is the caller's. */

export type DisplaySheetProps = {
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
  panelStyle?: Record<string, string | undefined> | undefined
}

export default function DisplaySheet({
  open, onClose, mode, onMode, background, onBackground, arrowsOn, onArrows,
  fullscreenAvailable, fullscreenActive, onFullscreen, showShortcuts,
  magnifierAvailable, magnifierActive, deviceControls, panelStyle,
}: DisplaySheetProps) {
  const arrowsDescId = `m-desc-${useId()}`
  const fsDescId = `m-desc-${useId()}`
  const layoutHint =
    mode === 'strip' ? 'Side by side, edge to edge'
    : mode === 'vertical' ? 'Each photograph fits the width'
    : 'One at a time, swipe or tap'
  const canvasHint =
    background === 'none' ? 'Photographs line up against one another'
    : background === 'dark' ? 'Black background, space around images'
    : 'White background, space around images'
  return (
    <div class="m-dark">
      <Sheet open={open} onClose={onClose} title="Display" panelStyle={panelStyle}>
        {deviceControls ? <section class="m-sheet-section"><h3 class="m-sheet-label">On this device</h3>{deviceControls}</section> : null}
        <section class="m-sheet-section">
          <div class="m-sheet-labelrow"><h3 class="m-sheet-label">Layout</h3><span class="m-sheet-hint">{layoutHint}</span></div>
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
        </section>
        <section class="m-sheet-section">
          <div class="m-sheet-labelrow"><h3 class="m-sheet-label">Canvas</h3><span class="m-sheet-hint">{canvasHint}</span></div>
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
        </section>
        <section class="m-sheet-section">
          <div class="m-sheet-labelrow">
            <Switch
              checked={arrowsOn}
              onChange={onArrows}
              label="Arrows"
              describedBy={arrowsDescId}
            />
            <span class="m-sheet-hint" id={arrowsDescId}>Show next and previous buttons</span>
          </div>
          {fullscreenAvailable ? (
            <div class="m-sheet-labelrow">
              <Switch checked={fullscreenActive} onChange={() => onFullscreen()} label="Fullscreen" describedBy={fsDescId} />
              <span class="m-sheet-hint" id={fsDescId}>Fill the screen</span>
            </div>
          ) : null}
        </section>
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
