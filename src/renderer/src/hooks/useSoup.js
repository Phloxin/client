import { useEffect, useState } from 'react'
import { connect, disconnect, publish, subscribe, consumeProducer, resetMediaState, isConnected } from '../lib/soup'

export function useSoup(token) {
  const [connected, setConnected] = useState(false)
  const [streams, setStreams] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!token) return

    connect(token, {
      onConnect: () => setConnected(true),
      onDisconnect: () => {
        setConnected(false)
        setStreams([])
      },
      onNewProducer: async ({ producerId, kind }) => {
        console.log('[useSoup] New producer, consuming:', producerId)
        const result = await consumeProducer(producerId, kind)
        if (result) setStreams((prev) => [...prev, result])
      }
    })

    return () => disconnect()
  }, [token])

  const startPublishing = async () => {
    try {
      await publish((stream) => {
        setStreams((prev) => [...prev, { stream, kind: 'audio', label: 'local' }])
      })
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  const startSubscribing = async () => {
    try {
      await subscribe()
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return { connected, streams, error, startPublishing, startSubscribing }
}