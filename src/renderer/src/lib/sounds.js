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
//     so these are silenced while deafened — unless the user pinned the sound
//     (see soundState below / the deafened flag mirrored in from the sidebar via
//     setSoundsDeafened).

// Every soundpack is a folder under assets/soundpacks/. Auto-import all their
// files so adding a pack (or a file to one) needs no code change here. Each pack
// maps a sound id (the filename without extension) to its asset. Packs share one
// filename vocabulary (the TeamSpeak set), so a given id resolves in whichever
// pack is active.
const packAssets = import.meta.glob('../assets/soundpacks/*/*.{mp3,wav}', {
  eager: true,
  import: 'default'
})

// packId -> { soundId -> { url, filename } }
const SOUNDPACKS = {}
for (const [path, url] of Object.entries(packAssets)) {
  const m = /\/soundpacks\/([^/]+)\/(.+)\.(?:mp3|wav)$/.exec(path)
  if (!m) continue
  const [, pack, id] = m
  ;(SOUNDPACKS[pack] ||= {})[id] = { url, filename: path.slice(path.lastIndexOf('/') + 1) }
}

// Friendly names for the Settings picker; unknown packs fall back to their id.
const PACK_LABELS = { default: 'Default', tts: 'TeamSpeak TTS' }
export const SOUNDPACK_OPTIONS = Object.keys(SOUNDPACKS)
  .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
  .map((id) => ({ id, label: PACK_LABELS[id] || id }))

// Which pack playUiSound resolves files from. Mirrored in from SettingsContext
// (setActiveSoundpack) like the other prefs below.
let activePack = 'default'

export function setActiveSoundpack(id) {
  if (SOUNDPACKS[id]) activePack = id
}

// Settings → Notifications layout: sounds grouped into sections, each rendered
// with a master toggle plus a preview + per-sound tri-state. Each sound has a
// readable `label` (the filename is still shown as a tooltip). A section only
// shows the sounds the active pack actually contains, so the list follows the
// selected pack.
// ponytail: grouping and labels are best-guess from the TeamSpeak sound names —
// reorder / retitle freely, nothing keys off this order.
export const SOUND_SECTIONS = [
  {
    id: 'connections',
    label: 'Connections',
    sounds: [
      { id: 'connected', label: 'You connected to a server' },
      { id: 'disconnected', label: 'You disconnected from a server' },
      { id: 'connection_lost', label: 'You lost connection to a server' },
      { id: 'neutral_connection_connectionlost_currentchannel', label: 'Someone lost connection in your channel' }
    ]
  },
  {
    id: 'messaging',
    label: 'Messaging',
    sounds: [
      { id: 'chat_message_inbound', label: 'You received a message' },
      { id: 'chat_message_outbound', label: 'You sent a message' }
    ]
  },
  {
    id: 'channel',
    label: 'Channel Switching',
    sounds: [
      { id: 'channel_switched', label: 'You moved to another channel' },
      { id: 'neutral_switched_tocurrentchannel', label: 'Someone joined your channel' },
      { id: 'neutral_switched_awayfromcurrentchannel', label: 'Someone has left your channel' },
      { id: 'neutral_moved_tocurrentchannel', label: 'Someone was moved to your channel' },
      { id: 'neutral_moved_awayfromcurrentchannel', label: 'Someone was moved out of your channel' },
      { id: 'you_were_moved', label: 'You were moved to another channel' }
    ]
  },
  {
    id: 'status',
    label: 'Status',
    sounds: [
      { id: 'mic_muted', label: 'Microphone muted', default: 'pin' },
      { id: 'mic_activated', label: 'Microphone unmuted', default: 'pin' },
      { id: 'sound_muted', label: 'Sound muted / deafened', default: 'pin' },
      { id: 'sound_resumed', label: 'Sound unmuted / undeafened', default: 'pin' },
      { id: 'away_activated', label: 'Mark self as away' },
      { id: 'away_deactivated', label: 'Unmark self as away' },
      { id: 'servergroup_assigned', label: 'Server group assigned' },
      { id: 'servergroup_revoked', label: 'Server group revoked' }
    ]
  },
  {
    id: 'moderation',
    label: 'Moderation',
    sounds: [
      { id: 'you_kicked_channel', label: 'You were kicked from a channel' },
      { id: 'you_kicked_server', label: 'You were kicked from the server' },
      { id: 'neutral_kicked_channel_awayfromcurrentchannel', label: 'Someone was kicked from your channel' },
      { id: 'neutral_kicked_server_currentchannel', label: 'Someone was kicked from the server' },
      { id: 'you_were_banned', label: 'You were banned' },
      { id: 'neutral_banned_server_currentchannel', label: 'Someone was banned from the server' },
      { id: 'you_were_gagged', label: 'You were gagged' },
      { id: 'you_were_ungagged', label: 'You were ungagged' },
      { id: 'insufficient_permissions', label: 'Insufficient permissions' }
    ]
  },
  {
    id: 'settings',
    label: 'Settings',
    sounds: [
      { id: 'channel_created', label: 'Channel created' },
      { id: 'channel_deleted', label: 'Channel deleted' },
      { id: 'channel_edited', label: 'Channel edited' },
      { id: 'channel_moved', label: 'Channel moved' },
      { id: 'your_channel_was_edited', label: 'Current channel was edited' }
    ]
  },
  {
    id: 'whisper',
    label: 'Whisper',
    sounds: [{ id: 'you_were_poked', label: 'Someone poked you' }]
  },
  {
    id: 'stream',
    label: 'Stream Events',
    sounds: [
      { id: 'stream_started', label: 'Stream started' },
      { id: 'stream_stopped', label: 'Stream stopped' }
    ]
  },
  {
    id: 'warnings',
    label: 'Warnings',
    sounds: [{ id: 'error', label: 'An error occurred' }]
  }
]

