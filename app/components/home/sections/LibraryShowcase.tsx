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
 * The captures are served at exactly twice the viewable area: the frame is
 * at most 1312 CSS pixels wide and its 2-pixel rules take four of them, so
 * the picture is 1308 across and the file is 2616. On a retina screen the
 * capture's own pixels land one for one on the device's.
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

        <div
          class="home-library home-rise home-rise-3"
          data-library-loop
          data-state="0"
        >
          <div class="home-library-stage">
            {LIBRARY_STATES.map((state, index) => (
              <picture
                key={state.src}
                class="home-library-layer"
                data-library-layer={String(index)}
                aria-hidden={index === 0 ? 'false' : 'true'}
              >
                <source
                  type="image/avif"
                  srcSet={`/home/${state.src}-sm.avif 1308w, /home/${state.src}.avif 2616w`}
                  sizes="(min-width: 1440px) 1308px, 92vw"
                />
                <source
                  type="image/webp"
                  srcSet={`/home/${state.src}-sm.webp 1308w, /home/${state.src}.webp 2616w`}
                  sizes="(min-width: 1440px) 1308px, 92vw"
                />
                <img
                  src={`/home/${state.src}.jpg`}
                  alt={state.alt}
                  width={2616}
                  height={1641}
                  loading={index === 0 ? 'eager' : 'lazy'}
                  decoding={index === 0 ? 'sync' : 'async'}
                  fetchpriority={index === 0 ? 'high' : 'auto'}
                />
              </picture>
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
