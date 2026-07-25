// The voice transport is mono regardless of the capture device's native layout.
// Keep creation/configuration of the mandatory graph endpoints together so the
// raw-stream passthrough that caused one-sided playback cannot accidentally
// return when optional processing is disabled.
export function createMonoVoiceGraph(audioContext, stream) {
  const source = audioContext.createMediaStreamSource(stream)

  // Fold before RNNoise/the gate. With speaker interpretation, a duplicated
  // stereo mic becomes 0.5 * (L + R): full-level mono, with both input channels
  // presented to every downstream processor.
  const input = audioContext.createGain()
  input.channelCount = 1
  input.channelCountMode = 'explicit'
  input.channelInterpretation = 'speakers'
  source.connect(input)

  // Chromium's MediaStreamAudioDestinationNode defaults to stereo. Match the
  // mono signal and the Opus profile used for voice explicitly.
  const destination = audioContext.createMediaStreamDestination()
  destination.channelCount = 1
  destination.channelCountMode = 'explicit'

  return { source, input, destination }
}
