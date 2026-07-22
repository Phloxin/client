import { useState, useEffect, useRef } from 'react'
import {
  acquireMicCapture,
  createLevelGateController,
  createMicLevelMonitor,
  getRawMicStream,
  onRawMicStreamChange
} from '../lib/soup'

function VolumeGateMeter({ threshold, onThresholdChange, micSettings, gateEnabled }) {
  const [audioLevel, setAudioLevel] = useState(0)
  const [analyserNode, setAnalyserNode] = useState(null)
  const [testPlaying, setTestPlaying] = useState(false)
  const [testGateOpen, setTestGateOpen] = useState(false)

  // The call's capture, when joined to a voice channel. Chromium binds audio
  // processing to the first capture open on a device, so opening a second one
  // here would both show stale processing and poison the call's next republish.
  // While joined we read the call's capture instead — which means the meter
  // previews *applied* settings, not the draft. Not previewable while in a
  // channel; that's the tradeoff for the meter telling the truth.
  const [liveMicStream, setLiveMicStream] = useState(() => getRawMicStream())
  useEffect(() => onRawMicStreamChange(setLiveMicStream), [])

  const meterRafRef = useRef(null)
  const testRafRef = useRef(null)
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
    micSettings.useRnnoise,
    liveMicStream
  ])

  // ── Initialize audio context + analyser ──────────────────────────
  useEffect(() => {
    let ctx, stream, monitor
    // Only a capture this component opened may be stopped on teardown; the
    // call's belongs to soup and stopping it would cut the user's mic.
    let ownsStream = false
    let cancelled = false
    const releaseStream = () => {
      if (ownsStream) stream?.getTracks().forEach((track) => track.stop())
    }
    const init = async () => {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
        if (liveMicStream) {
          stream = liveMicStream
        } else {
          // Not in a channel: this meter owns the only capture. Goes through the
          // shared acquire so the previous one is fully released before the new
          // one opens, otherwise Chromium reuses its processing config and
          // toggling AGC here changes nothing.
          stream = await acquireMicCapture(micSettings)
          ownsStream = true
        }

        if (cancelled) {
          releaseStream()
          if (ctx.state !== 'closed') await ctx.close().catch(() => {})
          return
        }

        if (ctx.state === 'suspended') await ctx.resume()
        monitor = await createMicLevelMonitor(ctx, stream, {
          useRnnoise: micSettings.useRnnoise
        })

        if (cancelled) {
          monitor.stop()
          releaseStream()
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
        releaseStream()
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
        releaseStream()
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
    micSettings.channelCount,
    liveMicStream
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

  // The gate threshold is stored as a unitless 0-100 level (the same scale the
  // live meter reports). The slider presents it in dB from -50 to +50, a plain
  // linear relabel of that 0-100 range, so nothing downstream has to change.
  const thresholdDb = Math.round(threshold - 50)
  const dbLabel = `${thresholdDb > 0 ? '+' : ''}${thresholdDb} dB`

  return (
    <div className="volume-gate-meter">
      <div className="vg-slider-row">
        <div className="vg-meter">
          {/* Live mic level, behind the slider so the threshold thumb reads
              against your actual input on a shared 0-100 scale. */}
          <div className="vg-track">
            <div className="vg-fill" style={{ width: `${audioLevel}%` }} />
          </div>
          <input
            type="range"
            className="vg-slider"
            min={-50}
            max={50}
            step={1}
            value={thresholdDb}
            onChange={(e) => onThresholdChange(Number(e.target.value) + 50)}
            aria-label="Voice gate threshold"
            aria-valuetext={dbLabel}
          />
        </div>
        <span className="vg-value">{dbLabel}</span>
      </div>
      {liveMicStream && (
        <p className="settings-section-desc" style={{ marginTop: 8 }}>
          You&apos;re in a voice channel, so this meter shows your live mic. Capture settings
          (gain, noise, echo) preview only after you hit Apply.
        </p>
      )}
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
