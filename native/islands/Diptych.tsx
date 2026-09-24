import { effectiveImageDpr } from '../../packages/core/image-staging'

export type DiptychFrame = {
  id: string
  src: string
  width: number
  height: number
  alt: string
  placeholder?: string
}

export type DiptychSegment = {
  x: number
  y: number
  width: number
  height: number
}

export type DiptychLayout =
  | {
      mode: 'diptych'
      frameIndexes: readonly [number, number]
      segments: readonly [DiptychSegment, DiptychSegment]
      sizes: readonly [DiptychSize, DiptychSize]
    }
  | {
      mode: 'single'
      frameIndex: number
      segment: DiptychSegment
      size: DiptychSize
    }

export type DiptychSize = { width: number; height: number }

export type DiptychProps = {
  frames: readonly DiptychFrame[]
  /** Ordered physical display areas. Issue #34 can pass detected viewport
   *  segments here without coupling this component to either platform API. */
  segments: readonly DiptychSegment[]
  dpr?: number
  activeIndex?: number
  class?: string
  renderFrame?: (frame: DiptychFrame, context: DiptychRenderContext) => unknown
}

export type DiptychRenderContext = {
  index: number
  segment: DiptychSegment
  size: DiptychSize
  active: boolean
}

const finitePositive = (value: number) => Number.isFinite(value) && value > 0

export const isUsableDiptychFrame = (frame: DiptychFrame | undefined): frame is DiptychFrame =>
  Boolean(
    frame &&
    frame.id.trim() &&
    frame.src.trim() &&
    finitePositive(frame.width) &&
    finitePositive(frame.height),
  )

export const isUsableDiptychSegment = (segment: DiptychSegment | undefined): segment is DiptychSegment =>
  Boolean(
    segment &&
    Number.isFinite(segment.x) &&
    Number.isFinite(segment.y) &&
    finitePositive(segment.width) &&
    finitePositive(segment.height),
  )

/** Fits a photograph inside one segment while preserving its aspect ratio and
 *  source-pixel budget. The segment is never filled by cropping or stretching. */
export const diptychFrameSize = (
  frame: Pick<DiptychFrame, 'width' | 'height'>,
  segment: Pick<DiptychSegment, 'width' | 'height'>,
  dpr?: number,
): DiptychSize => {
  if (
    !finitePositive(frame.width) ||
    !finitePositive(frame.height) ||
    !finitePositive(segment.width) ||
    !finitePositive(segment.height)
  ) return { width: 0, height: 0 }

  const scale = Math.min(
    segment.width / frame.width,
    segment.height / frame.height,
    1 / effectiveImageDpr(dpr),
  )
  return { width: frame.width * scale, height: frame.height * scale }
}

const singleSegment = (segments: readonly DiptychSegment[]) => {
  const usable = segments.filter(isUsableDiptychSegment)
  if (usable.length === 0) return null
  return usable.reduce((largest, segment) =>
    segment.width * segment.height > largest.width * largest.height ? segment : largest)
}

/** Pure layout decision used by the component and by later viewer adapters.
 *  Diptych is selected only for exactly two usable frames and two usable
 *  segments. Every other input takes the one-at-a-time path safely. */
export const resolveDiptychLayout = (
  frames: readonly DiptychFrame[],
  segments: readonly DiptychSegment[],
  dpr?: number,
  activeIndex = 0,
): DiptychLayout | null => {
  const usableFrames = frames
    .map((frame, index) => ({ frame, index }))
    .filter((entry): entry is { frame: DiptychFrame; index: number } => isUsableDiptychFrame(entry.frame))
  const usableSegments = segments.filter(isUsableDiptychSegment)

  if (usableFrames.length === 2 && usableSegments.length === 2) {
    const pair = usableFrames as [{ frame: DiptychFrame; index: number }, { frame: DiptychFrame; index: number }]
    const ordered = [...usableSegments].sort((a, b) => a.x - b.x || a.y - b.y) as [DiptychSegment, DiptychSegment]
    return {
      mode: 'diptych',
      frameIndexes: [pair[0].index, pair[1].index],
      segments: ordered,
      sizes: [
        diptychFrameSize(pair[0].frame, ordered[0], dpr),
        diptychFrameSize(pair[1].frame, ordered[1], dpr),
      ],
    }
  }

  const selected = usableFrames.find((entry) => entry.index === activeIndex) ?? usableFrames[0]
  const segment = singleSegment(usableSegments)
  if (!selected || !segment) return null
  return {
    mode: 'single',
    frameIndex: selected.index,
    segment,
    size: diptychFrameSize(selected.frame, segment, dpr),
  }
}

const segmentStyle = (segment: DiptychSegment) => ({
  position: 'absolute',
  left: `${segment.x}px`,
  top: `${segment.y}px`,
  width: `${segment.width}px`,
  height: `${segment.height}px`,
  display: 'grid',
  placeItems: 'center',
  overflow: 'hidden',
})

const defaultFrame = (frame: DiptychFrame, context: DiptychRenderContext) => (
  <img
    src={frame.src}
    alt={frame.alt}
    width={frame.width}
    height={frame.height}
    loading={context.active ? 'eager' : 'lazy'}
    decoding="async"
    draggable={false}
    style={{
      display: 'block',
      width: `${context.size.width}px`,
      height: `${context.size.height}px`,
      maxWidth: 'none',
      maxHeight: 'none',
      objectFit: 'contain',
    }}
  />
)

/** A presentation-only spread. Navigation and mode controls remain outside
 *  this stage; callers own interaction and segment detection. */
export default function Diptych({
  frames,
  segments,
  dpr,
  activeIndex = 0,
  class: className,
  renderFrame = defaultFrame,
}: DiptychProps) {
  const layout = resolveDiptychLayout(frames, segments, dpr, activeIndex)
  if (!layout) return null

  const mounts = layout.mode === 'diptych'
    ? layout.segments.map((segment, index) => ({
        frame: frames[layout.frameIndexes[index]],
        context: {
          index: layout.frameIndexes[index],
          segment,
          size: layout.sizes[index],
          active: layout.frameIndexes[index] === activeIndex,
        },
      }))
    : [{
        frame: frames[layout.frameIndex],
        context: { index: layout.frameIndex, segment: layout.segment, size: layout.size, active: true },
      }]

  return (
    <div
      class={['native-diptych', className].filter(Boolean).join(' ')}
      data-diptych-mode={layout.mode}
      data-diptych-stage
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#0a0a0a' }}
    >
      {mounts.map(({ frame, context }) => (
        <figure
          key={frame.id}
          data-diptych-frame={context.index + 1}
          data-image-id={frame.id}
          aria-current={context.active ? 'true' : undefined}
          style={{ ...segmentStyle(context.segment), margin: '0' }}
        >
          {renderFrame(frame, context)}
        </figure>
      ))}
    </div>
  )
}
