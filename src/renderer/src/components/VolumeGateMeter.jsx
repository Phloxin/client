import { useState, useEffect, useRef } from 'react'
import { createLevelGateController, createMicLevelMonitor } from '../lib/soup'

function VolumeGateMeter({ threshold, onThresholdChange, micSettings, gateEnabled }) {
  const [audioLevel, setAudioLevel] = useState(0)
  const [analyserNode, setAnalyserNode] = useState(null)
  const [testPlaying, setTestPlaying] = useState(false)
  const [testGateOpen, setTestGateOpen] = useState(false)

  const meterRafRef = useRef(null)
  const testRafRef = useRef(null)
  const meterRef = useRef(null)
  const audioCtxRef = useRef(null)
  const streamRef = useRef(null)
  const sourceRef = useRef(null)
  const readRef = useRef(null)
  const testGainRef = useRef(null)
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
    setTestGateOpen(false)
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
    micSettings.autoGainControl,
    micSettings.useRnnoise
  ])

  // ── Initialize audio context + analyser ──────────────────────────
  useEffect(() => {
    let ctx, stream, monitor
    let cancelled = false
    const init = async () => {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId:
              micSettings.deviceId && micSettings.deviceId !== 'default'
                ? { exact: micSettings.deviceId }
                : undefined,
            echoCancellation: micSettings.echoCancellation,
            noiseSuppression: micSettings.useRnnoise ? false : micSettings.noiseSuppression,
            autoGainControl: micSettings.autoGainControl,
            sampleRate: micSettings.sampleRate,
            channelCount: micSettings.channelCount
          }
        })

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          if (ctx.state !== 'closed') await ctx.close().catch(() => {})
          return
        }

        if (ctx.state === 'suspended') await ctx.resume()
        monitor = await createMicLevelMonitor(ctx, stream, {
          useRnnoise: micSettings.useRnnoise
        })

        if (cancelled) {
          monitor.stop()
          stream.getTracks().forEach((track) => track.stop())
          if (ctx.state !== 'closed') await ctx.close().catch(() => {})
          return
        }

        readRef.current = monitor.read
        setAnalyserNode(monitor.analyser)
        audioCtxRef.current = ctx
        streamRef.current = stream
        // Test playback uses the same post-RNNoise node the live gate receives.
        sourceRef.current = monitor.outputNode
      } catch (err) {
        if (!cancelled) console.error('[VolumeGateMeter] init failed', err)
        monitor?.stop()
        stream?.getTracks().forEach((track) => track.stop())
        if (ctx?.state !== 'closed') ctx?.close().catch(() => {})
      }
    }

    init()

    return () => {
      cancelled = true
      cancelAnimationFrame(meterRafRef.current)
      cancelAnimationFrame(testRafRef.current)
      monitor?.stop()
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
    micSettings.autoGainControl,
    micSettings.useRnnoise,
    micSettings.sampleRate,
    micSettings.channelCount
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
    const read = readRef.current
    if (!ctx || !source || !analyserNode || !read) return

    const gain = ctx.createGain()
    const gateController = gateEnabledRef.current
      ? createLevelGateController(ctx, gain, read, { threshold: thresholdRef.current })
      : null
    if (!gateController) gain.gain.setValueAtTime(1, ctx.currentTime)
    testGainRef.current = gain

    try {
      source.connect(gain)
      gain.connect(ctx.destination)
    } catch (err) {
      console.error('[VolumeGateMeter] test connect failed', err)
      return
    }

    testPlayingRef.current = true
    setTestPlaying(true)
    setTestGateOpen(!gateController)

    const tick = () => {
      if (gateController) {
        const { open } = gateController.update(thresholdRef.current)
        setTestGateOpen((previous) => (previous === open ? previous : open))
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
              testGateOpen ? (
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
