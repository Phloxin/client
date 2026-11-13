// Which video codec a native screen share sends (soup/nativeShare.js), or none, in which case
// the share goes through Chromium. Kept apart from screenShare.js so it can be tested on its
// own. Plan: .plans/native-media-engine-av1-3-client.md, T1 to T3.
//   node --test src/renderer/src/lib/soup/nativeCodec.test.mjs

// The codecs the sidecar can send, by its protocol's names, and their mime types.
const NATIVE_CODEC_MIME = Object.freeze({ H264: 'video/h264', AV1: 'video/av1' })
// Every choice the picker or PREFER_SCREENSHARE_CODEC can express (screenShare.js,
// SCREEN_CODEC_MIME). The others are not native.
const SCREEN_CODECS = ['H264', 'AV1', 'VP9', 'VP8']

function screenCodecName(value) {
  const name = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return SCREEN_CODECS.includes(name) ? name : null
}

//   codecPref      the picker's 'auto', 'h264' or 'av1'
//   envCodec       PREFER_SCREENSHARE_CODEC as the preload gives it, or null
//   sidecarCodecs  hello.codecs of the sidecar, or null while no sidecar has said hello. Then
//                  the codec is asked for and the main process checks it at `open`
//   allowed(mime)  whether the channel takes video in that mime type
// Returns 'H264', 'AV1' or null. The picker's choice comes first, then the variable, as on
// Chromium's path. Neither (auto) is H264.
export function nativeShareCodec({
  codecPref = 'auto',
  envCodec = null,
  sidecarCodecs = null,
  allowed = () => true
} = {}) {
  const wanted = screenCodecName(codecPref) ?? screenCodecName(envCodec) ?? 'H264'
  const mime = NATIVE_CODEC_MIME[wanted]
  if (!mime || !allowed(mime)) return null
  if (Array.isArray(sidecarCodecs) && !sidecarCodecs.includes(wanted)) return null
  return wanted
}

// 'H264' or 'AV1' → its mime type, or null.
export function nativeCodecMime(codec) {
  return NATIVE_CODEC_MIME[codec] ?? null
}
