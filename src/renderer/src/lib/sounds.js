// ─── Local UI feedback sounds ────────────────────────────────────
// Short blips played for the current user in response to their own actions
// (e.g. toggling mic/sound mute in the sidebar). These are deliberately
// independent of the voice pipeline's master volume and output-device routing
// in soup.js: they're direct UI feedback for the local user, not remote audio,
// so they should still be heard even while "sound muted" (deafened).
import muteSound from '../assets/soundpack/mute.mp3'
import unmuteSound from '../assets/soundpack/unmute.mp3'
import channelJoinSound from '../assets/soundpack/channel-join.mp3'
import channelLeaveSound from '../assets/soundpack/channel-leave.mp3'
import streamStartSound from '../assets/soundpack/stream-start.mp3'
import streamStopSound from '../assets/soundpack/stream-stop.mp3'
import newMessageSound from '../assets/soundpack/new-message.mp3'

const SOUNDS = {
  mute: muteSound,
  unmute: unmuteSound,
  'channel-join': channelJoinSound,
  'channel-leave': channelLeaveSound,
  'stream-start': streamStartSound,
  'stream-stop': streamStopSound,
  'new-message': newMessageSound
}

// One reusable Audio element per sound so rapid toggles restart the clip from
// the top instead of layering overlapping playbacks (and so the file is only
// fetched/decoded once).
const cache = {}

// Play a named UI sound. `volume` is 0..1. Playback rejections (e.g. autoplay
// policy before the first user gesture) are swallowed — these are non-critical.
export function playUiSound(name, volume = 0.5) {
  const src = SOUNDS[name]
  if (!src) return
  let el = cache[name]
  if (!el) {
    el = new Audio(src)
    cache[name] = el
  }
  el.volume = volume
  el.currentTime = 0
  el.play().catch(() => {})
}
