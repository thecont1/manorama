import { useEffect, useRef, useState } from 'hono/jsx'
import type { RawDumpScanResult, RawDumpStatus } from '../../packages/core/event-clustering'
import { eventClusteringClient, isEventClusteringAvailable, type EventClusteringClient } from './event-clustering'

/** Mounted only while the Library's Camera Roll mode is active.
 * One generation owns all pick/scan continuations, including a clear racing
 * a permission prompt or a Photos change. */
export function useEventClustering(injected?: EventClusteringClient) {
  const client = injected ?? eventClusteringClient()
  const [status, setStatus] = useState<RawDumpStatus | null>(null)
  const [scan, setScan] = useState<RawDumpScanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceRevision, setSourceRevision] = useState(0)
  const generation = useRef(0)
  const mounted = useRef(false)
  const refresh = async (force = false) => {
    if (force) setSourceRevision((value) => value + 1)
    const token = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const next = await client.status()
      if (!mounted.current || token !== generation.current) return
      setStatus(next)
      if (!next?.configured || !next.isAvailable) { setScan(null); return }
      const result = await client.scan(force)
      if (!mounted.current || token !== generation.current) return
      setScan(result)
      const indexed = await client.status()
      if (mounted.current && token === generation.current) setStatus(indexed)
    } catch {
      if (mounted.current && token === generation.current) setError('Events could not be read. Try again.')
    } finally {
      if (mounted.current && token === generation.current) setBusy(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    let listener: { remove(): Promise<void> } | undefined
    void isEventClusteringAvailable(injected).then(async (available) => {
      if (!mounted.current || !available) return
      try {
        listener = await client.changes(() => { setSourceRevision((value) => value + 1); void refresh() })
        if (!mounted.current) { await listener.remove(); return }
      } catch { /* Older shells can still answer commands without notifications. */ }
      if (mounted.current) await refresh()
    })
    return () => {
      mounted.current = false
      generation.current++
      void listener?.remove()
      void client.close().catch(() => {})
    }
  }, [client])
  const pick = async () => {
    setSourceRevision((value) => value + 1)
    const token = ++generation.current
    setBusy(true)
    setError(null)
    try {
      await client.pick()
      if (mounted.current && token === generation.current) await refresh(true)
    } catch {
      if (mounted.current && token === generation.current) {
        const denied = await client.status().catch(() => null)
        if (!mounted.current || token !== generation.current) return
        setStatus(denied)
        setError('Photos access is not granted.')
      }
    } finally { if (mounted.current && token === generation.current) setBusy(false) }
  }
  const clear = async () => {
    setSourceRevision((value) => value + 1)
    const token = ++generation.current
    setScan(null)
    setBusy(true)
    setError(null)
    try {
      await client.clear()
      if (!mounted.current || token !== generation.current) return
      const next = await client.status()
      if (mounted.current && token === generation.current) setStatus(next)
    } catch { if (mounted.current && token === generation.current) setError('The event source could not be cleared. Try again.') }
    finally { if (mounted.current && token === generation.current) setBusy(false) }
  }
  const setDownload = async (enabled: boolean) => {
    const token = ++generation.current
    setBusy(true)
    try {
      await client.setDownload(enabled)
      if (!mounted.current || token !== generation.current) return
      const next = await client.status()
      if (mounted.current && token === generation.current) setStatus(next)
    } catch { if (mounted.current && token === generation.current) setError('That setting could not be saved.') }
    finally { if (mounted.current && token === generation.current) setBusy(false) }
  }
  return { client, status, scan, busy, error, sourceRevision, refresh, pick, clear, setDownload }
}
export type EventClusteringController = ReturnType<typeof useEventClustering>
