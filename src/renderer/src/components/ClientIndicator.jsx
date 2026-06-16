import { useState, useRef, useEffect } from 'react'
import {
  IconMicrophoneOff,
  IconHeadphonesOff,
  IconMicrophoneFilled,
  IconMicrophone,
  IconVolume,
  IconVolume2,
  IconVolume3,
  IconVolume4,
  IconVolumeOff
} from '@tabler/icons-react'
import { setClientAudioState, getClientAudioState } from '../lib/soup'

function ClientIndicator({ client, speaking, micMuted, deafened, isSelf }) {
  const initial = client.name?.charAt(0).toUpperCase() ?? '?'
  const [menuPos, setMenuPos] = useState(null)
  const menuRef = useRef(null)

  const initialAudioState = getClientAudioState(client.id)
  const [volume, setVolume] = useState(Math.round(initialAudioState.volume * 100))
  const [localMuted, setLocalMuted] = useState(initialAudioState.muted)

  // Apply this client's local volume/mute override whenever it changes
  useEffect(() => {
    if (isSelf) return
    setClientAudioState(client.id, { volume: volume / 100, muted: localMuted })
  }, [client.id, volume, localMuted, isSelf])

  // Close the context menu on outside click
  useEffect(() => {
    if (!menuPos) return
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuPos(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuPos])

  const handleContextMenu = (e) => {
    if (isSelf) return
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const toggleLocalMute = () => setLocalMuted((prev) => !prev)

  const handleVolumeChange = (e) => {
    const next = Number(e.target.value)
    setVolume(next)
    if (next > 0 && localMuted) setLocalMuted(false)
    if (next === 0 && !localMuted) setLocalMuted(true)
  }

  let statusIcon
  if (deafened) {
    statusIcon = <IconHeadphonesOff size={14} className="mic-indicator deafened" aria-label="Deafened" />
  } else if (micMuted) {
    statusIcon = <IconMicrophoneOff size={14} className="mic-indicator muted" aria-label="Muted" />
  } else if (speaking) {
    statusIcon = <IconMicrophoneFilled size={14} className="mic-indicator speaking" aria-label="Speaking" />
  } else {
    statusIcon = <IconMicrophone size={14} className="mic-indicator" aria-label="Not speaking" />
  }

  const VolumeIcon = localMuted || volume === 0
    ? IconVolumeOff
    : volume < 10 ? IconVolume4 : volume <= 50 ? IconVolume2 : IconVolume

  return (
    <div className="client-indicator" onContextMenu={handleContextMenu}>
      {statusIcon}
      <span className="client-avatar" aria-hidden="true">{initial}</span>
      {client.name}
      <span className="client-status" title="Online" />
      {menuPos && (
        <div
          className="client-context-menu"
          ref={menuRef}
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          <div className="client-context-menu-header">{client.name}</div>
          <div className="client-context-menu-row">
            <button
              type="button"
              className="client-volume-btn"
              onClick={toggleLocalMute}
              title={localMuted ? 'Unmute for me' : 'Mute for me'}
            >
              <VolumeIcon size={16} />
            </button>
            <input
              type="range"
              className="client-volume-slider"
              min={0}
              max={100}
              value={localMuted ? 0 : volume}
              onChange={handleVolumeChange}
              title="Volume"
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default ClientIndicator
