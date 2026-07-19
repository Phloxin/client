// ─── Local UI feedback & notification sounds ─────────────────────
// Short blips played locally, independent of the voice pipeline's master volume
// in soup.js. They DO follow the user's chosen output device (see
// setSoundOutputDevice below) so they come out the same speakers/headset as
// everything else. Two classes with different deafen behaviour:
//   • Direct UI feedback for the local user's own actions (toggling mic/sound
//     mute in the sidebar). These stay audible even while "sound muted"
//     (deafened) — they're feedback for the very action being taken, not remote
//     activity, so the deafen toggle's own blip must still be heard.
//   • Notifications about other activity (incoming message, channel join/leave,
//     stream started/stopped). Deafening means "I don't want to hear anything",
//     so these are silenced while deafened (see DEAF_MUTED_CATEGORIES / the
//     deafened flag mirrored in from the sidebar via setSoundsDeafened).
import muteSound from '../assets/soundpack/mute.mp3'
import unmuteSound from '../assets/soundpack/unmute.mp3'
import channelJoinSound from '../assets/soundpack/channel-join.mp3'
import channelLeaveSound from '../assets/soundpack/channel-leave.mp3'
import streamStartSound from '../assets/soundpack/stream-start.mp3'
import streamStopSound from '../assets/soundpack/stream-stop.mp3'
import newMessageSound from '../assets/soundpack/new-message.mp3'

// Each playable sound event maps to its audio file. Several events can share a
// file: the mic and sound mute buttons play the same blip but are toggled by
// separate settings categories, so they get distinct event names.
const SOUND_FILES = {
  'mic-mute': muteSound,
  'mic-unmute': unmuteSound,
  'sound-mute': muteSound,
  'sound-unmute': unmuteSound,
  'new-message': newMessageSound,
  'channel-join': channelJoinSound,
  'channel-leave': channelLeaveSound,
  'stream-start': streamStartSound,
  'stream-stop': streamStopSound
}

// User-facing on/off categories, each grouping the events it controls. This is
// the single source of truth for the Settings → Sounds toggles: add a soundpack
// entry here (and to SOUND_FILES) and it shows up there automatically. Order is
// the order rendered in Settings.
export const SOUND_CATEGORIES = [
  { id: 'micMute', label: 'Mute / Unmute Mic', events: ['mic-mute', 'mic-unmute'] },
  { id: 'soundMute', label: 'Mute / Unmute Sound', events: ['sound-mute', 'sound-unmute'] },
  { id: 'message', label: 'Incoming Message', events: ['new-message'] },
  { id: 'channel', label: 'Channel Join / Leave', events: ['channel-join', 'channel-leave'] },
  { id: 'stream', label: 'Stream Started / Stopped', events: ['stream-start', 'stream-stop'] }
]

// Reverse index: event name -> category id, for the enable check at play time.
const EVENT_CATEGORY = {}
for (const cat of SOUND_CATEGORIES) {
  for (const ev of cat.events) EVENT_CATEGORY[ev] = cat.id
}

// Categories silenced while the local user is deafened. These are notifications
// about other people's activity, so "sound muted" (deafen) should suppress them.
// The mic/sound-mute blips are intentionally absent: they're feedback for the
// user's own toggle and must stay audible even as deafen turns on.
const DEAF_MUTED_CATEGORIES = new Set(['message', 'channel', 'stream'])

// Whether the local user is currently deafened. Mirrored in from the sidebar
// (setSoundsDeafened) the same way category prefs and the output device are, so
// the non-React sounds module can gate notification playback without prop drilling.
let deafened = false

export function setSoundsDeafened(value) {
  deafened = !!value
}

// Per-category enable flags. Everything is on until the settings layer pushes the
// user's saved preferences in via setSoundCategoriesEnabled (see SettingsContext,
// which mirrors persisted prefs into this module the same way it pushes output
// device/volume into soup.js).
let enabledCategories = {}
SOUND_CATEGORIES.forEach((c) => {
  enabledCategories[c.id] = true
})

export function setSoundCategoriesEnabled(map) {
  enabledCategories = { ...enabledCategories, ...map }
}

// One reusable Audio element per event so rapid toggles restart the clip from
// the top instead of layering overlapping playbacks (and so the file is only
// fetched/decoded once).
const cache = {}

// Current output-device sink id for these sounds. Mirrored in from SettingsContext
// the same way soup.js's playback context gets it, so UI/notification sounds follow
// the user's chosen output device instead of always hitting the system default.
// HTMLMediaElement.setSinkId takes the literal 'default' for the default device
// (unlike AudioContext, which wants '' — see applyOutputDeviceToContext in soup.js).
let outputSinkId = 'default'

// Route a single Audio element to the current output device. No-op when the
// element is already on that sink (the common case, so repeat plays aren't
// delayed) or when setSinkId is unsupported. Resolves once routing is applied.
function applySink(el) {
  if (typeof el.setSinkId !== 'function' || el.sinkId === outputSinkId) {
    return Promise.resolve()
  }
  return el.setSinkId(outputSinkId).catch((err) => {
    console.error('[sounds] setSinkId failed:', err)
  })
}

// Push the user's chosen output device into this module. Re-routes any already
// created (cached) elements so a device change takes effect immediately, not
// just for sounds played for the first time afterward.
export function setSoundOutputDevice(deviceId) {
  outputSinkId = deviceId || 'default'
  for (const el of Object.values(cache)) applySink(el)
}

// Play a named sound event. `volume` is 0..1. Skips playback when the event's
// category is disabled. Playback rejections (e.g. autoplay policy before the
// first user gesture) are swallowed — these are non-critical.
// `force` bypasses the per-category enable check — used by the Settings preview
// buttons so a sound can be auditioned even while its category is toggled off.
export function playUiSound(name, volume = 0.5, force = false) {
  const src = SOUND_FILES[name]
  if (!src) return
  const category = EVENT_CATEGORY[name]
  if (!force && category && enabledCategories[category] === false) return
  // Notification sounds go silent while deafened; the user's own mute-toggle
  // blips still play. `force` (Settings preview) bypasses this too.
  if (!force && deafened && DEAF_MUTED_CATEGORIES.has(category)) return
  let el = cache[name]
  if (!el) {
    el = new Audio(src)
    cache[name] = el
  }
  el.volume = volume
  el.currentTime = 0
  // Route to the chosen output device before playing. setSinkId is async, so
  // start playback once routing is applied — otherwise the very first play of a
  // freshly created element would briefly leak out the default device. applySink
  // resolves synchronously-fast when the sink is already correct, so this doesn't
  // add latency to repeat plays.
  applySink(el).then(() => {
    el.play().catch(() => {})
  })
}
