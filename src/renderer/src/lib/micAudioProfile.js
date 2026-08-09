// Voice codec policy shared by initial publish and republish. This module stays
// browser-independent so the published-track/channel contract is unit-testable.
//
// `stereo` and `voiceDsp` describe what the *capture* side has to do for the
// profile to mean anything: libwebrtc only selects Opus' music mode
// (OPUS_APPLICATION_AUDIO) for a stereo track, and the browser's voice DSP
// (AEC / NS / AGC) is speech-tuned, so hi-fi turns it off.

// Opus ceiling for content that is music rather than speech. Shared by the
// hi-fi mic profile and by screen-share audio (captured app/system audio is
// exactly the same case), so the two can't silently drift apart.
export const MUSIC_AUDIO_BITRATE = 128_000

const MIC_AUDIO_PROFILES = {
  speech: {
    name: 'speech',
    maxBitrate: 96_000,
    maxPlaybackRate: 48_000,
    dtx: true,
    fec: true,
    nack: true,
    ptime: 20,
    stereo: false,
    voiceDsp: true
  },
  hifi: {
    name: 'hifi',
    // TeamSpeak "Opus Music" parity: 128 kbps stereo fullband, no DTX.
    maxBitrate: MUSIC_AUDIO_BITRATE,
    maxPlaybackRate: 48_000,
    dtx: false,
    fec: true,
    nack: true,
    ptime: 20,
    stereo: true,
    voiceDsp: false
  }
}

function selectedMicAudioProfile(micSettings) {
  return micSettings?.hifiVoice === true ? MIC_AUDIO_PROFILES.hifi : MIC_AUDIO_PROFILES.speech
}

// Should the capture + processing graph stay stereo for these settings? Drives
// getUserMedia's channelCount and the voice graph's mono fold.
export function micProfileWantsStereo(micSettings) {
  return selectedMicAudioProfile(micSettings).stereo === true
}

// Whether the browser's speech-tuned DSP may run for these settings. Hi-fi
// disables it wholesale; every other profile keeps the user's own toggles.
export function micProfileAllowsVoiceDsp(micSettings) {
  return selectedMicAudioProfile(micSettings).voiceDsp !== false
}

// The getUserMedia audio constraints these settings ask for. Chromium binds its
// audio processing (AGC / noise suppression / echo cancellation) to the shared
// capture source for a device rather than to the individual track, so this is
// also the definition of "a different capture": two settings objects with equal
// constraints can share one open capture, and two that differ cannot (see
// acquireMicCapture in soup.js for the release-then-reopen dance that implies).
export function micConstraints(micSettings) {
  // Hi-Fi Voice captures stereo with every speech-tuned processor off: the
  // browser DSP collapses the stereo image and pumps music, and stereo is what
  // makes libwebrtc encode Opus in music mode rather than speech mode.
  const stereo = micProfileWantsStereo(micSettings)
  const allowVoiceDsp = micProfileAllowsVoiceDsp(micSettings)

  return {
    deviceId:
      micSettings.deviceId && micSettings.deviceId !== 'default'
        ? { exact: micSettings.deviceId }
        : undefined,
    echoCancellation: allowVoiceDsp ? micSettings.echoCancellation : false,
    // RNNoise replaces the browser suppressor - never run both (they're
    // mutually exclusive in the UI; this guards against any stale state).
    noiseSuppression:
      allowVoiceDsp && !micSettings.useRnnoise ? micSettings.noiseSuppression : false,
    autoGainControl: allowVoiceDsp ? micSettings.autoGainControl : false,
    sampleRate: micSettings.sampleRate,
    channelCount: stereo ? 2 : micSettings.channelCount
  }
}

// Does the local processing chain RNNoise-denoise for these settings? The
// worklet is a mono, speech-trained denoiser, so a stereo profile skips it even
// when the user has it enabled.
export function micProfileUsesRnnoise(micSettings) {
  return micSettings?.useRnnoise === true && !micProfileWantsStereo(micSettings)
}

export function buildMicOpusOptions(micSettings) {
  const profile = selectedMicAudioProfile(micSettings)
  const resolvedChannelCount = Number(
    micSettings?.resolvedChannelCount ?? micSettings?.channelCount ?? 1
  )

  return {
    encodings: [{ maxBitrate: profile.maxBitrate }],
    codecOptions: {
      // A stereo profile asserts stereo even if the track never reported a
      // channel count — dropping to mono there would silently fall back to
      // Opus' speech mode, which is the whole thing the profile exists to avoid.
      opusStereo: profile.stereo === true || resolvedChannelCount === 2,
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
    resolvedChannelCount = micProfileWantsStereo(micSettings) ? 2 : (micSettings?.channelCount ?? 1)
  }
  return { ...micSettings, resolvedChannelCount }
}

export function micAudioProfileKey(micSettings, opusOptions) {
  return `${selectedMicAudioProfile(micSettings).name}:${opusOptions.codecOptions.opusStereo}`
}
