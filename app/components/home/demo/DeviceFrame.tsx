import type { Child } from 'hono/jsx'
import { deviceFrameSize, deviceViewerSize, type DemoPreset } from './presets'

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
  const bodyHeight = preset.screen.height + preset.bezel * 2
  const glassRadius = Math.max(0, preset.bodyRadius - preset.rim)
  const duoBodyRadius = `${preset.bodyRadius}px 0 0 ${preset.bodyRadius}px`
  const duoGlassRadius = `${glassRadius}px 0 0 ${glassRadius}px`

  return (
    <div
      class={`home-demo-device home-demo-device--${preset.id}`}
      data-demo-device
      data-demo-model={preset.model}
      data-orientation={preset.orientation}
      ref={deviceRef}
      style={`width:${frame.width}px;height:${frame.height}px`}
    >
      {preset.id === 'duo' ? (
        <>
          <div class="home-demo-duo-plane home-demo-duo-plane--left" style={`left:0;top:0;width:${bodyWidth / 2}px;height:${bodyHeight}px`}>
            <div class="home-demo-device-body" style={`inset:0;border-radius:${duoBodyRadius}`} />
            <div class="home-demo-device-glass" style={`inset:${preset.rim}px;border-radius:${duoGlassRadius}`} />
          </div>
          <div class="home-demo-duo-plane home-demo-duo-plane--right" style={`right:0;top:0;width:${bodyWidth / 2}px;height:${bodyHeight}px`}>
            <div class="home-demo-device-body" style={`inset:0;border-radius:0 ${preset.bodyRadius}px ${preset.bodyRadius}px 0`} />
            <div class="home-demo-device-glass" style={`inset:${preset.rim}px;border-radius:0 ${glassRadius}px ${glassRadius}px 0`} />
          </div>
        </>
      ) : (
        <>
          <div
            class="home-demo-device-body"
            style={`left:${preset.baseOverhang}px;top:0;width:${bodyWidth}px;height:${bodyHeight}px;border-radius:${preset.bodyRadius}px`}
          />
          <div
            class="home-demo-device-glass"
            style={`left:${preset.baseOverhang + preset.rim}px;top:${preset.rim}px;width:${bodyWidth - preset.rim * 2}px;height:${bodyHeight - preset.rim * 2}px;border-radius:${glassRadius}px`}
          />
        </>
      )}
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
        style={`left:${preset.baseOverhang + preset.bezel}px;top:${preset.bezel}px;width:${preset.screen.width}px;height:${preset.screen.height}px;border-radius:${preset.screenRadius}px;--home-screen-radius:${preset.screenRadius}px;--home-demo-safe-top:${preset.chromeTop}px`}
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
        {preset.id === 'duo' ? <div class="home-demo-duo-hinge" data-demo-hinge style={`width:${preset.screen.width * 0.015}px`} /> : null}
      </div>
    </div>
  )
}
