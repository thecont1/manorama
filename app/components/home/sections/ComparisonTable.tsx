import { ENTITLEMENTS, SHARED_FEATURES } from '../entitlements'

/**
 * The comparison, as a real table: a caption, column headers and row
 * headers, so a screen reader can say which plan a cell belongs to.
 *
 * The table holds only the rows where the plans differ; what both share
 * is said once below it. Under 720px the same rows stack, and each cell
 * repeats the column it belongs to. Nothing is carried by an icon alone.
 */
export default function ComparisonTable() {
  return (
    <>
      <div class="home-table-wrap">
        <table class="home-table">
          <caption class="home-table-caption">Choose your Library</caption>
          <thead>
            <tr>
              <th scope="col">What you get</th>
              <th scope="col">Free</th>
              <th scope="col">Visionary</th>
            </tr>
          </thead>
          <tbody>
            {ENTITLEMENTS.map((row) => (
              <tr key={row.label}>
                <th scope="row">
                  {row.label}
                  {row.note ? <span class="home-table-note">{row.note}</span> : null}
                </th>
                <td data-label="Free">
                  <span class="home-table-cell-label">Free</span>
                  {row.bigCells ? <span class="home-table-cell-big">{row.free}</span> : row.free}
                </td>
                <td data-label="Visionary">
                  <span class="home-table-cell-label">Visionary</span>
                  {row.bigCells ? <span class="home-table-cell-big">{row.visionary}</span> : row.visionary}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="home-shared">
        <h3 class="home-shared-title">Included with both plans</h3>
        <ul class="home-shared-list">
          {SHARED_FEATURES.map((feature) => (
            <li key={feature.label}>
              {feature.href ? <a href={feature.href}>{feature.label}</a> : feature.label}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
