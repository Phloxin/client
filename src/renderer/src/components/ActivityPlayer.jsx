/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import {
  EMBED_ORIGIN,
  SUBSCRIBE,
  captionCommands,
  captionsShowing,
  commandsFor,
  describedFrom,
  embedUrl,
  initialPlayer,
  listeningMessage,
  nextPlayer,
  oembedUrl,
  readEmbedMessage,
  statusOf
} from '../lib/activities/youtube'
import './ActivityPlayer.css'

// The viewer's own volume and mute, for every player.
const VOLUME_KEY = 'activities.player.volume'
// The viewer's own subtitles choice, for every player.
const CAPTIONS_KEY = 'activities.player.captions'
const DESCRIBE_TIMEOUT_MS = 5000
// At most this often while only the position moves.
const STATUS_GAP_MS = 250
const LISTEN_EVERY_MS = 250

function readVolume() {
  try {
    const saved = JSON.parse(localStorage.getItem(VOLUME_KEY))
    if (Number.isFinite(saved?.volume) && saved.volume >= 0 && saved.volume <= 100) {
      return { volume: saved.volume, muted: saved.muted === true }
    }
  } catch {
    // Unreadable or blocked: the default.
  }
  return { volume: 100, muted: false }
}

function saveVolume(value) {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify(value))
  } catch {
    // Not kept; it still applies to this player.
  }
}

// Off unless the viewer turned them on.
function readCaptions() {
  try {
    return JSON.parse(localStorage.getItem(CAPTIONS_KEY))?.on === true
  } catch {
    return false
  }
}

function saveCaptions(on) {
  try {
    localStorage.setItem(CAPTIONS_KEY, JSON.stringify({ on }))
  } catch {
    // Not kept; it still applies to this player.
  }
}

// Looks a video up through oEmbed for its title and whether it can be embedded.
async function describe(videoId) {
  try {
    const res = await fetch(oembedUrl(videoId), {
      signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)
    })
    const body = res.ok ? await res.json().catch(() => null) : null
    return describedFrom(res.status, body)
  } catch {
    return describedFrom(null, null)
  }
}

// The surface's workings, outside React: the embed's state, the commands waiting for it to be
// ready, the viewer's volume and subtitles, and the `status` throttle. The component connects
// its view: frame() for the embed's window, mount(videoId) for a new embed element, place(rect)
// and emit(event).
function createSurface() {
  let view = {
    frame: () => null,
    mount: () => {},
    place: () => {},
    emit: () => {},
    audible: () => {}
  }
  let audible = false
  let player = initialPlayer()
  let mounted = false
  // The video the last load asked for.
  let loadedVideo = null
  let waiting = []
  let volume = readVolume()
  let captions = readCaptions()
  const sent = { key: null, at: 0, timer: null }

  const send = (messages) => {
    if (!player.ready) {
      waiting.push(...messages)
      return
    }
    for (const m of messages) view.frame()?.postMessage(m, EMBED_ORIGIN)
  }
  const volumeCommands = () => commandsFor({ op: 'volume', ...volume })
  const showCaptions = () => send(captionCommands(player, captions, navigator.language))
  // Playing with sound, for the tab's speaker; told when it changes.
  const tellAudible = () => {
    const now = statusOf(player).state === 'playing' && !volume.muted && volume.volume > 0
    if (now === audible) return
    audible = now
    view.audible(now)
  }

  // `status` on every change, and while only the position moves at most every 250 ms.
  const emitStatus = () => {
    const status = statusOf(player)
    const key = JSON.stringify({ ...status, positionMs: null })
    clearTimeout(sent.timer)
    const wait = STATUS_GAP_MS - (Date.now() - sent.at)
    if (key === sent.key && wait > 0) {
      sent.timer = setTimeout(emitStatus, wait)
      return
    }
    sent.key = key
    sent.at = Date.now()
    view.emit({ event: 'status', ...status })
    tellAudible()
  }

  const update = (event) => {
    const before = player
    player = nextPlayer(before, event)
    if (!before.ready && player.ready) {
      const queued = waiting
      waiting = []
      send([...SUBSCRIBE, ...volumeCommands(), ...queued])
    }
    if (player.error != null && player.error !== before.error) {
      view.emit({ event: 'error', code: player.error })
    }
    // The embed can turn subtitles on with each video it loads; the viewer's choice stands.
    if (
      event.type === 'embed' &&
      event.message.event === 'apiInfoDelivery' &&
      player.loaded &&
      captionsShowing(player) !== captions
    ) {
      showCaptions()
    }
    emitStatus()
  }

  const unload = () => {
    if (player.loaded) send(commandsFor({ op: 'unload' }))
    update({ type: 'unload' })
  }

  return {
    connect(next) {
      view = next
    },
    command(op) {
      switch (op.op) {
        case 'place':
          view.place(op.rect)
          return
        case 'describe':
          describe(op.videoId).then((d) => view.emit({ event: 'described', id: op.id, ...d }))
          return
        case 'volume':
          volume = { volume: op.volume, muted: op.muted }
          tellAudible()
          saveVolume(volume)
          send(commandsFor(op))
          return
        case 'captions':
          captions = op.on
          saveCaptions(captions)
          if (player.loaded) showCaptions()
          return
        case 'load': {
          // A load of the video already loaded is a reload, and gets a new embed
          // element; the command waits for that embed to be ready.
          const again = player.loaded && loadedVideo === op.videoId
          loadedVideo = op.videoId
          if (again || !mounted) {
            mounted = true
            player = initialPlayer()
            waiting = []
            view.mount(op.videoId)
          }
          update({ type: 'load' })
          send([...commandsFor(op), ...volumeCommands()])
          return
        }
        case 'unload':
          unload()
          return
        default:
          if (player.loaded) send(commandsFor(op))
      }
    },
    readyEvent: () => ({ event: 'ready', ...volume, captions }),
    // A new bundle instance starts from an empty screen.
    reset() {
      view.place(null)
      unload()
    },
    unload,
    // The embed's messages, already checked to be from its frame and origin.
    message: (message) => update({ type: 'embed', message }),
    // A new embed document: nothing it was told before stands.
    embedLoaded() {
      if (!player.ready) return
      player = { ...player, ready: false }
    },
    dispose: () => clearTimeout(sent.timer)
  }
}

