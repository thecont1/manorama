import { useEffect, useState } from 'hono/jsx'
import type { AdminUserSummary } from '../lib/user-repository'

type Props = { ownerName?: string; accountId: string }
type UserList = { users: AdminUserSummary[]; total: number }
type Overview = { users?: UserList; error?: string }

const asDate = (value?: string) => value
  ? new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).toLocaleString()
  : '—'

export default function AdminOps({ ownerName, accountId }: Props) {
  const [users, setUsers] = useState<AdminUserSummary[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('Loading operations data…')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setStatus('Loading operations data…')
    try {
      const response = await fetch('/api/admin/overview', { cache: 'no-store' })
      const payload = await response.json() as Overview
      if (!response.ok || !payload.users) throw new Error(payload.error || 'The operations overview could not be loaded')
      setUsers(payload.users.users)
      setTotal(payload.users.total)
      setStatus('Updated just now')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The operations overview could not be loaded')
    }
  }

  useEffect(() => { void refresh() }, [])

  const setTier = async (user: AdminUserSummary, tier: 'free' | 'pro') => {
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.accountId)}/tier`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'The plan could not be changed')
      await refresh()
      setStatus(tier === 'pro'
        ? `Upgraded ${user.displayName || user.ownerSlug} to Visionary`
        : `Downgraded ${user.displayName || user.ownerSlug} to Free`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The plan could not be changed')
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

  return (
    <main class="ops-page">
      <header class="ops-header">
        <div>
          <p class="eyebrow">manorama / private operations</p>
          <h1>Keep the manor healthy.</h1>
          <p class="ops-intro">Signed in as <strong>{ownerName || accountId}</strong>. This console exposes account metadata, never photographs or provider subjects.</p>
        </div>
        <a class="ops-back" href="/">Return home</a>
      </header>
      <p class="ops-status" role="status" aria-live="polite">{status}</p>
      <section class="ops-section" aria-labelledby="ops-users-heading">
        <div class="ops-section-heading">
          <div><p class="eyebrow">accounts</p><h2 id="ops-users-heading">People using manorama</h2></div>
          <button type="button" class="ops-refresh" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        </div>
        <p class="ops-copy">{total} accounts — every one of them. The master stays at the top, followed by newest accounts.</p>
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
                <td>{user.isMaster
                  ? <span class="ops-master-label ops-access-master">Master</span>
                  : user.tier === 'pro'
                    ? <span class="ops-master-label ops-access-visionary">Visionary</span>
                    : <span class="ops-master-label">Free</span>}</td>
                <td class="ops-actions">{user.accountId === accountId ? <span class="ops-master-label">Current account</span> : <><button type="button" class="ops-role" disabled={busy} onClick={() => void setTier(user, user.tier === 'pro' ? 'free' : 'pro')}>{user.tier === 'pro' ? 'Downgrade' : 'Upgrade'}</button><button type="button" class="ops-delete" disabled={busy} onClick={() => void removeUser(user)}>Delete</button></>}</td>
              </tr>)}
              {!users.length ? <tr><td class="ops-empty" colSpan={8}>No accounts match this filter.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
