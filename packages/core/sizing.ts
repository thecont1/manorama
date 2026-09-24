export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const coeffA = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1
const coeffB = (a1: number, a2: number) => 3 * a2 - 6 * a1
const evalAt = (t: number, a1: number, a2: number) =>
  ((coeffA(a1, a2) * t + coeffB(a1, a2)) * t + 3 * a1) * t
const slopeAt = (t: number, a1: number, a2: number) =>
  3 * coeffA(a1, a2) * t * t + 2 * coeffB(a1, a2) * t + 3 * a1

/** Newton–Raphson solver for CSS cubic-bezier(x1,y1,x2,y2): given x (time),
 *  returns y (progress) exactly as a browser transition would compute it. */
export const makeBezier = (x1: number, y1: number, x2: number, y2: number) => (x: number) => {
  let t = x
  for (let i = 0; i < 4; i += 1) {
    const slope = slopeAt(t, x1, x2)
    if (slope === 0) break
    t -= (evalAt(t, x1, x2) - x) / slope
  }
  return evalAt(t, y1, y2)
}

/** The app's signature ease — same curve the curtain lift and the
 *  single-mode crossfade use — so a JS-driven glide feels identical to
 *  the CSS-animated surfaces. */
export const glideEase = makeBezier(0.22, 1, 0.36, 1)
