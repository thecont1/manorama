import { useEffect, useState } from 'hono/jsx'
import type { AdminUserSummary } from '../lib/user-repository'
import type { AdSuppression } from '../lib/ads-visibility'

type Props = { ownerName?: string; accountId: string }
type Overview = { users?: AdminUserSummary[]; suppressions?: AdSuppression[]; error?: string }

const asDate = (value?: string) => value ? new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).toLocaleString() : '—'

export default function AdminOps({ ownerName, accountId }: Props) {
  const [users, setUsers] = useState<AdminUserSummary[]>([])
  const [suppressions, setSuppressions] = useState<AdSuppression[]>([])
  const [day, setDay] = useState('')
  const [region, setRegion] = useState('')
  const [status, setStatus] = useState('Loading operations data…')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setStatus('Loading operations data…')
    try {
      const response = await fetch('/api/admin/overview', { cache: 'no-store' })
      const payload = await response.json() as Overview
      if (!response.ok) throw new Error(payload.error || 'The operations overview could not be loaded')
      setUsers(payload.users ?? [])
      setSuppressions(payload.suppressions ?? [])
      setStatus('Updated just now')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The operations overview could not be loaded')
    }
  }

  useEffect(() => { void refresh() }, [])

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
        <p class="ops-copy">These settings affect all public gallery plates. They are intentionally available only to the configured master account.</p>
        <div class="ops-settings-grid">
          <form onSubmit={(event: Event) => { event.preventDefault(); void toggleSuppression('day', day, !isSuppressed('day', day)) }}>
            <label>UTC day<input type="date" value={day} onInput={(event) => setDay((event.target as HTMLInputElement).value)} /></label>
            <button type="submit" disabled={busy || !day}>{isSuppressed('day', day) ? 'Show on this day' : 'Hide on this day'}</button>
          </form>
          <form onSubmit={(event: Event) => { event.preventDefault(); void toggleSuppression('region', region, !isSuppressed('region', region.toUpperCase())) }}>
            <label>Region<input value={region} maxLength={2} placeholder="IN" onInput={(event) => setRegion((event.target as HTMLInputElement).value.toUpperCase())} /></label>
            <button type="submit" disabled={busy || !/^[A-Z]{2}$/.test(region)}>{isSuppressed('region', region.toUpperCase()) ? 'Show in this region' : 'Hide in this region'}</button>
          </form>
        </div>
        {suppressions.length ? <ul class="ops-suppression-list">{suppressions.map((item) => <li key={`${item.kind}:${item.value}`}><span>{item.kind === 'day' ? 'Day' : 'Region'} · {item.value}</span><button type="button" disabled={busy} onClick={() => void toggleSuppression(item.kind, item.value, false)}>Remove</button></li>)}</ul> : <p class="ops-muted">No global suppression is active.</p>}
      </section>
      <section class="ops-section" aria-labelledby="ops-users-heading">
        <div class="ops-section-heading">
          <div><p class="eyebrow">accounts</p><h2 id="ops-users-heading">People using manorama</h2></div>
          <button type="button" class="ops-refresh" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        </div>
        <p class="ops-copy">Counts are operational metadata. Deleting an account removes its Manorama records and linked sign-in methods; it does not delete files at Dropbox, Google, Apple, or another source.</p>
        <div class="ops-users">
          {users.map((user) => <article class="ops-user" key={user.accountId}>
            <div class="ops-user-main"><h3>{user.displayName || 'Unnamed account'}</h3><p class="ops-user-slug">/{user.ownerSlug} · {user.tier}</p><p class="ops-user-id">{user.accountId}</p></div>
            <dl class="ops-user-facts"><div><dt>Galleries</dt><dd>{user.galleryCount}</dd></div><div><dt>Device lists</dt><dd>{user.deviceGalleryCount}</dd></div><div><dt>Sign-ins</dt><dd>{user.identityCount}</dd></div><div><dt>Created</dt><dd>{asDate(user.createdAt)}</dd></div></dl>
            {user.accountId === accountId ? <span class="ops-master-label">Master account</span> : <button type="button" class="ops-delete" disabled={busy} onClick={() => void removeUser(user)}>Delete account</button>}
          </article>)}
          {!users.length ? <p class="ops-muted">No accounts returned.</p> : null}
        </div>
      </section>
    </main>
  )
}
