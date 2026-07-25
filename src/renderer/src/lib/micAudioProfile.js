// Voice codec policy shared by initial publish and republish. This module stays
// browser-independent so the published-track/channel contract is unit-testable.
const MIC_AUDIO_PROFILES = {
  speech: {
    name: 'speech',
    maxBitrate: 96_000,
    maxPlaybackRate: 48_000,
    dtx: true,
    fec: true,
    nack: true,
    ptime: 20
  },
  hifi: {
    name: 'hifi',
    maxBitrate: 192_000,
    maxPlaybackRate: 48_000,
    dtx: false,
    fec: true,
    nack: true,
    ptime: 20
  }
}

function selectedMicAudioProfile(micSettings) {
  return micSettings?.hifiVoice === true ? MIC_AUDIO_PROFILES.hifi : MIC_AUDIO_PROFILES.speech
}

export function buildMicOpusOptions(micSettings) {
  const profile = selectedMicAudioProfile(micSettings)
  const resolvedChannelCount = Number(
    micSettings?.resolvedChannelCount ?? micSettings?.channelCount ?? 1
  )

  return {
    encodings: [{ maxBitrate: profile.maxBitrate }],
    codecOptions: {
      opusStereo: resolvedChannelCount === 2,
      opusMaxPlaybackRate: profile.maxPlaybackRate,
      opusMaxAverageBitrate: profile.maxBitrate,
      opusDtx: profile.dtx,
      opusPtime: profile.ptime,
      opusFec: profile.fec,
      opusNack: profile.nack
    }
  }
}

// Resolve channel count from the stream that will actually be handed to
// mediasoup. In particular, callers must pass the processed voice stream rather
// than the raw capture, which may still report its native stereo layout.
export function micSettingsForPublishedStream(micSettings, publishedStream) {
  let resolvedChannelCount
  try {
    resolvedChannelCount = publishedStream?.getAudioTracks?.()[0]?.getSettings?.().channelCount
  } catch {
    // getSettings() is best-effort; the configured voice layout is the fallback.
  }
  if (!Number.isFinite(resolvedChannelCount) || resolvedChannelCount < 1) {
    resolvedChannelCount = micSettings?.channelCount ?? 1
  }
  return { ...micSettings, resolvedChannelCount }
}

export function micAudioProfileKey(micSettings, opusOptions) {
  return `${selectedMicAudioProfile(micSettings).name}:${opusOptions.codecOptions.opusStereo}`
}
