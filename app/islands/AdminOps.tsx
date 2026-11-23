import { useEffect, useState } from 'hono/jsx'
import type { AdminUserSummary } from '../lib/user-repository'
import { DEVICE_KIND_NAME } from '../../packages/core/devices'

/** The console page is normally capped at 1120px; the table grip lets the
 *  operator stretch it on roomy screens. Stored per device — it is a screen
 *  preference, not an account one. */
const PAGE_W_KEY = 'manorama.opman.width'
const PAGE_W_MIN = 1150
const DAY_MS = 24 * 60 * 60 * 1000
/** Sentinel for the "no country yet" chip — a real ISO code can never be it. */
const COUNTRY_NONE = '__none__'
/** Collapsed sections persist per device, like the table width. */
const STATS_KEY = 'manorama.opman.stats'
const TABLE_KEY = 'manorama.opman.table'

type Props = { ownerName?: string; accountId: string }
type UserList = { users: AdminUserSummary[]; total: number }
type Overview = { users?: UserList; error?: string }

/** Ops timestamps read better as two short lines — date, then a dim mono
 *  time — than one wide "23/11/2026, 18:38:44" that overflows its column. */
const dateCell = (value?: string) => {
  if (!value) return '—'
  const d = new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z'))
  if (Number.isNaN(d.getTime())) return '—'
  return <>{d.toLocaleDateString('en-GB')}<span class="ops-cell-sub">{d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span></>
}

const toMs = (value?: string): number => {
  if (!value) return NaN
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
}

const withinDays = (value: string | undefined, days: number, now: number): boolean => {
  const t = toMs(value)
  return !Number.isNaN(t) && now - t <= days * DAY_MS
}

const expiryLabel = (iso?: string): string | null => {
  const t = toMs(iso)
  if (Number.isNaN(t)) return null
  const days = Math.ceil((t - Date.now()) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days}d`
}

/** Consumer-facing provider names, matching the sign-in doors. */
const PROVIDER_LABEL: Record<string, string> = { apple: 'Apple', dropbox: 'Dropbox', google: 'Google Drive' }

/** Gallery-source labels for the Sources column — the fold already turned
 *  each source_url into a provider, so no link ever reaches this table. */
const SOURCE_LABEL: Record<string, string> = {
  dropbox: 'Dropbox',
  gdrive: 'Google Drive',
  icloud: 'iCloud',
  gphotos: 'Google Photos',
  mega: 'MEGA',
  ente: 'Ente',
  proton: 'Proton Drive',
  local: 'Local',
  other: 'Other',
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()

const countryName = (code: string): string => {
  try {
    return regionNames?.of(code) ?? code
  } catch {
    return code
  }
}

const countryLabel = (code?: string): string | null =>
  code ? `${countryName(code)} · ${code}` : null

type SortKey = 'account' | 'galleries' | 'media' | 'sources' | 'apps' | 'country' | 'lastactive' | 'latestgallery' | 'created' | 'access'

const deviceTotal = (user: AdminUserSummary) => user.devices.reduce((n, d) => n + d.count, 0)

const SORT_KEYS: Record<SortKey, (user: AdminUserSummary) => string | number> = {
  account: (u) => (u.displayName || u.ownerSlug).toLowerCase(),
  galleries: (u) => u.galleryCount,
  media: (u) => u.mediaCount,
  sources: (u) => u.sources.length,
  apps: (u) => deviceTotal(u),
  country: (u) => (u.lastSeenCountry ? countryName(u.lastSeenCountry) : ''),
  lastactive: (u) => u.lastSeenAt || '',
  latestgallery: (u) => u.latestGalleryAt || '',
  created: (u) => u.createdAt || '',
  access: (u) => (u.isMaster ? 0 : u.tier === 'pro' ? 1 : 2),
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
  const [countryFilter, setCountryFilter] = useState<string | null>(null)
  const [statsOpen, setStatsOpen] = useState(true)
  const [tableOpen, setTableOpen] = useState(true)

  const refresh = async (): Promise<AdminUserSummary[] | null> => {
    setStatus('Loading operations data…')
    try {
      const response = await fetch('/api/admin/overview', { cache: 'no-store' })
      const payload = await response.json() as Overview
      if (!response.ok || !payload.users) throw new Error(payload.error || 'The operations overview could not be loaded')
      setUsers(payload.users.users)
      setStatus('')
      return payload.users.users
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The operations overview could not be loaded')
      return null
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
      // Only claim success when the refreshed table shows the requested
      // state — a failed refresh keeps its own error, a stale row says so.
      const refreshed = await refresh()
      if (refreshed) {
        const updated = refreshed.find((u) => u.accountId === user.accountId)
        setStatus(updated?.tier === tier
          ? (tier === 'pro'
            ? `Upgraded ${user.displayName || user.ownerSlug} to Visionary`
            : `Downgraded ${user.displayName || user.ownerSlug} to Free`)
          : `The table refreshed but ${user.displayName || user.ownerSlug}'s plan did not change — try again`)
      }
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
      const refreshed = await refresh()
      if (refreshed) {
        const updated = refreshed.find((u) => u.accountId === user.accountId)
        setStatus(Boolean(updated?.disabledAt) === disabled
          ? (disabled
            ? `Disabled ${user.displayName || user.ownerSlug} — sign-in is now refused`
            : `Enabled ${user.displayName || user.ownerSlug}`)
          : `The table refreshed but ${user.displayName || user.ownerSlug}'s sign-in state did not change — try again`)
      }
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
      const refreshed = await refresh()
      if (refreshed) {
        setStatus(refreshed.some((u) => u.accountId === user.accountId)
          ? `The table refreshed but ${user.displayName || user.ownerSlug} is still listed — try again`
          : `Deleted ${user.displayName || user.ownerSlug}`)
      }
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

  const visibleUsers = countryFilter === null
    ? sorted
    : sorted.filter((u) => countryFilter === COUNTRY_NONE ? !u.lastSeenCountry : u.lastSeenCountry === countryFilter)

  // The strip counts real owners only — the master's own test traffic
  // would otherwise inflate every figure.
  const members = users.filter((u) => !u.isMaster)
  const now = Date.now()
  const new7 = members.filter((u) => withinDays(u.createdAt, 7, now)).length
  const new30 = members.filter((u) => withinDays(u.createdAt, 30, now)).length
  const active7 = members.filter((u) => withinDays(u.lastSeenAt, 7, now)).length
  const active30 = members.filter((u) => withinDays(u.lastSeenAt, 30, now)).length
  const withGallery = members.filter((u) => u.galleryCount > 0).length
  const onApp = members.filter((u) => u.devices.length > 0).length
  const totalGalleries = members.reduce((n, u) => n + u.galleryCount, 0)
  const totalMedia = members.reduce((n, u) => n + u.mediaCount, 0)
  const totalTemporary = members.reduce((n, u) => n + u.temporaryGalleryCount, 0)
  const expiringSoon = members.filter((u) => {
    const t = toMs(u.nextGalleryExpiryAt)
    return !Number.isNaN(t) && t > now && t <= now + 7 * DAY_MS
  }).length
  const sourceTotals = new Map<string, number>()
  for (const u of members) {
    for (const s of u.sources) sourceTotals.set(s.provider, (sourceTotals.get(s.provider) ?? 0) + s.count)
  }
  const topSources = [...sourceTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  const countryCounts = new Map<string, number>()
  let noCountry = 0
  for (const u of users) {
    if (u.lastSeenCountry) countryCounts.set(u.lastSeenCountry, (countryCounts.get(u.lastSeenCountry) ?? 0) + 1)
    else noCountry += 1
  }
  const countryChips = [...countryCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const sortTh = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort?.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" class="ops-sort" onClick={() => cycleSort(key)}>
        {label}<span class="ops-sort-ind" aria-hidden="true">{sort?.key === key ? (sort.dir === 1 ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  )

  const [pageW, setPageW] = useState(0)
  useEffect(() => {
    const saved = Number(localStorage.getItem(PAGE_W_KEY))
    if (saved >= PAGE_W_MIN) setPageW(saved)
    if (localStorage.getItem(STATS_KEY) === 'closed') setStatsOpen(false)
    if (localStorage.getItem(TABLE_KEY) === 'closed') setTableOpen(false)
  }, [])

  const toggleStats = () => {
    const next = !statsOpen
    setStatsOpen(next)
    localStorage.setItem(STATS_KEY, next ? 'open' : 'closed')
  }
  const toggleTable = () => {
    const next = !tableOpen
    setTableOpen(next)
    localStorage.setItem(TABLE_KEY, next ? 'open' : 'closed')
  }

  const stretchTo = (width: number) => {
    const next = Math.max(PAGE_W_MIN, Math.round(width))
    setPageW(next)
    localStorage.setItem(PAGE_W_KEY, String(next))
  }

  const onGripDown = (event: PointerEvent) => {
    const grip = event.currentTarget as HTMLElement
    const startX = event.clientX
    const startW = grip.closest('.ops-page')?.getBoundingClientRect().width ?? 1120
    grip.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => setPageW(Math.max(PAGE_W_MIN, Math.round(startW + e.clientX - startX)))
    const up = (e: PointerEvent) => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      stretchTo(startW + e.clientX - startX)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  }

  return (
    <main class="ops-page" style={pageW ? `width:min(${pageW}px, calc(100% - 40px))` : undefined}>
      <div class="ops-top">
        <p class="ops-logo"><span class="brand-mark-wrap"><img class="ops-logo-mark" src="/manorama-merged-logo.png" alt="manorama" /></span></p>
        <a class="ops-back" href="/">Return home</a>
      </div>
      <header class="ops-header">
        <div>
          <h1>housekeeping</h1>
          <p class="ops-intro">Signed in as <strong>{ownerName || accountId}</strong>. This console exposes account metadata, never photographs or provider subjects.</p>
        </div>
      </header>
      <p class="ops-status" role="status" aria-live="polite">{status}</p>
      {users.length ? (
        <section class="ops-summary" aria-label="account overview">
          <button type="button" class="ops-collapse-bar" aria-expanded={statsOpen ? 'true' : 'false'} aria-controls="ops-stats-grid" onClick={toggleStats}>
            <span>Overview</span>
            <span class="ops-summary-note">member accounts only — operators excluded</span>
          </button>
          {statsOpen ? <dl class="ops-stats" id="ops-stats-grid">
            <div class="ops-stat">
              <dt>accounts</dt>
              <dd>{members.length}<span class="ops-stat-sub">+{new7} in 7d · +{new30} in 30d</span></dd>
            </div>
            <div class="ops-stat">
              <dt>active</dt>
              <dd>{active7} / {active30}<span class="ops-stat-sub">last 7d / 30d</span></dd>
            </div>
            <div class="ops-stat">
              <dt>with a gallery</dt>
              <dd>{withGallery} of {members.length}</dd>
            </div>
            <div class="ops-stat">
              <dt>using the app</dt>
              <dd>{onApp} of {members.length}</dd>
            </div>
            <div class="ops-stat">
              <dt>galleries</dt>
              <dd>{totalGalleries}<span class="ops-stat-sub">{totalMedia} media · {totalTemporary} temporary{expiringSoon ? ` · ${expiringSoon} expiring ≤7d` : ''}</span></dd>
            </div>
            <div class="ops-stat">
              <dt>sources</dt>
              <dd class="ops-stat-text">{topSources.length ? topSources.map(([provider, count]) => `${SOURCE_LABEL[provider] ?? provider} ${count}`).join(' · ') : '—'}</dd>
            </div>
          </dl> : null}
          <div class="ops-country-bar">
            <span class="ops-mini-label">country</span>
            <div class="ops-country-chips" role="group" aria-label="Filter accounts by country">
              <button type="button" class="ops-country-chip" aria-pressed={countryFilter === null} onClick={() => setCountryFilter(null)}>All</button>
              {countryChips.map(([code, count]) => (
                <button key={code} type="button" class="ops-country-chip" aria-pressed={countryFilter === code}
                  onClick={() => setCountryFilter(countryFilter === code ? null : code)}>
                  {countryName(code)} <span class="ops-chip-count">{count}</span>
                </button>
              ))}
              {noCountry ? (
                <button type="button" class="ops-country-chip" aria-pressed={countryFilter === COUNTRY_NONE}
                  onClick={() => setCountryFilter(countryFilter === COUNTRY_NONE ? null : COUNTRY_NONE)}>
                  Not yet seen <span class="ops-chip-count">{noCountry}</span>
                </button>
              ) : null}
            </div>
            <span class="ops-summary-note">latest signed-in visit, as Cloudflare reports it · chips filter the whole table</span>
          </div>
        </section>
      ) : null}
      <section class="ops-section" aria-label="accounts">
        <button type="button" class="ops-collapse-bar" aria-expanded={tableOpen ? 'true' : 'false'} aria-controls="ops-accounts-table" onClick={toggleTable}>
          <span>Accounts <span class="ops-collapse-count">({users.length})</span></span>
        </button>
        {tableOpen ? (<>
        <div
          class="ops-table-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to widen the accounts table"
          title="Drag to widen — remembered on this device"
          tabIndex={0}
          onPointerDown={onGripDown}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'ArrowRight') stretchTo((pageW || document.querySelector('.ops-page')?.getBoundingClientRect().width || 1120) + 40)
            if (e.key === 'ArrowLeft') stretchTo((pageW || document.querySelector('.ops-page')?.getBoundingClientRect().width || 1120) - 40)
          }}
        />
        <div class="ops-table-wrap" id="ops-accounts-table">
          <table class="ops-users-table">
            <thead><tr>
              {sortTh('account', 'Account')}
              {sortTh('galleries', 'Galleries')}
              {sortTh('media', 'Media')}
              {sortTh('sources', 'Sources')}
              {sortTh('apps', 'Apps')}
              {sortTh('country', 'Country')}
              {sortTh('lastactive', 'Last active')}
              {sortTh('latestgallery', 'Latest gallery')}
              {sortTh('created', 'Created')}
              {sortTh('access', 'Access')}
              <th scope="col">Actions</th>
            </tr></thead>
            <tbody>
              {visibleUsers.map((user) => {
                const gallerySubs: string[] = []
                if (user.temporaryGalleryCount > 0) {
                  gallerySubs.push(`${user.temporaryGalleryCount} temp${user.nextGalleryExpiryAt ? ` · next ${expiryLabel(user.nextGalleryExpiryAt)}` : ''}`)
                }
                if (user.hiddenGalleryCount > 0) gallerySubs.push(`${user.hiddenGalleryCount} hidden`)
                if (user.localGalleryCount > 0) gallerySubs.push(`${user.localGalleryCount} local`)
                return <tr key={user.accountId} class={user.disabledAt ? 'ops-user-disabled' : undefined}>
                  <th scope="row"><span class="ops-user-name">{user.displayName || 'Unnamed account'}</span><span class="ops-user-slug">/{user.ownerSlug}{user.primaryProvider ? ` · ${PROVIDER_LABEL[user.primaryProvider] ?? user.primaryProvider}` : ''}</span>{user.disabledAt ? <span class="ops-user-flag">sign-in disabled</span> : null}<code class="ops-user-id">{user.accountId}</code>{user.identityCount > 1 ? <span class="ops-cell-sub">{user.identityCount} linked sign-ins</span> : null}</th>
                  <td class="ops-cell-wrap">{user.galleryCount}{gallerySubs.length ? <span class="ops-cell-sub">{gallerySubs.join(' · ')}</span> : null}</td>
                  <td>{user.mediaCount}</td>
                  <td class="ops-cell-wrap">{user.sources.length ? user.sources.map((s) => SOURCE_LABEL[s.provider] ?? s.provider).join(' · ') : '—'}</td>
                  <td class="ops-cell-wrap">{user.devices.length
                    ? user.devices.map((d) => `${DEVICE_KIND_NAME[d.kind] ?? d.kind}${d.count > 1 ? ` ×${d.count}` : ''}`).join(' · ')
                    : <span class="ops-cell-dim">web only</span>}</td>
                  <td class="ops-cell-wrap"><span title={user.lastSeenCountry ? 'Country of the latest signed-in visit' : 'No signed-in activity since country tracking began'}>{countryLabel(user.lastSeenCountry) ?? '—'}</span></td>
                  <td>{dateCell(user.lastSeenAt)}</td>
                  <td>{dateCell(user.latestGalleryAt)}</td>
                  <td>{dateCell(user.createdAt)}</td>
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
                </tr>
              })}
              {!visibleUsers.length ? <tr><td class="ops-empty" colSpan={11}>No accounts match this filter.</td></tr> : null}
            </tbody>
          </table>
        </div>
        </>) : null}
      </section>
    </main>
  )
}
