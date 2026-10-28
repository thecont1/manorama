/** Temporary viewer chrome: a top bar (Library + position pills) and a
 *  bottom row (Display, Info, optional Details) that fades in on tap,
 *  pointer or focus and auto-hides after 3s of disinterest. Purely
 *  presentational — the viewer owns every handler. Always inside .m-dark;
 *  chrome never follows the owner theme. */

export type ViewerChromeProps = {
  visible: boolean
  position: { index: number; total: number }
  /** Native/desktop go back to the library; web links to libraryHref for
   *  owner/member. Neither renders → no Library pill (visitors). */
  onReturnToGalleries?: () => void
  libraryHref?: string
  onOpenDisplay: () => void
  onOpenInfo: () => void
  onOpenPicker: () => void
  /** Same wording the rest bubble uses: "Photograph N of M — open X". */
  pickerAriaLabel: string
  /** TODO(P7/P10): Details arrives with the details screens. */
  onOpenDetails?: (position: { index: number; total: number }) => void
  /** The skip button and any focus/hover entering the chrome ask the
   *  viewer to reveal it; activity/idle pause and resume the auto-hide. */
  onRequestShow: () => void
  onActivity: () => void
  onIdle: () => void
  displayRef?: (el: HTMLButtonElement | null) => void
  /** Fold shells confine bars to their own segment, like foldControlStyle. */
  topStyle?: Record<string, string | undefined> | undefined
  bottomStyle?: Record<string, string | undefined> | undefined
}

export default function ViewerChrome({
  visible,
  position,
  onReturnToGalleries,
  libraryHref,
  onOpenDisplay,
  onOpenInfo,
  onOpenPicker,
  pickerAriaLabel,
  onOpenDetails,
  onRequestShow,
  onActivity,
  onIdle,
  displayRef,
  topStyle,
  bottomStyle,
}: ViewerChromeProps) {
  const showLibrary = Boolean(onReturnToGalleries || libraryHref)
  const activity = { onFocusCapture: onActivity, onFocusOut: onIdle, onPointerEnter: onActivity, onPointerLeave: onIdle }
  return (
    <>
      {/* The skip button is first in the viewer's tab order — the keyboard
          and screen-reader way to summon controls that hide by default. */}
      <button type="button" class="m-chrome-skip" onClick={onRequestShow}>Show controls</button>
      <header
        class={`m-chrome m-chrome--top ${visible ? 'is-visible' : ''}`}
        inert={visible ? undefined : true}
        aria-hidden={visible ? undefined : 'true'}
        style={topStyle}
        data-chrome-top
        {...activity}
      >
        {showLibrary ? (
          libraryHref ? (
            <a class="m-chrome-pill" href={libraryHref} data-chrome-library>
              <span aria-hidden="true">‹</span> Library
            </a>
          ) : (
            <button type="button" class="m-chrome-pill" onClick={onReturnToGalleries} data-chrome-library>
              <span aria-hidden="true">‹</span> Library
            </button>
          )
        ) : null}
        <button type="button" class="m-chrome-pill" onClick={onOpenPicker} aria-label={pickerAriaLabel} data-chrome-position>
          {position.index + 1} of {position.total}
        </button>
      </header>
      <nav
        class={`m-chrome m-chrome--bottom ${visible ? 'is-visible' : ''}`}
        inert={visible ? undefined : true}
        aria-hidden={visible ? undefined : 'true'}
        style={bottomStyle}
        data-chrome-bottom
        aria-label="Viewer controls"
        {...activity}
      >
        <button ref={displayRef} type="button" class="m-chrome-pill" onClick={onOpenDisplay}>Display</button>
        <button type="button" class="m-chrome-pill" onClick={onOpenInfo}>Info</button>
        {onOpenDetails ? (
          <button type="button" class="m-chrome-pill" onClick={() => onOpenDetails(position)}>Details</button>
        ) : null}
      </nav>
    </>
  )
}
