// Small, browser-independent recovery primitives used by soup.js. Keeping the
// failure contract here makes it possible to fault-inject capture and producer
// operations with node:test without loading the whole Electron renderer.

export async function detachRtpSender(sender) {
  if (!sender?.replaceTrack) return false
  await sender.replaceTrack(null)
  return true
}

// mediasoup finishes its local sender negotiation before emitting the transport
// "produce" event that asks the application to create the SFU producer. Run an
// optional one-shot hook at that boundary so strict sender validation can fail
// without replacing an already-live same-type producer on the server.
export async function runBeforeServerProduce(appData, rtpParameters) {
  const beforeServerProduce = appData?.beforeServerProduce
  if (typeof beforeServerProduce !== 'function') return false

  // Producer appData lives for the lifetime of a successful Producer. Remove
  // the setup closure before mediasoup stores it so it cannot retain an RTP
  // sender or capture context after setup completes.
  delete appData.beforeServerProduce
  await beforeServerProduce(rtpParameters)
  return true
}

export async function recoverMicRepublish({
  audioProducers,
  micSettings,
  previousStop,
  candidateStream,
  candidateProcessedStream,
  candidateProcessorStop,
  onStream,
  isCurrent,
  rawMicStream,
  acquireMicCapture,
  buildAudioProcessor,
  stopRawStream,
  stopCandidate,
  micMuted,
  onPreviousStopped,
  onCommit,
  onError = () => {}
}) {
  const cleanupCandidate = () =>
    stopCandidate(candidateStream, candidateProcessedStream, candidateProcessorStop)
  const stopPreviousGraph = () => {
    previousStop?.()
    onPreviousStopped?.(previousStop)
  }

  if (!micSettings || audioProducers.length === 0 || !isCurrent()) {
    stopPreviousGraph()
    cleanupCandidate()
    return false
  }

  // Release a successfully-opened candidate before reopening the committed
  // device profile. candidateStream is null for a getUserMedia failure, where
  // acquireMicCapture has already stopped the previous raw stream.
  stopRawStream(candidateStream)

  let restoredStream
  try {
    restoredStream = await acquireMicCapture(micSettings, rawMicStream)
  } catch (err) {
    onError('capture restore', err)
    stopPreviousGraph()
    cleanupCandidate()
    return false
  }

  let restoredProcessedStream = restoredStream
  let restoredProcessorStop = () => {}
  try {
    const processed = await buildAudioProcessor(restoredStream, micSettings)
    restoredProcessedStream = processed.stream
    restoredProcessorStop = processed.stop
  } catch (err) {
    // A live raw capture is still a better rollback than a silent producer if
    // the optional processing graph cannot be rebuilt.
    onError('processor restore', err)
  }

  if (!isCurrent()) {
    stopCandidate(restoredStream, restoredProcessedStream, restoredProcessorStop)
    cleanupCandidate()
    return false
  }

  const restoredTracks = restoredProcessedStream.getTracks()
  if (restoredTracks.length !== audioProducers.length) {
    onError(
      'track-count restore',
      new Error(
        `Expected ${audioProducers.length} restored microphone tracks, got ${restoredTracks.length}`
      )
    )
    stopCandidate(restoredStream, restoredProcessedStream, restoredProcessorStop)
    stopPreviousGraph()
    cleanupCandidate()
    return false
  }

  let restoredTrackCount = 0
  let restoreError = null
  for (let index = 0; index < audioProducers.length; index++) {
    const producer = audioProducers[index]
    const track = restoredTracks[index]
    if (!track || track.readyState === 'ended' || producer.closed) continue

    try {
      const oldTrack = producer.track
      await producer.replaceTrack({ track })
      oldTrack?.stop()
      if (micMuted) producer.pause()
      else producer.resume()
      restoredTrackCount++
    } catch (err) {
      restoreError = err
      break
    }
  }

  if (restoreError) onError('track restore', restoreError)
  if (restoredTrackCount === 0) {
    stopCandidate(restoredStream, restoredProcessedStream, restoredProcessorStop)
    stopPreviousGraph()
    cleanupCandidate()
    return false
  }

  // A partial multi-track restore is still preferable to retaining an ended
  // track. The normal microphone path has one track, but committing the graph
  // here also keeps bookkeeping honest if a device exposes more than one.
  onCommit({
    stream: restoredStream,
    processedStream: restoredProcessedStream,
    processorStop: restoredProcessorStop,
    previousStop,
    micSettings,
    onStream
  })
  cleanupCandidate()
  return true
}
