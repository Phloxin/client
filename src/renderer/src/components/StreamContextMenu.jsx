import { useState, useRef, useEffect } from 'react'
import {
  IconAdjustmentsHorizontal,
  IconChevronRight,
  IconDeviceDesktop,
  IconExternalLink,
  IconEyeOff,
  IconFocus2,
  IconLayoutGrid,
  IconMaximize,
  IconMinimize,
  IconMovie,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconScreenShareOff
} from '@tabler/icons-react'
import { RESOLUTIONS } from '../lib/captureOptions'
import { useMenuPosition } from '../lib/menuPosition'
import { useWheelSlider } from '../lib/useWheelSlider'
import { Submenu } from './ClientContextMenu'

// The right-click menu for a stream tile (grid tile, thumbnail, or the focused
// stream). Every per-stream action lives here: this stream's audio level,
// focus, watch/stop, our own share's controls, and the view actions. VideoGrid
// owns the open state and renders it inside the viewer (not a body portal), so
// it stays visible while the viewer is OS-fullscreen; the fixed-position menu
// look comes from ClientContextMenu's classes in VoiceChannel.css, which is in
// the same renderer bundle as the popout. Each action closes the menu, except
// the volume row, which is adjusted in place.
/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
function StreamContextMenu({
  label,
  pos,
  onClose,
  isSelf,
  // { value (0..200, 0 while muted), muted, icon (element), onChange, onToggleMute,
  // onReset } for someone else's stream; null for our own (we never hear it).
  audio,
  focused,
  canToggleFocus,
  onToggleFocus,
  // Someone else's stream: whether we're consuming it, and the setter.
  watched,
  onSetWatched,
  // Our own stream: end the share (absent in windows that can't reach it).
  onStopSharing,
  // Our own stream: pause, change source, and retune the live share.
  shareControl,
  onPopout,
  theatre,
  onToggleTheatre,
  isFullscreen,
  onToggleFullscreen
}) {
  const menuRef = useRef(null)
  const menuStyle = useMenuPosition(menuRef, pos)
  const volumeWheelRef = useWheelSlider(audio?.onChange)
  // The capture options live in the sidebar's voice channel; snapshot them as
  // the menu opens (it remounts per open) so the segments show what's live.
  const [shareOptions, setShareOptions] = useState(() =>
    isSelf ? (shareControl?.getOptions() ?? null) : null
  )
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Close on outside click or Escape. Escape is marked handled so the app-level
  // Escape (Main's cascade, the popout's unfocus) doesn't also act underneath.
  useEffect(() => {
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Run an action, then close the menu.
  const act = (fn) => () => {
    fn?.()
    onClose()
  }

  // Retune the live share. Nothing can be changed in place, so this restarts the
  // stream; the segments update optimistically, then resync to whatever the
  // restart actually settled on ('on' is a placeholder until it reports back).
  const applyShareOptions = async (patch) => {
    const { audio, ...rest } = patch
    setShareOptions((prev) => ({
      ...prev,
      ...rest,
      ...(audio == null ? {} : { audioMode: audio ? 'on' : 'none' })
    }))
    await shareControl?.restart(patch)
    // Only resync if the restart left us sharing — mid-restart the sidebar's
    // handle is briefly gone, and blanking the menu then would look broken.
    const settled = shareControl?.getOptions()
    if (settled) setShareOptions(settled)
  }

  // A settings segment restarts the share, which drops our tile for a moment
  // and so would close the menu anyway; close it straight away like any action.
  const applyAndClose = (patch) => {
    void applyShareOptions(patch)
    onClose()
  }

  const watchItem = isSelf ? (
    onStopSharing && (
      <button
        type="button"
        className="client-context-menu-item danger"
        onClick={act(onStopSharing)}
      >
        <IconScreenShareOff size={16} />
        Stop streaming
      </button>
    )
  ) : watched ? (
    <button
      type="button"
      className="client-context-menu-item"
      onClick={act(() => onSetWatched(false))}
    >
      <IconEyeOff size={16} />
      Stop watching
    </button>
  ) : (
    <button
      type="button"
      className="client-context-menu-item"
      onClick={act(() => onSetWatched(true))}
    >
      <IconPlayerPlayFilled size={16} />
      Watch stream
    </button>
  )

  // Our own share's controls. Pausing restarts nothing: viewers keep the stream
  // and see it paused until it resumes. The settings flyout carries the capture
  // rows from the old in-bar popover; a camera share has none of those to
  // retune, so it gets no flyout (only Pause/Resume and Change source).
  const ownShareItems =
    isSelf && shareControl ? (
      <>
        {shareOptions && (
          <button
            type="button"
            className="client-context-menu-item"
            onClick={act(() => shareControl.setPaused(!shareOptions.paused))}
          >
            {shareOptions.paused ? (
              <IconPlayerPlayFilled size={16} />
            ) : (
              <IconPlayerPauseFilled size={16} />
            )}
            {shareOptions.paused ? 'Resume stream' : 'Pause stream'}
          </button>
        )}
        <button
          type="button"
          className="client-context-menu-item"
          onClick={act(() => shareControl.pickSource())}
        >
          <IconDeviceDesktop size={16} />
          Change source
        </button>
        {shareOptions && !shareOptions.isCamera && (
          <div className="client-submenu">
            <button
              type="button"
              className="client-context-menu-item"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <IconAdjustmentsHorizontal size={16} />
              Stream settings
              <IconChevronRight size={14} className="client-context-menu-trailing" />
            </button>
            {settingsOpen && (
              <Submenu>
                <div className="stream-settings-panel">
                  <div className="stream-settings-row">
                    <span>FPS</span>
                    <div className="picker-segment">
                      {[30, 60].map((val) => (
                        <button
                          key={val}
                          type="button"
                          className={`picker-segment-btn${shareOptions.fps === val ? ' active' : ''}`}
                          onClick={() => applyAndClose({ fps: val })}
                        >
                          {val}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="stream-settings-row">
                    <span>Resolution</span>
                    <div className="picker-segment">
                      {RESOLUTIONS.map(({ label: resLabel, width, height }) => (
                        <button
                          key={resLabel}
                          type="button"
                          className={`picker-segment-btn${shareOptions.height === height ? ' active' : ''}`}
                          onClick={() => applyAndClose({ width, height })}
                        >
                          {resLabel}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="stream-settings-row">
                    <span>Optimize</span>
                    <div className="picker-segment">
                      {[
                        { value: 'detail', label: 'Detail' },
                        { value: 'motion', label: 'Motion' }
                      ].map(({ value, label: optLabel }) => (
                        <button
                          key={value}
                          type="button"
                          className={`picker-segment-btn${shareOptions.optimizeFor === value ? ' active' : ''}`}
                          onClick={() => applyAndClose({ optimizeFor: value })}
                          title={
                            value === 'motion' ? 'Best for games and video' : 'Best for text and UI'
                          }
                        >
                          {optLabel}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="stream-settings-row">
                    <span>Audio</span>
                    <div className="picker-segment">
                      {[
                        { on: true, label: 'On' },
                        { on: false, label: 'Off' }
                      ].map(({ on, label: audioLabel }) => (
                        <button
                          key={audioLabel}
                          type="button"
                          className={`picker-segment-btn${(shareOptions.audioMode !== 'none' && shareOptions.audioMode != null) === on ? ' active' : ''}`}
                          onClick={() => applyAndClose({ audio: on })}
                        >
                          {audioLabel}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="stream-settings-note">Other changes restart your stream.</div>
                </div>
              </Submenu>
            )}
          </div>
        )}
      </>
    ) : null

  // Dividers split the volume row, the stream actions, and the view actions
  // (which always include Fullscreen); a group with nothing in it gets none.
  const hasStreamActions = canToggleFocus || !!watchItem || !!ownShareItems

  return (
    <div
      className="client-context-menu"
      ref={menuRef}
      style={menuStyle}
      // Inside the viewer, so keep its clicks from panning, unfocusing, or
      // reopening the menu underneath.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="client-context-menu-header">{label}</div>
      {audio && (
        <>
          <div className="client-context-menu-row">
            <button
              type="button"
              className="client-volume-btn"
              onClick={audio.onToggleMute}
              title={audio.muted ? 'Unmute stream' : 'Mute stream'}
            >
              {audio.icon}
            </button>
            <div className="client-volume-slider-wrap">
              <span className="client-volume-center-tick" aria-hidden="true" />
              <input
                ref={volumeWheelRef}
                type="range"
                className="client-volume-slider"
                min={0}
                max={200}
                value={audio.value}
                onChange={audio.onChange}
                onDoubleClick={audio.onReset}
                title="Volume — 100% is normal, drag right to boost (double-click to reset)"
              />
            </div>
            <span className="client-volume-value">{audio.value}%</span>
          </div>
          <div className="client-context-menu-divider" aria-hidden="true" />
        </>
      )}
      {canToggleFocus && (
        <button type="button" className="client-context-menu-item" onClick={act(onToggleFocus)}>
          {focused ? <IconLayoutGrid size={16} /> : <IconFocus2 size={16} />}
          {focused ? 'Grid View' : 'Focus stream'}
        </button>
      )}
      {watchItem}
      {ownShareItems}
      {hasStreamActions && <div className="client-context-menu-divider" aria-hidden="true" />}
      {onPopout && (
        <button type="button" className="client-context-menu-item" onClick={act(onPopout)}>
          <IconExternalLink size={16} />
          Pop out
        </button>
      )}
      {onToggleTheatre && (
        <button
          type="button"
          className="client-context-menu-item"
          onClick={act(() => onToggleTheatre())}
        >
          <IconMovie size={16} />
          {theatre ? 'Exit theatre' : 'Theatre mode'}
        </button>
      )}
      <button type="button" className="client-context-menu-item" onClick={act(onToggleFullscreen)}>
        {isFullscreen ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
        {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      </button>
    </div>
  )
}

export default StreamContextMenu
