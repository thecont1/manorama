import { DEVICE_KIND_NAME, deviceShortName, sortDevices, type Device } from '../../../packages/core/devices'
import { DevicePill } from './DevicePill'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Day precision, UTC, and locale-free — the legend says when a device was
 *  last seen, never where it was or what it is called. */
export const lastSeenLabel = (iso: string): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'last used recently'
  return `last used ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}

/** The account's device legend. Every signed-in surface carries it, so the
 *  owner can always tell which pill means which machine. `onForget` adds
 *  the Forget action; the device you are on is never offered it. */
export const DeviceLegend = ({ devices, selfId, onForget, onForgetPending, hideLabel }: {
  devices: readonly Device[]
  selfId?: string | null
  onForget?: (device: Device) => void
  onForgetPending?: boolean
  /** Surfaces that already say what the list is (Settings' device group)
   *  hide the in-box label so the rows are the only content. */
  hideLabel?: boolean
}) => {
  if (!devices.length) return null
  const ordered = sortDevices(devices)
  return (
    <section class="lib-devices-legend" {...(hideLabel ? { 'aria-label': 'Your devices' } : { 'aria-labelledby': 'lib-devices-legend-title' })}>
      {hideLabel ? null : <p id="lib-devices-legend-title" class="lib-devices-legend-label">Your devices</p>}
      <dl class="lib-devices-legend-list">
        {ordered.map((device) => (
          <div class="lib-devices-legend-row" data-device-id={device.id}>
            <dt><DevicePill device={device} devices={ordered} /></dt>
            <dd>
              <span class="lib-devices-legend-note">
                {device.id === selfId ? `this ${DEVICE_KIND_NAME[device.kind]}` : lastSeenLabel(device.lastSeenAt)}
              </span>
              {onForget && device.id !== selfId ? (
                <button
                  type="button"
                  class="lib-devices-legend-forget"
                  aria-label={`Forget ${deviceShortName(device, ordered)}`}
                  disabled={onForgetPending}
                  onClick={() => onForget(device)}
                >Forget</button>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
