import { useEffect, useRef, useState } from 'hono/jsx'
import type { RawDumpScanResult, RawDumpStatus } from '../../packages/core/event-clustering'
import type { EventClusteringClient } from './event-clustering'

export const useEventClustering = (client: EventClusteringClient, enabled = true) => {
  const [status, setStatus] = useState<RawDumpStatus | null>(null)
  const [scan, setScan] = useState<RawDumpScanResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
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
      if (!next?.configured || !next.isAvailable) { setScan(null); setStale(false); return }
      const result = await client.scan(force)
      if (!mounted.current || token !== generation.current) return
      setScan(result)
      const indexed = await client.status()
      if (mounted.current && token === generation.current) { setStatus(indexed); setStale(false) }
    } catch {
      if (mounted.current && token === generation.current) {
        setScan(null)
        setError('Events could not be read. Try again.')
      }
    } finally {
      if (mounted.current && token === generation.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (!enabled) return
    mounted.current = true
    let listener: (() => void) | undefined
    void client.changes(() => {
      if (!mounted.current) return
      generation.current++
      setSourceRevision((value) => value + 1)
      setStale(true)
      setBusy(false)
      setError(null)
    }).then(async (off) => {
      if (!mounted.current) { off(); return }
      listener = off
      await refresh()
    }).catch(async () => { if (mounted.current) await refresh() })
    return () => {
      mounted.current = false
      generation.current++
      listener?.()
      client.close()
    }
  }, [client, enabled])

  return { client, status, scan, busy, error, stale, sourceRevision, refresh }
}

export type EventClusteringController = ReturnType<typeof useEventClustering>
