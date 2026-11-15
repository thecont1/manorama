import { deviceShortName, type Device } from '../../../packages/core/devices'

/** A device's coloured pill. The colour slot is unique among the owner's
 *  live devices, so "Mac 1" and "Mac 2" never wear the same one; the name
 *  inside keeps the pill readable without colour at all. */
export const DevicePill = ({ device, devices }: {
  device: Device | null
  devices: readonly Device[]
}) => device
  ? (
    <span
      class="device-pill"
      data-colour={String(device.colour)}
      data-device-id={device.id}
      title={deviceShortName(device, devices)}
    >{deviceShortName(device, devices)}</span>
  )
  : <span class="device-pill" data-colour="none" title="Another device">Another device</span>
