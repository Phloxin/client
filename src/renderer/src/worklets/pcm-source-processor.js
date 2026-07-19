// AudioWorkletProcessor that turns PCM frames pushed over a MessagePort into
// a live audio output. The capture pipeline transfers the Electron-side
// MessagePort directly into this worklet, so 10ms frames (interleaved f32le
// stereo @ 48kHz ArrayBuffers) arrive on the audio rendering thread without
// bouncing through the page's main thread.
//
// Buffering policy:
//   - jitter buffer: playback holds silence until PREBUFFER_FRAMES arrived
//   - underrun: emit silence, re-arm the prebuffer, count it
//   - overrun: drop oldest samples, count it
// Counters are reported to the node every STATS_INTERVAL_MS for diagnostics.

const CHANNELS = 2
const RING_SECONDS = 0.5
const PREBUFFER_MS = 60
const STATS_INTERVAL_MS = 5000

class PcmSourceProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ringFrames = Math.floor(sampleRate * RING_SECONDS)
    // Planar rings, one Float32Array per channel
    this.ring = [new Float32Array(this.ringFrames), new Float32Array(this.ringFrames)]
    this.readPos = 0
    this.writePos = 0
    this.buffered = 0
    this.prebufferFrames = Math.floor((sampleRate * PREBUFFER_MS) / 1000)
    this.priming = true
    this.underruns = 0
    this.overruns = 0
    this.lastStats = 0
    this.ended = false
    this.receivedFirstFrame = false

    this.port.onmessage = (e) => {
      const msg = e.data
      if (msg instanceof ArrayBuffer) {
        this.push(new Float32Array(msg))
      } else if (msg?.type === 'pcm-port') {
        // The capture MessagePort, transferred in from the page
        this.pcmPort = msg.port
        this.pcmPort.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) this.push(new Float32Array(ev.data))
        }
      } else if (msg?.type === 'end') {
        this.ended = true
        if (this.pcmPort) this.pcmPort.close()
      }
    }
  }

  push(interleaved) {
    const frames = Math.floor(interleaved.length / CHANNELS)
    if (frames > 0 && !this.receivedFirstFrame) {
      this.receivedFirstFrame = true
      this.port.postMessage({ type: 'ready' })
    }
    // Overrun: make room by dropping the oldest audio
    const excess = this.buffered + frames - this.ringFrames
    if (excess > 0) {
      this.readPos = (this.readPos + excess) % this.ringFrames
      this.buffered -= excess
      this.overruns++
    }
    let w = this.writePos
    for (let i = 0; i < frames; i++) {
      this.ring[0][w] = interleaved[i * CHANNELS]
      this.ring[1][w] = interleaved[i * CHANNELS + 1]
      w = (w + 1) % this.ringFrames
    }
    this.writePos = w
    this.buffered += frames
  }

  process(_inputs, outputs) {
    if (this.ended) return false

    const out = outputs[0]
    const frames = out[0].length
    const left = out[0]
    const right = out.length > 1 ? out[1] : out[0]

    if (this.priming) {
      if (this.buffered >= this.prebufferFrames) this.priming = false
    } else if (this.buffered < frames) {
      this.underruns++
      this.priming = true
    }

    if (this.priming) {
      left.fill(0)
      if (right !== left) right.fill(0)
    } else {
      let r = this.readPos
      for (let i = 0; i < frames; i++) {
        left[i] = this.ring[0][r]
        right[i] = this.ring[1][r]
        r = (r + 1) % this.ringFrames
      }
      this.readPos = r
      this.buffered -= frames
    }

    const now = currentTime * 1000
    if (now - this.lastStats >= STATS_INTERVAL_MS) {
      this.lastStats = now
      this.port.postMessage({
        type: 'stats',
        underruns: this.underruns,
        overruns: this.overruns,
        bufferedMs: Math.round((this.buffered / sampleRate) * 1000)
      })
    }
    return true
  }
}

registerProcessor('pcm-source', PcmSourceProcessor)
