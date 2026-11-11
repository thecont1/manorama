import { ENTITLEMENTS } from '../entitlements'

/**
 * The comparison, as a real table: a caption, column headers and row
 * headers, so a screen reader can say which plan a cell belongs to.
 *
 * Under 720px the same rows stack, and each cell repeats the column it
 * belongs to. Nothing is carried by an icon alone.
 */
export default function ComparisonTable() {
  return (
    <div class="home-table-wrap">
      <table class="home-table">
        <caption>
          What each plan includes. Every row is enforced by the product, not by this page.
        </caption>
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
                {row.free}
              </td>
              <td data-label="Visionary">
                <span class="home-table-cell-label">Visionary</span>
                {row.visionary}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
