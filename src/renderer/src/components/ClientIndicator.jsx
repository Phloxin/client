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
  IconVolumeOff,
  IconVideoFilled,
  IconHandFinger
} from '@tabler/icons-react'
import { setClientAudioState, getClientAudioState } from '../lib/soup'

// rosterMode renders a presence-only entry (the sidebar's Users tab): no mic/
// status indicator and no right-click volume control, since those entries aren't
// voice participants we're listening to.
function ClientIndicator({
  client,
  speaking,
  micMuted,
  deafened,
  isSelf,
  streaming,
  animStatus,
  rosterMode,
  onOpenDm,
  onPoke,
  onShowClientSummary
}) {
  const initial = client.name?.charAt(0).toUpperCase() ?? '?'
  const [menuPos, setMenuPos] = useState(null)
  // Poke composer state, scoped to the open context menu.
  const [pokeOpen, setPokeOpen] = useState(false)
  const [pokeText, setPokeText] = useState('')
  const menuRef = useRef(null)
  const [visualSpeaking, setVisualSpeaking] = useState(speaking)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const fadeTimerRef = useRef(null)

  useEffect(() => {
    if (speaking) {
      clearTimeout(fadeTimerRef.current)
      setVisualSpeaking(true)
      setIsFadingOut(false)
    } else {
      setIsFadingOut(true)
      fadeTimerRef.current = setTimeout(() => {
        setVisualSpeaking(false)
        setIsFadingOut(false)
      }, 100)
    }
    return () => clearTimeout(fadeTimerRef.current)
  }, [speaking])

  const initialAudioState = getClientAudioState(client.id)
  const [volume, setVolume] = useState(Math.round(initialAudioState.volume * 100))
  const [localMuted, setLocalMuted] = useState(initialAudioState.muted)

  // Apply this client's local volume/mute override whenever it changes. Skipped
  // in rosterMode — those entries don't control playback (and shouldn't clobber
  // the volume the in-channel indicator manages for the same client).
  useEffect(() => {
    if (isSelf || rosterMode) return
    setClientAudioState(client.id, { volume: volume / 100, muted: localMuted })
  }, [client.id, volume, localMuted, isSelf, rosterMode])

  // Close the context menu on outside click
  useEffect(() => {
    if (!menuPos) return
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuPos(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuPos])

  // Reset the poke composer whenever the menu closes.
  useEffect(() => {
    if (!menuPos) {
      setPokeOpen(false)
      setPokeText('')
    }
  }, [menuPos])

  const handleContextMenu = (e) => {
    // Can't poke or adjust your own volume. In rosterMode the only action is the
    // poke, so skip the menu entirely if there's nothing to poke with.
    if (isSelf || (rosterMode && !onPoke)) return
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const submitPoke = () => {
    onPoke?.(client.id, pokeText)
    setMenuPos(null)
  }

  // Single-click opens this client's summary; double-click opens a DM. A click
  // always precedes a dblclick, so the single-click action is deferred briefly and
  // cancelled if a double-click follows. stopPropagation keeps both off the
  // enclosing channel row (whose double-click joins voice).
  const clickTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(clickTimerRef.current), [])

  const handleClick = (e) => {
    if (!onShowClientSummary) return
    e.stopPropagation()
    clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => onShowClientSummary(client.id), 200)
  }

  const handleDoubleClick = (e) => {
    clearTimeout(clickTimerRef.current)
    if (isSelf || !onOpenDm) return
    e.stopPropagation()
    onOpenDm(client.id)
  }

  const toggleLocalMute = () => setLocalMuted((prev) => !prev)

  const handleVolumeChange = (e) => {
    const next = Number(e.target.value)
    setVolume(next)
    if (next > 0 && localMuted) setLocalMuted(false)
    if (next === 0 && !localMuted) setLocalMuted(true)
  }

  // Snap back to the 100% baseline (the center marker)
  const resetVolume = () => {
    setVolume(100)
    setLocalMuted(false)
  }

  let statusIcon
  if (deafened) {
    statusIcon = <IconHeadphonesOff size={14} className="mic-indicator deafened" aria-label="Deafened" />
  } else if (micMuted) {
    statusIcon = <IconMicrophoneOff size={14} className="mic-indicator muted" aria-label="Muted" />
  } else if (visualSpeaking) {
    const cls = isFadingOut ? 'mic-indicator speaking-fade' : 'mic-indicator speaking'
    statusIcon = <IconMicrophoneFilled size={14} className={cls} aria-label="Speaking" />
  } else {
    statusIcon = <IconMicrophone size={14} className="mic-indicator" aria-label="Not speaking" />
  }

  const VolumeIcon = localMuted || volume === 0
    ? IconVolumeOff
    : volume < 50 ? IconVolume4 : volume <= 99 ? IconVolume2 : IconVolume

  return (
    <div
      className="client-indicator"
      data-anim-status={animStatus}
      onContextMenu={handleContextMenu}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {!rosterMode && statusIcon}
      <span className="client-avatar" aria-hidden="true">{initial}</span>
      {client.name}
      {streaming && (
        <IconVideoFilled size={15} className="client-streaming-icon" aria-label="Streaming" />
      )}
      {menuPos && (
        <div
          className="client-context-menu"
          ref={menuRef}
          style={{ top: menuPos.y, left: menuPos.x }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="client-context-menu-header">{client.name}</div>
          {!rosterMode && (
            <div className="client-context-menu-row">
              <button
                type="button"
                className="client-volume-btn"
                onClick={toggleLocalMute}
                title={localMuted ? 'Unmute for me' : 'Mute for me'}
              >
                <VolumeIcon size={16} />
              </button>
              <div className="client-volume-slider-wrap">
                <span className="client-volume-center-tick" aria-hidden="true" />
                <input
                  type="range"
                  className="client-volume-slider"
                  min={0}
                  max={200}
                  value={localMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  onDoubleClick={resetVolume}
                  title="Volume — 100% is normal, drag right to boost (double-click to reset)"
                />
              </div>
              <span className="client-volume-value">{localMuted ? 0 : volume}%</span>
            </div>
          )}
          {onPoke &&
            (pokeOpen ? (
              <div className="client-poke-row">
                <input
                  className="client-poke-input"
                  value={pokeText}
                  autoFocus
                  placeholder="Add a message (optional)"
                  onChange={(e) => setPokeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submitPoke()
                    } else if (e.key === 'Escape') {
                      setPokeOpen(false)
                    }
                  }}
                />
                <button type="button" className="client-poke-send" onClick={submitPoke} title="Send poke">
                  <IconHandFinger size={16} />
                </button>
              </div>
            ) : (
              <button type="button" className="client-context-menu-item" onClick={() => setPokeOpen(true)}>
                <IconHandFinger size={16} />
                Poke
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

export default ClientIndicator
