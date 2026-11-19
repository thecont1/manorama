import type { Child } from 'hono/jsx'
import { deviceFrameSize, deviceViewerSize, type DemoPreset } from './presets'

const foldClipPath = (width: number, height: number, dip: number) => {
  const cx = width / 2
  const notch = Math.min(96, width * 0.1)
  return `path("M0 0H${cx - notch}Q${cx} ${dip} ${cx + notch} 0H${width}V${height}H${cx + notch}Q${cx} ${height - dip} ${cx - notch} ${height}H0Z")`
}

export default function DeviceFrame({
  preset,
  deviceRef,
  viewerRef,
  children,
}: {
  preset: DemoPreset
  deviceRef: (el: HTMLDivElement | null) => void
  viewerRef: (el: HTMLDivElement | null) => void
  children: Child
}) {
  const frame = deviceFrameSize(preset)
  const viewer = deviceViewerSize(preset)
  const bodyWidth = preset.screen.width + preset.bezel * 2
  const bodyHeight = preset.screen.height + (preset.bezelY ?? preset.bezel) * 2
  const glassRadius = Math.max(0, preset.bodyRadius - preset.rim)
  // The partial-open posture: the silhouette pinches to a shallow V where the
  // halves angle back toward the hinge, top and bottom alike.
  const foldClip = preset.fold ? foldClipPath(bodyWidth, bodyHeight, preset.fold.dip) : undefined

  return (
    <div
      class={`home-demo-device home-demo-device--${preset.id}`}
      data-demo-device
      data-demo-model={preset.model}
      data-orientation={preset.orientation}
      ref={deviceRef}
      style={`width:${frame.width}px;height:${frame.height}px`}
    >
      <div
        class="home-demo-device-body"
        style={`left:${preset.baseOverhang}px;top:0;width:${bodyWidth}px;height:${bodyHeight}px;border-radius:${preset.bodyRadius}px${foldClip ? `;clip-path:${foldClip}` : ''}`}
      />
      <div
        class="home-demo-device-glass"
        style={`left:${preset.baseOverhang + preset.rim}px;top:${preset.rim}px;width:${bodyWidth - preset.rim * 2}px;height:${bodyHeight - preset.rim * 2}px;border-radius:${glassRadius}px`}
      />
      {preset.id === 'desktop' ? <div class="home-demo-laptop-base" style={`height:${preset.baseHeight}px`} /> : null}
      {preset.id === 'phone' ? (
        <>
          <span class="home-demo-side-button" style="left:-3px;top:150px;width:3px;height:28px" />
          <span class="home-demo-side-button" style="left:-3px;top:207px;width:3px;height:52px" />
          <span class="home-demo-side-button" style="left:-3px;top:271px;width:3px;height:52px" />
          <span class="home-demo-side-button" style="right:-3px;top:224px;width:3px;height:84px" />
        </>
      ) : null}
      {preset.id === 'tablet' ? (
        <>
          <span class="home-demo-side-button" style="right:-2px;top:190px;width:3px;height:54px" />
          <span class="home-demo-side-button" style="right:-2px;top:256px;width:3px;height:54px" />
          <span class="home-demo-side-button" style={`right:150px;top:-2px;width:76px;height:3px`} />
          <span class="home-demo-camera" data-demo-camera style={`left:${(preset.rim + preset.bezel) / 2 - 4.5}px;top:${bodyHeight / 2 - 4.5}px`} />
        </>
      ) : null}
      <div
        class="home-demo-screen"
        style={`left:${preset.baseOverhang + preset.bezel}px;top:${preset.bezelY ?? preset.bezel}px;width:${preset.screen.width}px;height:${preset.screen.height}px;border-radius:${preset.screenRadius}px;--home-screen-radius:${preset.screenRadius}px;--home-demo-safe-top:${preset.chromeTop}px`}
      >
        <div
          class="home-demo-viewer"
          data-demo-screen
          ref={viewerRef}
          style={`left:${preset.viewerInset.left}px;top:${preset.viewerInset.top}px;width:${viewer.width}px;height:${viewer.height}px`}
          aria-hidden="true"
          inert
        >
          {children}
        </div>
        {preset.notch ? (
          <>
            <div class="home-demo-notch-strip" style={`height:${preset.notch.height}px`} />
            <div class="home-demo-notch" data-demo-notch style={`width:${preset.notch.width}px;height:${preset.notch.height}px`} />
          </>
        ) : null}
        {preset.island ? (
          <div
            class="home-demo-island"
            data-demo-island
            style={`top:${preset.island.top}px;width:${preset.island.width}px;height:${preset.island.height}px`}
          />
        ) : null}
        {preset.fold ? <div class="home-demo-duo-crease" /> : null}
      </div>
    </div>
  )
}
