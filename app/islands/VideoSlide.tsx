import { useEffect, useRef, useState } from 'hono/jsx'
import type { VideoItem } from '../lib/imagesource'
import { connectionOf, shouldAutoplayVideo, videoAudibleFor } from '../lib/video-playback'

/**
 * One video slide's media lifecycle — and nothing else. The parent Viewer
 * owns the index, navigation, and modals; this leaf owns only the
 * `<video>` element beneath its frame.
 *
 * The playback model is deliberately singular: **ambient muted loop**.
 * A slide plays as soon as it MOUNTS — arriving at a video finds motion
 * already underway rather than starting it. The parent bounds how many
 * videos exist (see `videoMountsFor`), which is what keeps "play on load"
 * from meaning "decode the whole gallery". There is no seek bar and no
 * autoplay-with-sound on first sight.
 *
 * Sound is viewer-level state held by the parent, and only the ACTIVE
 * slide is ever audible: neighbours run muted so two clips never overlap.
 *
 * On a connection too poor for smooth playback the frame stays a still
 * image — the parent declines to mount us at all.
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

  // Playback is driven by MOUNTING, not activation: a loaded video is
  // already running by the time the visitor reaches it. Reduced motion
  // never autoplays — the poster plus an explicit Play control stand in.
  // `isActive` is deliberately absent from the deps: stepping onto a
  // slide must not restart a clip that has been looping all along.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !videoAudibleFor({ isActive, soundOn })
    if (!shouldAutoplayVideo({
      prefersReducedMotion,
      connection: connectionOf(typeof navigator === 'undefined' ? null : navigator),
      documentHidden: typeof document !== 'undefined' && document.hidden,
    })) return
    void attemptPlay()
  }, [prefersReducedMotion])

  // Sound follows the active slide. A neighbour that is already looping
  // must drop to muted the moment it stops being the one on screen, so
  // two clips never overlap.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const audible = videoAudibleFor({ isActive, soundOn })
    video.muted = !audible
    if (audible && video.paused && !prefersReducedMotion) void attemptPlay()
  }, [soundOn, isActive])

  // A backgrounded tab must not keep decoding video.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = () => {
      const video = videoRef.current
      if (!video) return
      if (document.hidden) { video.pause(); return }
      if (shouldAutoplayVideo({
        prefersReducedMotion,
        connection: connectionOf(typeof navigator === 'undefined' ? null : navigator),
      })) void attemptPlay()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [prefersReducedMotion])

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
        // `auto`, not `metadata`: a neighbour must have buffered enough to
        // be genuinely running by the time the visitor steps onto it. The
        // mount radius is what keeps this from costing the whole gallery.
        preload="auto"
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
        isActive ? <p class="video-unavailable" role="status">Video unavailable</p> : null
      ) : (
        // Neighbours are mounted and looping, but they are not the slide
        // the visitor is on: showing their controls would duplicate the
        // Play/Mute buttons and leak offscreen clips into the a11y tree.
        isActive ? (
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
        ) : null
      )}
    </div>
  )
}
