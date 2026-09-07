import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * Custom hook for a resilient WebSocket connection with auto-reconnect.
 *
 * @param {string} url - WebSocket URL (e.g. "ws://localhost:8000/ws")
 * @returns {{ data: object|null, status: 'connecting'|'open'|'closed' }}
 */
export function useOccupancySocket(url) {
  const [data, setData] = useState(null)
  const [status, setStatus] = useState('connecting')
  const wsRef = useRef(null)
  const reconnectTimer = useRef(null)
  const mountedRef = useRef(true)

  const connect = useCallback(() => {
    if (!mountedRef.current) return

    setStatus('connecting')

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      setStatus('open')
      console.log('[WS] Connected')
    }

    ws.onmessage = (event) => {
      if (!mountedRef.current) return
      try {
        const parsed = JSON.parse(event.data)
        setData(parsed)
      } catch {
        console.warn('[WS] Failed to parse message:', event.data)
      }
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setStatus('closed')
      console.log('[WS] Disconnected — reconnecting in 3s')
      reconnectTimer.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      // The close handler will fire next and trigger reconnect.
      ws.close()
    }
  }, [url])

  useEffect(() => {
    mountedRef.current = true
    connect()

    return () => {
      mountedRef.current = false
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { data, status }
}
