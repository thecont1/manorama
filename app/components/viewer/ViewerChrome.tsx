import type { FoldVerticalBarEdge } from '../../../packages/core/fold'

/** Temporary viewer chrome: horizontal bars ordinarily, or one physical side
 *  column when UIKit puts the system bars on a vertical edge. Purely
 *  presentational — the viewer owns every handler. Always inside .m-dark. */

export type ViewerChromeProps = {
  visible: boolean
  demo?: boolean
  position: { index: number; total: number }
  positionLabel?: string
  onReturnToGalleries?: () => void
  libraryHref?: string
  onOpenSettings: () => void
  onOpenInfo: () => void
  onOpenPicker: () => void
  pickerAriaLabel: string
  onRequestShow: () => void
  onActivity: () => void
  onIdle: () => void
  settingsRef?: (el: HTMLButtonElement | null) => void
  positionRef?: (el: HTMLButtonElement | null) => void
  verticalBarEdge?: FoldVerticalBarEdge
  topStyle?: Record<string, string | undefined> | undefined
  bottomStyle?: Record<string, string | undefined> | undefined
  verticalStyle?: Record<string, string | undefined> | undefined
}

export default function ViewerChrome({
  visible,
  demo = false,
  position,
  positionLabel,
  onReturnToGalleries,
  libraryHref,
  onOpenSettings,
  onOpenInfo,
  onOpenPicker,
  pickerAriaLabel,
  onRequestShow,
  onActivity,
  onIdle,
  settingsRef,
  positionRef,
  verticalBarEdge = 'unspecified',
  topStyle,
  bottomStyle,
  verticalStyle,
}: ViewerChromeProps) {
  const vertical = verticalBarEdge === 'leading' || verticalBarEdge === 'trailing'
  const label = positionLabel ?? `${position.index + 1} of ${position.total}`
  const [range, total] = label.split(' of ')
  const libraryContents = vertical
    ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m14 5-7 7 7 7" /></svg>
    : <><span aria-hidden="true">‹</span> Library</>
  const showLibrary = Boolean(onReturnToGalleries || libraryHref)
  const activity = { onFocusCapture: onActivity, onFocusOut: onIdle, onPointerEnter: onActivity, onPointerLeave: onIdle }
  const library = showLibrary ? (
    libraryHref ? (
      <a class="m-chrome-pill" href={libraryHref} aria-label="Library" title="Library" data-chrome-library>
        {libraryContents}
      </a>
    ) : (
      <button type="button" class="m-chrome-pill" onClick={onReturnToGalleries} aria-label="Library" title="Library" data-chrome-library>
        {libraryContents}
      </button>
    )
  ) : null
  const controls = <>
    <button ref={positionRef} type="button" class="m-chrome-pill" onClick={onOpenPicker} aria-label={pickerAriaLabel} data-chrome-position data-demo-position={demo ? '' : undefined}>
      {vertical ? <><span>{range}</span><span class="m-chrome-total">of {total}</span></> : label}
    </button>
    <button ref={settingsRef} type="button" class="m-chrome-pill" onClick={onOpenSettings} aria-label="Gallery Settings" title="Gallery Settings">
      {vertical ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="#0a0a0a" /><circle cx="15" cy="17" r="3" fill="#0a0a0a" /></svg> : 'Gallery Settings'}
    </button>
    <button type="button" class="m-chrome-pill" onClick={onOpenInfo} aria-label="Info" title="Info">
      {vertical ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></svg> : 'Info'}
    </button>
  </>

  return (
    <>
      <button type="button" class={`m-chrome-skip${vertical ? ` m-chrome-skip--${verticalBarEdge}` : ''}`} onClick={onRequestShow}>Show controls</button>
      {vertical ? (
        <nav
          class={`m-chrome m-chrome--side m-chrome--side-${verticalBarEdge} ${visible ? 'is-visible' : ''}`}
          inert={visible ? undefined : true}
          aria-hidden={visible ? undefined : 'true'}
          style={verticalStyle}
          data-chrome-top
          data-chrome-bottom
          data-demo-chrome-top={demo ? '' : undefined}
          data-demo-chrome-bottom={demo ? '' : undefined}
          aria-label="Viewer controls"
          {...activity}
        >
          {library}
          {controls}
        </nav>
      ) : (
        <>
          <header
            class={`m-chrome m-chrome--top ${visible ? 'is-visible' : ''}`}
            inert={visible ? undefined : true}
            aria-hidden={visible ? undefined : 'true'}
            style={topStyle}
            data-chrome-top
            data-demo-chrome-top={demo ? '' : undefined}
            {...activity}
          >
            {library}
          </header>
          <nav
            class={`m-chrome m-chrome--bottom ${visible ? 'is-visible' : ''}`}
            inert={visible ? undefined : true}
            aria-hidden={visible ? undefined : 'true'}
            style={bottomStyle}
            data-chrome-bottom
            data-demo-chrome-bottom={demo ? '' : undefined}
            aria-label="Viewer controls"
            {...activity}
          >
            {controls}
          </nav>
        </>
      )}
    </>
  )
}
