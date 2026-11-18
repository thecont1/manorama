import { LIBRARY_STATES } from '../home-manifest'

/**
 * The Library in four appearances.
 *
 * The four captures are the same Library — dark, quiet and dark, quiet and
 * light, light — dissolved into one another on a clock. The quiet captures
 * are the same pixels with the words dimmed and the photographs untouched,
 * so the dissolve between a loud state and its quiet twin reads as the
 * interface going out rather than as a cut between two pictures.
 *
 * The frame is a rule around the picture, and its bottom rule is far
 * thicker than the rest: the captions live inside that rule, so the name
 * of the state and the line that says what it is for are held by the
 * frame itself rather than floating under it.
 *
 * The frame is steel and stays steel — the band is one object on the page,
 * not a piece of the page's chrome, so it does not turn with the theme.
 *
 * The captures are served at their own size: the file the browser
 * downloads is 3456 wide, which is what a 1728-wide canvas asks a 2×
 * screen for, so nothing is resampled between the capture and the
 * device's pixels. The file is a lossless WebP, so the pixels that
 * arrive are the pixels that were captured, and the profile, the EXIF
 * and the XMP ride along inside it. The captures are 3456×2168 — a
 * 1728×1084 window at 2× — and the frame is held to about the width of
 * the demo device in the hero above it, so the band reads at the same
 * scale as the picture of the app it sits beneath.
 *
 * Only the first capture is in the markup, so the band is whole without
 * scripting and the page does not ask for all four at once. The loop
 * fetches each capture as it reaches it.
 */
export default function LibraryShowcase() {
  return (
    <section class="home-band home-library-band" id="library">
      <div class="home-wrap">
        <h2 class="home-h2 home-rise home-rise-1">Your Library, in every light.</h2>
        <p class="home-lede home-rise home-rise-2">
          Dark or light, one switch — and a quiet view that sinks the interface, so the
          photographs come forward.
        </p>
      </div>

      {/* The frame sits in a row of its own, held to about the width of
          the demo device above it and centred on the page. */}
      <div class="home-library-row">
        <div
          class="home-library home-rise home-rise-3"
          data-library-loop
          data-state="0"
        >
          <div class="home-library-stage">
            {LIBRARY_STATES.map((state, index) => (
              <div
                key={state.src}
                class="home-library-layer"
                data-library-layer={String(index)}
                aria-hidden={index === 0 ? 'false' : 'true'}
              >
                {/* The first capture is in the markup: the band is whole
                    without scripting, and the page asks for one picture
                    rather than four. The loop fetches the rest as it
                    reaches them. */}
                <img
                  src={index === 0 ? `/home/${state.src}.webp` : undefined}
                  data-library-src={`/home/${state.src}.webp`}
                  alt={state.alt}
                  width={3456}
                  height={2168}
                  // The band sits below the fold, so the first capture is
                  // fetched when the visitor comes to it rather than with
                  // the page. The rest are fetched by the loop.
                  loading={index === 0 ? 'lazy' : undefined}
                  decoding="async"
                  fetchpriority={index === 0 ? 'low' : 'auto'}
                />
              </div>
            ))}
          </div>

          {/* The bottom rule of the frame. The captions are stacked on top of
              one another in it and the loop swaps them; only the one on
              show is exposed to a reader. */}
          <div class="home-library-rail">
            <div class="home-library-captions">
              {LIBRARY_STATES.map((state, index) => (
                <p
                  key={state.src}
                  class="home-library-caption"
                  data-library-caption={String(index)}
                  aria-hidden={index === 0 ? 'false' : 'true'}
                >
                  <span class="home-library-index">{String(index + 1).padStart(2, '0')}</span>
                  <span class="home-library-name">{state.name}</span>
                  <span class="home-library-sep" aria-hidden="true">
                    ·
                  </span>
                  <span class="home-library-line">{state.caption}</span>
                </p>
              ))}
            </div>

            <div class="home-library-controls">
              <div class="home-library-dots" aria-hidden="true">
                {LIBRARY_STATES.map((state, index) => (
                  <span key={state.src} class="home-library-dot" data-library-dot={String(index)} />
                ))}
              </div>
              {/* Hidden until the script takes over: without scripting there
                  is no loop to pause, and a dead control is worse than no
                  control. */}
              <button
                class="home-library-pause"
                type="button"
                data-library-pause
                aria-label="Pause the Library loop"
                hidden
              >
                pause
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