// Default state per sound id (from the `default` field above); absent = 'on'.
// Used wherever a sound's state is resolved, so a sound the user hasn't touched
// still honours its intended default.
export const SOUND_DEFAULTS = {}
for (const section of SOUND_SECTIONS) {
  for (const s of section.sounds) if (s.default) SOUND_DEFAULTS[s.id] = s.default
}

// The app fires playback by these event names (Main.jsx / SideBar.jsx); each maps
// to a sound id resolved in the active pack. Sounds not listed here have no
// trigger wired yet — they still preview/toggle in Settings.
const EVENT_SOUND = {
  'mic-mute': 'mic_muted',
  'mic-unmute': 'mic_activated',
  'sound-mute': 'sound_muted',
  'sound-unmute': 'sound_resumed',
  'new-message': 'chat_message_inbound',
  'channel-join': 'neutral_switched_tocurrentchannel',
  'channel-leave': 'neutral_switched_awayfromcurrentchannel',
  'stream-start': 'stream_started',
  'stream-stop': 'stream_stopped'
}

// Sounds with no playback trigger wired yet — the events that would fire them
// aren't distinguishable server-side, so Settings flags them as "not wired".
// Remove an id from here the moment its trigger is wired in Main/SideBar.
export const UNWIRED_SOUNDS = new Set([
  'neutral_connection_connectionlost_currentchannel',
  'neutral_moved_tocurrentchannel',
  'neutral_moved_awayfromcurrentchannel',
  'you_were_moved',
  'you_were_poked'
])

// Filename shown as a sound's title in Settings (null if the pack lacks it).
export function getSoundFilename(packId, soundId) {
  return SOUNDPACKS[packId]?.[soundId]?.filename || null
}

// Whether the local user is currently deafened. Mirrored in from the sidebar
// (setSoundsDeafened) the same way enable prefs and the output device are, so
// the non-React sounds module can gate notification playback without prop drilling.
let deafened = false

export function setSoundsDeafened(value) {
  deafened = !!value
}

// Per-sound state (sound id -> 'off' | 'on' | 'pin'). Absent = 'on' (default).
//   • 'off' — never plays.
//   • 'on'  — plays, but silenced while deafened ("sound muted").
//   • 'pin' — plays and bypasses deafen, so it's heard no matter what.
// The settings layer pushes the user's saved preferences in via setSoundStateMap
// (see SettingsContext), the same way it pushes output device/volume into soup.js.
let soundState = {}

export function setSoundStateMap(map) {
  soundState = { ...soundState, ...map }
}

// Playback volume (0..1) for all soundpack sounds, its own control separate from
// the voice master volume. Mirrored in from SettingsContext (setSoundVolume).
let notifVolume = 0.5

export function setSoundVolume(value) {
  notifVolume = Math.min(1, Math.max(0, value))
}

// One reusable Audio element per pack+sound so rapid toggles restart the clip
// from the top instead of layering overlapping playbacks (and so the file is
// only fetched/decoded once). Keyed by pack so switching packs doesn't replay a
// stale element pointing at the old pack's file.
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

// Play a sound. `name` is either a wired event name (translated via EVENT_SOUND)
// or a raw sound id (used by the Settings preview). `volume` overrides the user's
// notification volume when given (0..1); omit it to use the setting. Skips
// playback when the sound is toggled off. Playback rejections (e.g. autoplay
// policy before the first user gesture) are swallowed — these are non-critical.
// `force` bypasses the enable and deafen checks — used by the Settings preview
// so a sound can be auditioned even while toggled off or while deafened.
export function playUiSound(name, volume, force = false) {
  const soundId = EVENT_SOUND[name] || name
  const entry = SOUNDPACKS[activePack]?.[soundId]
  if (!entry) return
  const state = soundState[soundId] || SOUND_DEFAULTS[soundId] || 'on'
  if (!force && state === 'off') return
  // Non-pinned sounds go silent while deafened; pinned sounds always play.
  if (!force && deafened && state !== 'pin') return
  const key = `${activePack}:${soundId}`
  let el = cache[key]
  if (!el) {
    el = new Audio(entry.url)
    cache[key] = el
  }
  el.volume = volume ?? notifVolume
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
