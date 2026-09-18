import { useEffect, useRef, useState } from 'hono/jsx'
import type { VideoItem } from '../lib/imagesource'

/**
 * One video slide's media lifecycle — and nothing else. The parent Viewer
 * owns the index, navigation, and modals; this leaf owns only the
 * `<video>` element beneath the active frame.
 *
 * The playback model is deliberately singular: **ambient muted loop**.
 * A slide that becomes active starts playing muted and loops; leaving it
 * pauses and rewinds so returning shows the poster again. There is no
 * seek bar, no per-item mode, no autoplay-with-sound on first sight.
 *
 * Sound is viewer-level state held by the parent: once a visitor presses
 * the megaphone, every subsequently activated video starts audible until
 * they mute again or leave. Nothing is persisted.
 */

type Props = {
  item: VideoItem
  isActive: boolean
  soundOn: boolean
  prefersReducedMotion: boolean
  onToggleSound: (soundOn: boolean) => void
  onPlaybackEvent?: (event: 'playing' | 'paused' | 'error' | 'blocked') => void
}

/** `VIDEO · 1:37`. Falls back to a bare label until a duration is known. */
export const formatDuration = (seconds: number | undefined) => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

export default function VideoSlide({ item, isActive, soundOn, prefersReducedMotion, onToggleSound, onPlaybackEvent }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [hasDecodedFrame, setHasDecodedFrame] = useState(false)
  const [failed, setFailed] = useState(false)
  const [measuredDuration, setMeasuredDuration] = useState<number | undefined>(undefined)

  const duration = item.durationSeconds ?? measuredDuration
  const durationLabel = formatDuration(duration)

  /** Attempts playback, degrading rather than failing: an unmuted play()
   *  rejected by Safari's autoplay policy retries muted, and only a muted
   *  rejection surfaces the Play button. */
  const attemptPlay = async () => {
    const video = videoRef.current
    if (!video) return
    try {
      await video.play()
      onPlaybackEvent?.('playing')
    } catch {
      if (!video.muted) {
        // Sound was refused, motion probably isn't — fall back seamlessly.
        video.muted = true
        try {
          await video.play()
          onPlaybackEvent?.('playing')
          return
        } catch {
          // fall through
        }
      }
      setIsPlaying(false)
      onPlaybackEvent?.('blocked')
    }
  }

  // Activation drives everything. Reduced motion never autoplays: the
  // poster and an explicit Play control stand in, so playback stays
  // user-initiated.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!isActive) {
      video.pause()
      // Rewind so returning to the slide shows the poster, not a frozen
      // mid-clip frame.
      try { video.currentTime = 0 } catch { /* not seekable yet */ }
      setIsPlaying(false)
      setHasDecodedFrame(false)
      return
    }
    video.muted = !soundOn
    if (prefersReducedMotion) return
    void attemptPlay()
  }, [isActive, prefersReducedMotion])

  // Sound is viewer-level: a change applies to the playing video at once.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isActive) return
    video.muted = !soundOn
    if (soundOn && video.paused && !prefersReducedMotion) void attemptPlay()
  }, [soundOn])

  // A backgrounded tab must not keep decoding video.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = () => {
      const video = videoRef.current
      if (!video) return
      if (document.hidden) video.pause()
      else if (isActive && !prefersReducedMotion) void attemptPlay()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [isActive, prefersReducedMotion])

  // Full teardown on unmount: release the media element's buffers rather
  // than leaving a detached video decoding.
  useEffect(() => () => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    video.removeAttribute('src')
    try { video.load() } catch { /* teardown is best-effort */ }
  }, [])

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void attemptPlay()
    else { video.pause(); onPlaybackEvent?.('paused') }
  }

  return (
    <div class={`video-slide ${hasDecodedFrame ? 'is-playing-frame' : ''}`} data-video-slide>
      <video
        ref={videoRef}
        class="frame-video"
        src={item.src}
        poster={item.poster.src}
        width={item.width}
        height={item.height}
        // Ambient defaults. `muted` must be a real attribute at first
        // paint or iOS refuses inline autoplay outright.
        muted
        playsInline
        loop
        preload="metadata"
        aria-label={item.alt}
        onLoadedMetadata={(event: Event) => {
          const video = event.currentTarget as HTMLVideoElement
          if (Number.isFinite(video.duration) && video.duration > 0) setMeasuredDuration(video.duration)
        }}
        // Crossfade only once a real frame has decoded — no black flash
        // between poster and first frame.
        onPlaying={() => { setIsPlaying(true); setHasDecodedFrame(true); setFailed(false) }}
        onPause={() => setIsPlaying(false)}
        onError={() => { setFailed(true); setIsPlaying(false); onPlaybackEvent?.('error') }}
      >
        {item.captions?.map((track) => (
          <track
            key={track.src}
            kind={track.kind ?? 'captions'}
            src={track.src}
            srclang={track.srclang}
            label={track.label}
            default={track.default}
          />
        ))}
      </video>

      {failed ? (
        <p class="video-unavailable" role="status">Video unavailable</p>
      ) : (
        <div class="video-controls" data-video-controls>
          <button
            type="button"
            class="video-control"
            aria-label={isPlaying ? `Pause video: ${item.alt}` : `Play video: ${item.alt}`}
            onClick={togglePlayback}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button
            type="button"
            class="video-control"
            aria-pressed={soundOn ? 'true' : 'false'}
            aria-label={soundOn ? `Mute video: ${item.alt}` : `Unmute video: ${item.alt}`}
            onClick={() => onToggleSound(!soundOn)}
          >
            {soundOn ? '🔊' : '🔇'}
          </button>
          <span class="video-chip" aria-hidden="true">{durationLabel ? `VIDEO · ${durationLabel}` : 'VIDEO'}</span>
        </div>
      )}
    </div>
  )
}
