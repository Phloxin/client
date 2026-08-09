// The voice transport is mono regardless of the capture device's native layout.
// Keep creation/configuration of the mandatory graph endpoints together so the
// raw-stream passthrough that caused one-sided playback cannot accidentally
// return when optional processing is disabled.
//
// Hi-Fi Voice is the one exception: it publishes stereo (which is what makes
// libwebrtc select Opus' music mode), so it asks for a 2-channel graph instead.
export function createVoiceGraph(audioContext, stream, { stereo = false } = {}) {
  const channels = stereo ? 2 : 1
  const source = audioContext.createMediaStreamSource(stream)

  // Fold before RNNoise/the gate. With speaker interpretation, a duplicated
  // stereo mic becomes 0.5 * (L + R): full-level mono, with both input channels
  // presented to every downstream processor. In stereo mode the same explicit
  // pinning keeps a stereo device's two channels intact end to end (and spreads
  // a mono device across both) instead of leaving the layout to node defaults.
  const input = audioContext.createGain()
  input.channelCount = channels
  input.channelCountMode = 'explicit'
  input.channelInterpretation = 'speakers'
  source.connect(input)

  // Chromium's MediaStreamAudioDestinationNode defaults to stereo. Match the
  // signal and the Opus profile used for voice explicitly.
  const destination = audioContext.createMediaStreamDestination()
  destination.channelCount = channels
  destination.channelCountMode = 'explicit'

  return { source, input, destination }
}

// Mono voice graph — the default for every profile except Hi-Fi Voice.
export function createMonoVoiceGraph(audioContext, stream) {
  return createVoiceGraph(audioContext, stream, { stereo: false })
}
