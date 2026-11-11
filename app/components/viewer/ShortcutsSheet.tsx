import { Sheet } from '../ui/Sheet'

/** The keyboard-shortcut reference — its own sheet so the Settings
 *  popover stays about the gallery. Opened by the `?` key and by the
 *  "Keyboard shortcuts" row at the foot of the Settings view page;
 *  Escape closes it through the shared overlay stack like any sheet. */
export default function ShortcutsSheet({
  open,
  onClose,
  magnifierAvailable = false,
  magnifierActive = false,
}: {
  open: boolean
  onClose: () => void
  magnifierAvailable?: boolean
  magnifierActive?: boolean
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard shortcuts">
      <ul class="m-shortcut-list">
        <li><kbd>G</kbd> photograph selector</li>
        <li><kbd>←</kbd> <kbd>→</kbd> move between photographs</li>
        <li><kbd>Home</kbd> <kbd>End</kbd> jump to the ends</li>
        {magnifierAvailable ? <li><kbd>M</kbd> magnify under the cursor{magnifierActive ? ' (on)' : ''}</li> : null}
        <li><kbd>I</kbd> image info</li>
        <li><kbd>⇧I</kbd> standalone c2pa viewer (new tab)</li>
        <li><kbd>?</kbd> keyboard shortcuts</li>
        <li><kbd>Esc</kbd> close controls</li>
      </ul>
    </Sheet>
  )
}
