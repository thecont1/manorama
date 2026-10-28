/** Data-hue progress meter (saving, plan usage, storage). On light surfaces
 *  --m-data-outline adds an ink outline so pink never carries state alone. */
type Props = {
  label: string
  value: number
  max: number
  valueText?: string
}

export function Meter({ label, value, max, valueText }: Props) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div class="m-meter">
      <div
        class="m-meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueText}
      >
        <div class="m-meter-fill" style={`width:${pct}%`} />
      </div>
    </div>
  )
}
