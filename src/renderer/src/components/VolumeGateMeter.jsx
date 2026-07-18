import { useState, useEffect, useRef } from 'react'
import { createSpeechLevelReader } from '../lib/soup'

const HOLD_MS = 180
const RAMP_S = 0.03

function VolumeGateMeter({ threshold, onThresholdChange, micSettings, gateEnabled }) {
  const [audioLevel, setAudioLevel] = useState(0)
  const [analyserNode, setAnalyserNode] = useState(null)
  const [testPlaying, setTestPlaying] = useState(false)

  const meterRafRef = useRef(null)
  const testRafRef = useRef(null)
  const meterRef = useRef(null)
  const audioCtxRef = useRef(null)
  const streamRef = useRef(null)
  const sourceRef = useRef(null)
  const readRef = useRef(null)
  const testGainRef = useRef(null)
  const lastAboveRef = useRef(0)
  const testPlayingRef = useRef(false)

  const thresholdRef = useRef(threshold)
  useEffect(() => {
    thresholdRef.current = threshold
  }, [threshold])

  const gateEnabledRef = useRef(gateEnabled)

  // ── stopTest defined early so effects below can reference it ──────
  const stopTest = () => {
    if (!testPlayingRef.current) return
    cancelAnimationFrame(testRafRef.current)
    const gain = testGainRef.current
    const source = sourceRef.current
    try {
      gain?.disconnect()
    } catch {}
    try {
      source?.disconnect(gain)
    } catch {}
    testGainRef.current = null
    testPlayingRef.current = false
    setTestPlaying(false)
  }

  // Stop when gate toggle actually changes value (not just re-renders)
  const gateEnabledPrevRef = useRef(gateEnabled)
  useEffect(() => {
    if (gateEnabledPrevRef.current !== gateEnabled) {
      gateEnabledPrevRef.current = gateEnabled
      gateEnabledRef.current = gateEnabled
      stopTest()
    } else {
      gateEnabledRef.current = gateEnabled
    }
  }, [gateEnabled])

  // Stop when any mic setting that affects the stream changes
  useEffect(() => {
    stopTest()
  }, [
    micSettings.deviceId,
    micSettings.echoCancellation,
    micSettings.noiseSuppression,
    micSettings.autoGainControl
  ])

  // ── Initialize audio context + analyser ──────────────────────────
  useEffect(() => {
    let ctx, stream, source
    const init = async () => {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)()
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId:
              micSettings.deviceId && micSettings.deviceId !== 'default'
                ? { exact: micSettings.deviceId }
                : undefined,
            echoCancellation: micSettings.echoCancellation,
            noiseSuppression: micSettings.noiseSuppression,
            autoGainControl: micSettings.autoGainControl
          }
        })

        // Same speech-band metric as the gate/detector (see soup.js) so the meter
        // level and threshold marker read on the gate's scale. (This raw stream has
        // no RNNoise, unlike the live gate — matching that too is future work.)
        const reader = createSpeechLevelReader(ctx)
        const node = reader.analyser
        source = ctx.createMediaStreamSource(stream)
        source.connect(node)

        readRef.current = reader.read
        setAnalyserNode(node)
        audioCtxRef.current = ctx
        streamRef.current = stream
        sourceRef.current = source
      } catch (err) {
        console.error('[VolumeGateMeter] init failed', err)
      }
    }

    init()

    return () => {
      cancelAnimationFrame(meterRafRef.current)
      cancelAnimationFrame(testRafRef.current)
      try {
        source?.disconnect()
      } catch {}
      try {
        stream?.getTracks().forEach((t) => t.stop())
      } catch {}
      try {
        ctx?.close()
      } catch {}
      audioCtxRef.current = null
      streamRef.current = null
      sourceRef.current = null
      readRef.current = null
    }
  }, [
    micSettings.deviceId,
    micSettings.echoCancellation,
    micSettings.noiseSuppression,
    micSettings.autoGainControl
  ])

  // ── Level-meter polling loop ──────────────────────────────────────
  useEffect(() => {
    if (!analyserNode) return
    const read = readRef.current

    const loop = () => {
      setAudioLevel(Math.min(100, read()))
      meterRafRef.current = requestAnimationFrame(loop)
    }

    loop()
    return () => cancelAnimationFrame(meterRafRef.current)
  }, [analyserNode])

  // ── Test: local playback, gating only when gate is enabled ────────
  const startTest = () => {
    if (testPlayingRef.current) return
    const ctx = audioCtxRef.current
    const source = sourceRef.current
    const node = analyserNode
    if (!ctx || !source || !node) return

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(1, ctx.currentTime)
    testGainRef.current = gain

    try {
      source.connect(gain)
      gain.connect(ctx.destination)
    } catch (err) {
      console.error('[VolumeGateMeter] test connect failed', err)
      return
    }

    lastAboveRef.current = 0
    testPlayingRef.current = true
    setTestPlaying(true)

    const tick = () => {
      if (gateEnabledRef.current) {
        const level = Math.min(100, readRef.current())
        const now = performance.now()

        if (level >= thresholdRef.current) lastAboveRef.current = now

        const gateOpen = now - lastAboveRef.current < HOLD_MS
        const target = gateOpen ? 1 : 0
        const current = gain.gain.value

        if (Math.abs(current - target) > 0.01) {
          gain.gain.cancelScheduledValues(ctx.currentTime)
          gain.gain.setValueAtTime(current, ctx.currentTime)
          gain.gain.linearRampToValueAtTime(target, ctx.currentTime + RAMP_S)
        }
      }

      testRafRef.current = requestAnimationFrame(tick)
    }

    tick()
  }

  // ── Click-to-set handling ──────────────────────────────────────────
  const updateFromClientX = (clientX) => {
    const el = meterRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))
    onThresholdChange(Math.round(pct))
  }

  return (
    <div className="volume-gate-meter">
      <div
        className="vg-bar"
        ref={meterRef}
        onClick={(e) => updateFromClientX(e.clientX)}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={threshold}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onThresholdChange(Math.max(0, threshold - 1))
          if (e.key === 'ArrowRight') onThresholdChange(Math.min(100, threshold + 1))
        }}
      >
        <div className="vg-fill" style={{ width: `${audioLevel}%` }} />
        <div className="vg-marker" style={{ left: `${threshold}%` }} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="vg-test-btn" onClick={() => (testPlaying ? stopTest() : startTest())}>
          {testPlaying ? 'Stop Test' : 'Test Mic'}
        </button>
        {testPlaying && (
          <p className="volume-gate-info" style={{ margin: 0 }}>
            {gateEnabled ? (
              audioLevel > threshold ? (
                <span className="vg-status vg-on">Audio transmitting</span>
              ) : (
                <span className="vg-status vg-off">Audio filtered</span>
              )
            ) : (
              <span className="vg-status" style={{ color: 'var(--color-text-secondary)' }}>
                Gate disabled
              </span>
            )}
          </p>
        )}
      </div>
    </div>
  )
}

export default VolumeGateMeter
