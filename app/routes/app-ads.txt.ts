import { createRoute } from 'honox/factory'

/** Public AdMob publisher identifier derived from the owner-provided app ID. */
export const ADMOB_PUBLISHER_ID = 'pub-3564536130489009'
export const APP_ADS_TXT = `google.com, ${ADMOB_PUBLISHER_ID}, DIRECT, f08c47fec0942fa0\n`

const handleAppAdsTxt = createRoute((c) => c.text(APP_ADS_TXT, 200, {
  'Cache-Control': 'public, max-age=3600, s-maxage=86400',
  'Content-Type': 'text/plain; charset=utf-8',
}))

export default handleAppAdsTxt
export const GET = handleAppAdsTxt
