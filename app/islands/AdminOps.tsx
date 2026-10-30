import { useEffect, useState } from 'hono/jsx'
import type { AdminUserSummary } from '../lib/user-repository'

type Props = { ownerName?: string; accountId: string }
type UserList = { users: AdminUserSummary[]; total: number }
type Overview = { users?: UserList; error?: string }

const asDate = (value?: string) => value
  ? new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).toLocaleString()
  : '—'

type SortKey = 'account' | 'galleries' | 'devices' | 'signins' | 'lastseen' | 'created' | 'access' | 'actions'

const SORT_KEYS: Record<SortKey, (user: AdminUserSummary) => string | number> = {
  account: (u) => (u.displayName || u.ownerSlug).toLowerCase(),
  galleries: (u) => u.galleryCount,
  devices: (u) => u.deviceGalleryCount,
  signins: (u) => u.identityCount,
  lastseen: (u) => u.lastSeenCountry || '',
  created: (u) => u.createdAt || '',
  access: (u) => (u.isMaster ? 0 : u.tier === 'pro' ? 1 : 2),
  actions: (u) => u.accountId,
}

const icon = { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true }
const IconUp = () => <svg {...icon}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
const IconDown = () => <svg {...icon}><path d="M12 5v14" /><path d="m5 12 7 7 7-7" /></svg>
const IconBan = () => <svg {...icon}><circle cx="12" cy="12" r="8.25" /><path d="m6.2 6.2 11.6 11.6" /></svg>
const IconCheck = () => <svg {...icon}><circle cx="12" cy="12" r="8.25" /><path d="m8.4 12.3 2.4 2.4 4.8-5.4" /></svg>
const IconTrash = () => <svg {...icon}><path d="M4 7h16" /><path d="M9.5 7V4.5h5V7" /><path d="m6.5 7 .9 12.5h9.2L17.5 7" /><path d="M10 11v5" /><path d="M14 11v5" /></svg>

export default function AdminOps({ ownerName, accountId }: Props) {
  const [users, setUsers] = useState<AdminUserSummary[]>([])
  const [status, setStatus] = useState('Loading operations data…')
  const [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null)

  const refresh = async () => {
    setStatus('Loading operations data…')
    try {
      const response = await fetch('/api/admin/overview', { cache: 'no-store' })
      const payload = await response.json() as Overview
      if (!response.ok || !payload.users) throw new Error(payload.error || 'The operations overview could not be loaded')
      setUsers(payload.users.users)
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

  const setDisabled = async (user: AdminUserSummary, disabled: boolean) => {
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.accountId)}/disabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'The account could not be updated')
      await refresh()
      setStatus(disabled
        ? `Disabled ${user.displayName || user.ownerSlug} — sign-in is now refused`
        : `Enabled ${user.displayName || user.ownerSlug}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The account could not be updated')
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

  const cycleSort = (key: SortKey) =>
    setSort((current) => (!current || current.key !== key ? { key, dir: 1 } : current.dir === 1 ? { key, dir: -1 } : null))

  const sorted = sort
    ? [...users].sort((a, b) => {
        const ka = SORT_KEYS[sort.key](a)
        const kb = SORT_KEYS[sort.key](b)
        const primary = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb))
        return primary * sort.dir || a.accountId.localeCompare(b.accountId)
      })
    : users

  const sortTh = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort?.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" class="ops-sort" onClick={() => cycleSort(key)}>
        {label}<span class="ops-sort-ind" aria-hidden="true">{sort?.key === key ? (sort.dir === 1 ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  )

  return (
    <main class="ops-page">
      <div class="ops-top">
        <p class="ops-logo"><span class="brand-mark-wrap"><img class="ops-logo-mark" src="/manorama-merged-logo.png" alt="manorama" /><span class="brand-tld" aria-hidden="true">.xyz</span></span></p>
        <a class="ops-back" href="/">Return home</a>
      </div>
      <header class="ops-header">
        <div>
          <h1>manorama housekeeping</h1>
          <p class="ops-intro">Signed in as <strong>{ownerName || accountId}</strong>. This console exposes account metadata, never photographs or provider subjects.</p>
        </div>
      </header>
      <p class="ops-status" role="status" aria-live="polite">{status}</p>
      <section class="ops-section" aria-label="accounts">
        <div class="ops-table-wrap">
          <table class="ops-users-table">
            <thead><tr>
              {sortTh('account', 'Account')}
              {sortTh('galleries', 'Galleries')}
              {sortTh('devices', 'Device lists')}
              {sortTh('signins', 'Sign-ins')}
              {sortTh('lastseen', 'Last seen')}
              {sortTh('created', 'Created')}
              {sortTh('access', 'Access')}
              {sortTh('actions', 'Actions')}
            </tr></thead>
            <tbody>
              {sorted.map((user) => <tr key={user.accountId} class={user.disabledAt ? 'ops-user-disabled' : undefined}>
                <th scope="row"><span class="ops-user-name">{user.displayName || 'Unnamed account'}</span><span class="ops-user-slug">/{user.ownerSlug} · {user.tier}</span>{user.disabledAt ? <span class="ops-user-flag">sign-in disabled</span> : null}<code class="ops-user-id">{user.accountId}</code></th>
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
                <td class="ops-actions-cell">{user.isMaster || user.accountId === accountId ? null : <div class="ops-actions">
                  <button type="button" class="ops-action" title={user.tier === 'pro' ? 'Downgrade to Free' : 'Upgrade to Visionary'} aria-label={`${user.tier === 'pro' ? 'Downgrade' : 'Upgrade'} ${user.displayName || user.ownerSlug}`} disabled={busy} onClick={() => void setTier(user, user.tier === 'pro' ? 'free' : 'pro')}>{user.tier === 'pro' ? <IconDown /> : <IconUp />}</button>
                  <button type="button" class={user.disabledAt ? 'ops-action ops-action-enable' : 'ops-action'} title={user.disabledAt ? 'Enable sign-in' : 'Disable sign-in'} aria-label={`${user.disabledAt ? 'Enable' : 'Disable'} ${user.displayName || user.ownerSlug}`} disabled={busy} onClick={() => void setDisabled(user, !user.disabledAt)}>{user.disabledAt ? <IconCheck /> : <IconBan />}</button>
                  <button type="button" class="ops-action ops-action-danger" title="Delete account" aria-label={`Delete ${user.displayName || user.ownerSlug}`} disabled={busy} onClick={() => void removeUser(user)}><IconTrash /></button>
                </div>}</td>
              </tr>)}
              {!users.length ? <tr><td class="ops-empty" colSpan={8}>No accounts match this filter.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
