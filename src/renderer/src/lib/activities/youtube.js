// The YouTube embed the shell drives for a bundle with the `player` capability, spoken to over
// the embed's own postMessage protocol: `listening` until it answers, then `command` messages. What comes back
// (`initialDelivery`, `infoDelivery`, `onStateChange`, `onError`) is folded into the bridge's
// `status` and `error`. Pure.

export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com'

const EMBED_PARAMS =
  'enablejsapi=1&controls=0&disablekb=1&fs=0&rel=0&iv_load_policy=3&playsinline=1'
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

export const isVideoId = (id) => typeof id === 'string' && VIDEO_ID.test(id)

export const embedUrl = (videoId) => `${EMBED_ORIGIN}/embed/${videoId}?${EMBED_PARAMS}`

export const listeningMessage = () =>
  JSON.stringify({ event: 'listening', id: 1, channel: 'widget' })

export const commandMessage = (func, args = []) =>
  JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' })

// The embed reports state changes and errors only to a listener it has been asked for.
export const SUBSCRIBE = ['onStateChange', 'onError'].map((name) =>
  commandMessage('addEventListener', [name])
)

// The embed commands for a checked `player` op (bridge.js readUiMessage). `place` and
// `describe` are not the embed's business and give none.
export function commandsFor(op) {
  switch (op.op) {
    case 'load': {
      const at = { videoId: op.videoId, startSeconds: op.startMs / 1000 }
      return [commandMessage(op.play ? 'loadVideoById' : 'cueVideoById', [at])]
    }
    case 'play':
      return [commandMessage('playVideo')]
    case 'pause':
      return [commandMessage('pauseVideo')]
    case 'seek':
      return [commandMessage('seekTo', [op.positionMs / 1000, true])]
    case 'unload':
      return [commandMessage('stopVideo')]
    case 'volume':
      return [
        commandMessage('setVolume', [Math.round(op.volume)]),
        commandMessage(op.muted ? 'mute' : 'unMute')
      ]
    case 'rate':
      return [commandMessage('setPlaybackRate', [op.rate / 100])]
    default:
      return []
  }
}

// A message from the embed as { event, info }, or null when it is not one.
export function readEmbedMessage(data) {
  if (typeof data !== 'string') return null
  let m
  try {
    m = JSON.parse(data)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object' || typeof m.event !== 'string') return null
  return { event: m.event, info: m.info }
}

const STATES = new Map([
  [0, 'ended'],
  [1, 'playing'],
  [2, 'paused'],
  [3, 'buffering'],
  [5, 'cued']
])

// What the surface knows: `loaded` (a video was asked for and not unloaded since), `fresh`
// (the embed has reported the new video's start, its `-1`, since the last load: until then what
// it says is about the old one) and the embed's info, merged.
export const initialPlayer = () => ({ ready: false, loaded: false, fresh: false, info: {} })

// An error is reported once: the next message about the player clears it.
function withoutError(player) {
  const rest = { ...player }
  delete rest.error
  return rest
}

// After a load, unload or the embed's message. Returns the next state, plus `error` when the
// embed reported one.
export function nextPlayer(player, event) {
  switch (event.type) {
    case 'load':
    case 'unload': {
      return { ...withoutError(player), loaded: event.type === 'load', fresh: false }
    }
    case 'embed': {
      const { event: name, info } = event.message
      if (name === 'onReady') return { ...player, ready: true }
      if (name === 'onError') return { ...player, error: Number(info) }
      if (name === 'onStateChange' || name === 'infoDelivery' || name === 'initialDelivery') {
        const merged =
          name === 'onStateChange'
            ? { ...player.info, playerState: Number(info) }
            : { ...player.info, ...(info && typeof info === 'object' ? info : {}) }
        const fresh = player.fresh || (player.loaded && merged.playerState === -1)
        return { ...withoutError(player), info: merged, fresh }
      }
      return player
    }
    default:
      return player
  }
}

// The bridge's `status` for the surface's state: { state, positionMs, durationMs, title, rate }.
export function statusOf(player) {
  const info = player.info
  let state
  if (!player.loaded) state = 'idle'
  else if (!player.fresh || info.playerState === -1) state = 'loading'
  else state = STATES.get(info.playerState) ?? 'loading'
  const seconds = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : 0)
  const rate = Number.isFinite(info.playbackRate) ? Math.round(info.playbackRate * 100) : 100
  return {
    state,
    positionMs: player.loaded ? seconds(info.currentTime) : 0,
    durationMs: player.loaded && player.fresh ? seconds(info.duration) : 0,
    title: (player.loaded && player.fresh && info.videoData?.title) || null,
    rate
  }
}

// The oEmbed request for a video, and what its answer means.
export const oembedUrl = (videoId) =>
  `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`

// What an oEmbed answer means for a video: `status` is the HTTP status,
// null when the request failed or timed out, and `body` the parsed JSON of a 200. Any 4xx is a
// video that cannot be played here; a 5xx or a failure is taken as playable, with no title.
export function describedFrom(status, body) {
  if (status === 200) {
    const title = typeof body?.title === 'string' && body.title ? body.title : null
    return { title, playable: true }
  }
  if (status >= 400 && status < 500) return { title: null, playable: false }
  return { title: null, playable: true }
}