// The surface a bundle with the `player` capability drives: one YouTube embed, placed at the bundle's rect under the
// bundle's frame, taking no input of its own. `ref` gets { command(op), readyEvent(), reset() };
// `onEvent` gets the shell-to-bundle `player` events, `onAudible(bool)` whether it plays with sound.
// `active` false (the room is over) unloads and hides it.
function ActivityPlayer({ ref, active, onEvent, onAudible }) {
  const frameRef = useRef(null)
  // The embed element's video and a count that gives each new element its own key.
  const [embed, setEmbed] = useState(null)
  // The last rect placed, kept while hidden so the embed keeps its size.
  const [rect, setRect] = useState(null)
  const [placed, setPlaced] = useState(false)
  const [surface] = useState(createSurface)

  // Before the parent's bridge effect, so the surface is wired when the bundle first speaks.
  useLayoutEffect(() => {
    surface.connect({
      frame: () => frameRef.current?.contentWindow ?? null,
      mount: (id) => setEmbed((e) => ({ videoId: id, n: (e?.n ?? 0) + 1 })),
      place: (r) => {
        if (r) setRect(r)
        setPlaced(!!r)
      },
      emit: (event) => onEvent?.(event),
      audible: (on) => onAudible?.(on)
    })
  })

  useImperativeHandle(ref, () => surface, [surface])

  // Unloaded once the room is over (and hidden, below).
  useEffect(() => {
    if (!active) surface.unload()
  }, [active, surface])

  useEffect(() => () => surface.dispose(), [surface])

  // The embed's messages, from that frame and its origin only; `listening` until it answers.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let listen = null
    const stopListening = () => {
      clearInterval(listen)
      listen = null
    }
    const onLoad = () => {
      stopListening()
      surface.embedLoaded()
      const post = () => frame.contentWindow?.postMessage(listeningMessage(), EMBED_ORIGIN)
      post()
      listen = setInterval(post, LISTEN_EVERY_MS)
    }
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow || e.origin !== EMBED_ORIGIN) return
      const message = readEmbedMessage(e.data)
      if (!message) return
      stopListening()
      surface.message(message)
    }
    frame.addEventListener('load', onLoad)
    window.addEventListener('message', onMessage)
    return () => {
      stopListening()
      frame.removeEventListener('load', onLoad)
      window.removeEventListener('message', onMessage)
    }
  }, [embed, surface])

  const style = rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : {}
  if (!(active && placed && rect)) style.visibility = 'hidden'
  return (
    <div className="activity-player" style={style} inert aria-hidden="true">
      {embed && (
        <iframe key={embed.n} ref={frameRef} src={embedUrl(embed.videoId)} title="" tabIndex={-1} />
      )}
    </div>
  )
}

export default ActivityPlayer
