// Watch-set sequencing for remote streams, kept browser-independent so the
// consume/close decisions are unit-testable without a signaling session.
//
// The hard part isn't the diff, it's the timing: a consume takes several awaited
// round-trips (Consume → transport.consume → Pause/Resume) before it appears in
// the consumer map, and the watch set can move twice in that window. Anything
// that reads "am I consuming this?" therefore has to count consumes that are
// still in flight, or a watch→unwatch→watch race starts a second consumer for
// the same producer and orphans the first server-side.

// Is this producer still covered by the given watch intent? Mic audio is not
// watch-gated — it is consumed as soon as it exists and stays for the session —
// so anything we don't recognize as a watched-stream producer counts as wanted.
export function isProducerWatched({
  producerId,
  watchedProducerIds,
  watchedClientIds,
  videoProducers,
  screenAudioProducers
}) {
  if (videoProducers.has(producerId)) return watchedProducerIds.has(producerId)
  const screenAudio = screenAudioProducers.get(producerId)
  if (screenAudio) return watchedClientIds.has(screenAudio.clientId)
  return true
}

// Resolve a new watch intent against everything we currently hold.
//
//   requestedProducerIds — video producers the UI wants watched
//   videoProducers       — Map producerId -> { clientId, producedType }
//   screenAudioProducers — Map producerId -> { clientId }
//   activeConsumers      — Map producerId -> { kind, producedType, clientId, consumerId }
//   pendingConsumeIds    — producerIds whose consume is mid-flight
//
// Returns the watch sets to store plus three disjoint work lists: `close`
// (consumers we hold and no longer want), `consume` (wanted producers we hold
// nothing for and have nothing in flight for), and `abandon` (in-flight consumes
// whose producer is no longer wanted — they own no consumer yet, so their
// teardown has to be chained onto the consume itself).
export function resolveWatchIntent({
  requestedProducerIds = [],
  videoProducers,
  screenAudioProducers,
  activeConsumers,
  pendingConsumeIds = []
}) {
  const watchedProducerIds = new Set(
    [...requestedProducerIds].filter((producerId) => videoProducers.has(producerId))
  )
  // Screen-share audio follows the same watch set as the video, but keyed by
  // client: the audio producer is separate from the video producer, so it binds
  // by whose stream is watched.
  const watchedClientIds = new Set(
    [...watchedProducerIds].map((producerId) => videoProducers.get(producerId).clientId)
  )

  const close = []
  for (const [producerId, entry] of activeConsumers) {
    if (entry.kind === 'video' && !watchedProducerIds.has(producerId)) {
      close.push({ producerId, kind: 'video', consumerId: entry.consumerId })
    } else if (entry.producedType === 'ScreenShareAudio' && !watchedClientIds.has(entry.clientId)) {
      close.push({ producerId, kind: 'screenAudio', consumerId: entry.consumerId })
    }
  }

  const pending = new Set(pendingConsumeIds)
  const isConsuming = (producerId) => activeConsumers.has(producerId) || pending.has(producerId)

  const consume = []
  for (const producerId of watchedProducerIds) {
    if (isConsuming(producerId)) continue
    const { clientId, producedType } = videoProducers.get(producerId)
    consume.push({ producerId, kind: 'video', clientId, producedType })
  }
  // Screen audio for every watched client whose audio producer we know about.
  // Producers that arrive later are picked up by the NewProducer handler.
  for (const [producerId, { clientId }] of screenAudioProducers) {
    if (!watchedClientIds.has(clientId) || isConsuming(producerId)) continue
    consume.push({ producerId, kind: 'audio', clientId, producedType: 'ScreenShareAudio' })
  }

  const abandon = [...pending].filter(
    (producerId) =>
      !isProducerWatched({
        producerId,
        watchedProducerIds,
        watchedClientIds,
        videoProducers,
        screenAudioProducers
      })
  )

  return { watchedProducerIds, watchedClientIds, close, consume, abandon }
}
