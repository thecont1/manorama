import { useEffect, useState } from 'hono/jsx'
import type { AdminUserSummary } from '../lib/user-repository'
import type { AdSuppression } from '../lib/ads-visibility'

type Props = { ownerName?: string; accountId: string }
type UserPage = { users: AdminUserSummary[]; page: number; pageSize: number; total: number; totalPages: number }
type Overview = { users?: UserPage; suppressions?: AdSuppression[]; error?: string }

const asDate = (value?: string) => value
  ? new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).toLocaleString()
  : '—'

export default function AdminOps({ ownerName, accountId }: Props) {
  const [users, setUsers] = useState<AdminUserSummary[]>([])
  const [suppressions, setSuppressions] = useState<AdSuppression[]>([])
  const [day, setDay] = useState('')
  const [region, setRegion] = useState('')
  const [countryFilter, setCountryFilter] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [status, setStatus] = useState('Loading operations data…')
  const [busy, setBusy] = useState(false)

  const refresh = async (requestedPage = page, requestedCountry = countryFilter) => {
    setStatus('Loading operations data…')
    try {
      const params = new URLSearchParams({ page: String(requestedPage) })
      if (requestedCountry) params.set('country', requestedCountry)
      const response = await fetch(`/api/admin/overview?${params}`, { cache: 'no-store' })
      const payload = await response.json() as Overview
      if (!response.ok || !payload.users) throw new Error(payload.error || 'The operations overview could not be loaded')
      setUsers(payload.users.users)
      setPage(payload.users.page)
      setTotal(payload.users.total)
      setTotalPages(payload.users.totalPages)
      setSuppressions(payload.suppressions ?? [])
      setStatus('Updated just now')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The operations overview could not be loaded')
    }
  }

  useEffect(() => { void refresh(1, '') }, [])

  const toggleSuppression = async (kind: 'day' | 'region', value: string, suppressed: boolean) => {
    const normalized = kind === 'region' ? value.trim().toUpperCase() : value.trim()
    if (!normalized) return
    setBusy(true)
    try {
      const response = await fetch('/api/ads/suppressions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, value: normalized, suppressed }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'The global setting could not be saved')
      await refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The global setting could not be saved')
    } finally {
      setBusy(false)
    }
  }

  const toggleMaster = async (user: AdminUserSummary, granted: boolean) => {
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.accountId)}/master`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ granted }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'The master role could not be changed')
      await refresh()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The master role could not be changed')
    } finally {
      setBusy(false)
    }
  }

  const removeUser = async (user: AdminUserSummary) => {
    if (user.accountId === accountId) return
    const typed = window.prompt(`To delete ${user.displayName || user.ownerSlug}, type this exact account ID:\n\n${user.accountId}`)
    if (typed?.trim() !== user.accountId) {
      if (typed !== null) setStatus('Deletion cancelled: the account ID did not match')
      return
    }
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.accountId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmAccountId: typed.trim() }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'The account could not be deleted')
      await refresh()
      setStatus(`Deleted ${user.displayName || user.ownerSlug}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The account could not be deleted')
    } finally {
      setBusy(false)
    }
  }

  const isSuppressed = (kind: 'day' | 'region', value: string) => suppressions.some((item) => item.kind === kind && item.value === value)
  const updateRegion = (value: string) => {
    const normalized = value.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase()
    setRegion(normalized)
    setCountryFilter(normalized)
    setPage(1)
    if (normalized.length === 0 || normalized.length === 2) void refresh(1, normalized)
  }

  return (
    <main class="ops-page">
      <header class="ops-header">
        <div>
          <p class="eyebrow">manorama / private operations</p>
          <h1>Keep the manor healthy.</h1>
          <p class="ops-intro">Signed in as <strong>{ownerName || accountId}</strong>. This console exposes account metadata and global presentation switches, never photographs or provider subjects.</p>
        </div>
        <a class="ops-back" href="/">Return home</a>
      </header>
      <p class="ops-status" role="status" aria-live="polite">{status}</p>
      <section class="ops-section" aria-labelledby="ops-settings-heading">
        <div class="ops-section-heading">
          <div><p class="eyebrow">site-wide</p><h2 id="ops-settings-heading">Global presentation</h2></div>
          <span class="ops-count">{suppressions.length} active</span>
        </div>
        <p class="ops-copy">These settings affect all public gallery plates. Day values use UTC. Region values are ISO-3166 alpha-2 viewer-country codes supplied by Cloudflare Geo-IP; an undetermined country fails open and shows the plate.</p>
        <div class="ops-settings-grid">
          <form onSubmit={(event: Event) => { event.preventDefault(); void toggleSuppression('day', day, !isSuppressed('day', day)) }}>
            <label>UTC day<input type="date" value={day} onInput={(event) => setDay((event.target as HTMLInputElement).value)} /></label>
            <button type="submit" disabled={busy || !day}>{isSuppressed('day', day) ? 'Show on this day' : 'Hide on this day'}</button>
          </form>
          <form onSubmit={(event: Event) => { event.preventDefault(); void toggleSuppression('region', region, !isSuppressed('region', region.toUpperCase())) }}>
            <label>Viewer country / account filter<input value={region} maxLength={2} placeholder="IN" onInput={(event) => updateRegion((event.target as HTMLInputElement).value)} /></label>
            <button type="submit" disabled={busy || !/^[A-Z]{2}$/.test(region)}>{isSuppressed('region', region) ? 'Show in this country' : 'Hide in this country'}</button>
          </form>
        </div>
        {suppressions.length ? <ul class="ops-suppression-list">{suppressions.map((item) => <li key={`${item.kind}:${item.value}`}><span>{item.kind === 'day' ? 'UTC day' : 'Viewer country'} · {item.value}</span><button type="button" disabled={busy} onClick={() => void toggleSuppression(item.kind, item.value, false)}>Remove</button></li>)}</ul> : <p class="ops-muted">No global suppression is active.</p>}
      </section>
      <section class="ops-section" aria-labelledby="ops-users-heading">
        <div class="ops-section-heading">
          <div><p class="eyebrow">accounts</p><h2 id="ops-users-heading">People using manorama</h2></div>
          <button type="button" class="ops-refresh" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        </div>
        <p class="ops-copy">Showing {total ? `${(page - 1) * 100 + 1}–${Math.min(page * 100, total)} of ${total}` : '0'} accounts. Masters stay at the top, followed by newest accounts. The Global Presentation country field filters this table instantly by each account’s last sign-in country; it is not a residence claim.</p>
        <div class="ops-table-wrap">
          <table class="ops-users-table">
            <thead><tr><th scope="col">Account</th><th scope="col">Galleries</th><th scope="col">Device lists</th><th scope="col">Sign-ins</th><th scope="col">Last seen</th><th scope="col">Created</th><th scope="col">Access</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {users.map((user) => <tr key={user.accountId}>
                <th scope="row"><span class="ops-user-name">{user.displayName || 'Unnamed account'}</span><span class="ops-user-slug">/{user.ownerSlug} · {user.tier}</span><code class="ops-user-id">{user.accountId}</code></th>
                <td>{user.galleryCount}</td>
                <td>{user.deviceGalleryCount}</td>
                <td>{user.identityCount}</td>
                <td>{user.lastSeenCountry || '—'}</td>
                <td>{asDate(user.createdAt)}</td>
                <td>{user.isMaster ? <span class="ops-master-label">Master</span> : <span class="ops-muted">Standard</span>}</td>
                <td class="ops-actions">{user.accountId === accountId ? <span class="ops-master-label">Current account</span> : <><button type="button" class="ops-role" disabled={busy} onClick={() => void toggleMaster(user, !user.isMaster)}>{user.isMaster ? 'Revoke master' : 'Make master'}</button><button type="button" class="ops-delete" disabled={busy} onClick={() => void removeUser(user)}>Delete</button></>}</td>
              </tr>)}
              {!users.length ? <tr><td class="ops-empty" colSpan={8}>No accounts match this filter.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <nav class="ops-pagination" aria-label="Account pages">
          <button type="button" disabled={busy || page <= 1} onClick={() => void refresh(page - 1)} aria-label="Previous page">Previous</button>
          <span>Page {page} of {totalPages}</span>
          <button type="button" disabled={busy || page >= totalPages} onClick={() => void refresh(page + 1)} aria-label="Next page">Next</button>
        </nav>
      </section>
    </main>
  )
}
