import { useState, useEffect, useRef } from 'react'

function VolumeGateMeter({ threshold, onThresholdChange, micSettings }) {
  const [audioLevel, setAudioLevel] = useState(0)
  const [analyser, setAnalyser] = useState(null)
  const [testPlaying, setTestPlaying] = useState(false)
  const animationRef = useRef(null)
  const meterRef = useRef(null)
  const isDraggingRef = useRef(false)
  const audioCtxRef = useRef(null)
  const streamRef = useRef(null)
  const sourceRef = useRef(null)
  const testGainRef = useRef(null)

  // Initialize audio context and analyser (read-only monitoring)
  useEffect(() => {
    let ctx, stream, source
    const init = async () => {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)()
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: micSettings.deviceId && micSettings.deviceId !== 'default' ? { exact: micSettings.deviceId } : undefined,
            echoCancellation: micSettings.echoCancellation,
            noiseSuppression: micSettings.noiseSuppression,
            autoGainControl: micSettings.autoGainControl,
          }
        })

        const analyserNode = ctx.createAnalyser()
        analyserNode.fftSize = 256
        source = ctx.createMediaStreamSource(stream)
        source.connect(analyserNode)
        setAnalyser(analyserNode)
        audioCtxRef.current = ctx
        streamRef.current = stream
        sourceRef.current = source
      } catch (err) {
        console.error('[VolumeGateMeter] init failed', err)
      }
    }

    init()

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
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
    }
  }, [micSettings.deviceId, micSettings.echoCancellation, micSettings.noiseSuppression, micSettings.autoGainControl])

  // Poll analyser for level
  useEffect(() => {
    if (!analyser) return
    const data = new Uint8Array(analyser.frequencyBinCount)
    const loop = () => {
      analyser.getByteFrequencyData(data)
      const avg = data.reduce((a, b) => a + b, 0) / data.length
      const normalized = Math.min(100, (avg / 255) * 100)
      setAudioLevel(normalized)
      animationRef.current = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(animationRef.current)
  }, [analyser])

  // Drag handling for marker
  const startDrag = (clientX) => {
    const el = meterRef.current
    if (!el) return
    isDraggingRef.current = true
    updateFromClientX(clientX, el)
  }

  const stopDrag = () => { isDraggingRef.current = false }

  const moveDrag = (clientX) => {
    if (!isDraggingRef.current) return
    const el = meterRef.current
    if (!el) return
    updateFromClientX(clientX, el)
  }

  const updateFromClientX = (clientX, el) => {
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100))
    onThresholdChange(Math.round(pct))
  }

  useEffect(() => {
    const onMove = (e) => moveDrag(e.clientX)
    const onUp = () => stopDrag()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', (ev) => moveDrag(ev.touches[0].clientX), { passive: true })
    window.addEventListener('touchend', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', (ev) => moveDrag(ev.touches[0].clientX))
      window.removeEventListener('touchend', onUp)
    }
  }, [])

  const startTest = () => {
    if (testPlaying) return
    const ctx = audioCtxRef.current
    const analyserNode = analyser
    const source = sourceRef.current
    if (!ctx || !source || !analyserNode) return

    const gain = ctx.createGain()
    gain.gain.value = 0
    testGainRef.current = gain

    // connect source -> gain -> destination (local playback)
    try {
      source.connect(gain)
      gain.connect(ctx.destination)
    } catch (err) {
      console.error('[VolumeGateMeter] test connect failed', err)
      return
    }

    setTestPlaying(true)

    // update gain based on analyser
    const data = new Uint8Array(analyserNode.frequencyBinCount)
    const tick = () => {
      analyserNode.getByteFrequencyData(data)
      const avg = data.reduce((a, b) => a + b, 0) / data.length
      const normalized = Math.min(100, (avg / 255) * 100)
      // gate
      gain.gain.setValueAtTime(normalized >= threshold ? 1 : 0, ctx.currentTime)
      animationRef.current = requestAnimationFrame(tick)
    }
    tick()
  }

  const stopTest = () => {
    if (!testPlaying) return
    const ctx = audioCtxRef.current
    const gain = testGainRef.current
    const source = sourceRef.current
    if (animationRef.current) cancelAnimationFrame(animationRef.current)
    try {
      gain?.disconnect()
      source?.disconnect(gain)
    } catch (err) {}
    testGainRef.current = null
    setTestPlaying(false)
  }

  return (
    <div className="volume-gate-meter">
      <div
        className="vg-bar"
        ref={meterRef}
        onMouseDown={(e) => startDrag(e.clientX)}
        onTouchStart={(e) => startDrag(e.touches[0].clientX)}
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
        <div className="vg-marker" style={{ left: `${threshold}%` }} onMouseDown={(e) => { e.stopPropagation(); startDrag(e.clientX) }} onTouchStart={(e) => { e.stopPropagation(); startDrag(e.touches[0].clientX) }} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="vg-test-btn" onClick={() => (testPlaying ? stopTest() : startTest())}>
          {testPlaying ? 'Stop Test' : 'Test Threshold'}
        </button>
        <p className="volume-gate-info" style={{ margin: 0 }}>
          {audioLevel > threshold ? (
            <span className="vg-status vg-on">Audio transmitting</span>
          ) : (
            <span className="vg-status vg-off">Audio filtered</span>
          )}
        </p>
      </div>
    </div>
  )
}

export default VolumeGateMeter
