import Diptych, { type DiptychFrame, type DiptychSegment } from '../../../../native/islands/Diptych'

export const duoSpreadStartIndexes = (count: number) =>
  Array.from({ length: Math.ceil(Math.max(0, count) / 2) }, (_, index) =>
    Math.min(index * 2, Math.max(0, count - 2)))

export default function DemoDuoTrack({
  frames,
  allFrames,
  activeIndex,
  segments,
  dpr,
}: {
  frames: readonly DiptychFrame[]
  allFrames: readonly DiptychFrame[]
  activeIndex: number
  segments: readonly DiptychSegment[]
  dpr: number
}) {
  const starts = duoSpreadStartIndexes(allFrames.length)
  const spreads = starts.map((start) => allFrames.slice(start, start + 2))
  const requested = spreads.findIndex((spread) =>
    spread[0]?.id === frames[0]?.id && spread[1]?.id === frames[1]?.id)
  const current = Math.max(0, requested)
  const viewportWidth = Math.max(...segments.map((segment) => segment.x + segment.width))

  return (
    <div
      class="home-demo-duo-spread-track"
      data-demo-duo-track
      data-demo-spread={current + 1}
      style={{
        width: `${viewportWidth * spreads.length}px`,
        transform: `translateX(${-current * viewportWidth}px)`,
      }}
    >
      {spreads.map((spread, index) => (
        <div
          class="home-demo-duo-spread"
          data-demo-duo-spread={index + 1}
          data-current={index === current ? 'true' : 'false'}
          aria-hidden={index === current ? undefined : 'true'}
          key={spread.map((frame) => frame.id).join(':')}
          style={{ width: `${viewportWidth}px`, flex: `0 0 ${viewportWidth}px` }}
        >
          <Diptych
            frames={spread}
            activeIndex={index === current ? activeIndex : -1}
            segments={segments}
            dpr={dpr}
          />
        </div>
      ))}
    </div>
  )
}
