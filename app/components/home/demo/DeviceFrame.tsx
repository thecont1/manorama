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

  return (
    <div
      class={`home-demo-device home-demo-device--${preset.id}`}
      data-demo-device
      data-demo-model={preset.model}
      ref={deviceRef}
      style={`width:${frame.width}px;height:${frame.height}px`}
    >
      <div
        class="home-demo-device-body"
        style={`left:${preset.baseOverhang}px;top:0;width:${bodyWidth}px;height:${bodyHeight}px;border-radius:${preset.bodyRadius}px`}
      />
      {preset.id === 'desktop' ? <div class="home-demo-laptop-base" style={`height:${preset.baseHeight}px`} /> : null}
      {preset.id === 'phone' ? (
        <>
          <span class="home-demo-side-button" style="left:122px;top:-6px;width:64px;height:6px" />
          <span class="home-demo-side-button" style="left:198px;top:-6px;width:64px;height:6px" />
          <span class="home-demo-side-button" style="right:122px;bottom:-6px;width:82px;height:6px" />
        </>
      ) : null}
      {preset.id === 'tablet' ? <span class="home-demo-side-button" style="right:92px;top:-6px;width:70px;height:6px" /> : null}
      <div
        class="home-demo-screen"
        style={`left:${preset.baseOverhang + preset.bezel}px;top:${preset.bezel}px;width:${preset.screen.width}px;height:${preset.screen.height}px;border-radius:${preset.screenRadius}px;--home-screen-radius:${preset.screenRadius}px`}
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
        {preset.island ? <div class="home-demo-island" data-demo-island style={`width:${preset.island.width}px;height:${preset.island.height}px`} /> : null}
        {preset.homeIndicator ? (
          <div
            class="home-demo-home-indicator"
            data-demo-home-indicator
            style={`width:${preset.homeIndicator.width}px;height:${preset.homeIndicator.height}px;bottom:${preset.homeIndicator.bottom}px`}
          />
        ) : null}
      </div>
    </div>
  )
}
