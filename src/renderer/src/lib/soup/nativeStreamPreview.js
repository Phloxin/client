// The sharer's own picture of a native share as the share itself: the sidecar hands over the
// frames its encoder made,
// before they are encrypted (`preview_frame` messages, through main), and a WebCodecs
// VideoDecoder here turns them back into pictures for the preview's canvas. Full size, full
// frame rate, what viewers get. The frames are the sharer's screen: they are never logged, stored
// or sent anywhere but the decoder. The JPEG pictures of nativePreview.js stay the fallback.
// Pure parts and a decoder that takes VideoDecoder from its caller, so it can be tested.

// More chunks than this waiting in the decoder. Half a second at 60.
export const STREAM_QUEUE_LIMIT = 30
// The decoder is behind once its queue has been over STREAM_QUEUE_LIMIT for this long without a
// break: frames that queued during a stall of the page come in a burst, which drains sooner.
export const STREAM_BEHIND_MS = 500
// A kept picture not drawn by an animation frame within this is drawn from a timer: a hidden or
// minimised main window gets no animation frames while the pop-out may show the tile.
export const PAINT_TIMER_MS = 50
// A key frame is asked for at most this often.
export const KEY_FRAME_ASK_MS = 2000
// Why a stream preview that fell behind twice in one share gives way to the JPEGs.
export const STREAM_BEHIND = 'stream preview could not keep up'

// Set once a stream preview fell back for not keeping up: later shares of this run of the app
// start with the JPEG preview. Cleared only by a restart (and the test hooks).
let behindThisRun = false

export function streamPreviewBehind() {
  return behindThisRun
}

export function setStreamPreviewBehind(value) {
  behindThisRun = value === true
}

// What isConfigSupported is asked about, before any frame said more: Constrained Baseline at
// level 4.2 (1080p at 60) for H264, Main profile 8 bit at level 4.0 for AV1.
export const STREAM_PROBE_CODECS = { H264: 'avc1.42E02A', AV1: 'av01.0.08M.08' }

// Chromium takes 'prefer-hardware' as "hardware only" and refuses it where there is no hardware
// decoder; 'no-preference' is the hardware where there is one, else software.
const ACCELERATIONS = ['prefer-hardware', 'no-preference']

// base64 (standard, padded) as bytes, or null when it is not base64.
export function base64Bytes(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  try {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text)
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

const hex2 = (value) => value.toString(16).toUpperCase().padStart(2, '0')

// The codec string of an H264 access unit in Annex B from its SPS ('avc1.' and the profile,
// constraint flags and level as hex), or null when it has none.
export function h264CodecString(bytes) {
  for (let i = 0; i + 6 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue
    const nal = i + 3
    if ((bytes[nal] & 0x1f) === 7) {
      return `avc1.${hex2(bytes[nal + 1])}${hex2(bytes[nal + 2])}${hex2(bytes[nal + 3])}`
    }
    i = nal - 1
  }
  return null
}

// Reads bits from the front, most significant first. Past the end it throws.
function bitReader(bytes) {
  let bit = 0
  const read = (count) => {
    let value = 0
    for (let n = 0; n < count; n++) {
      const byte = bit >> 3
      if (byte >= bytes.length) throw new RangeError('past the end')
      value = value * 2 + ((bytes[byte] >> (7 - (bit & 7))) & 1)
      bit++
    }
    return value
  }
  const uvlc = () => {
    let zeros = 0
    while (read(1) === 0) {
      zeros++
      if (zeros >= 32) return 2 ** 32 - 1
    }
    return read(zeros) + 2 ** zeros - 1
  }
  return { read, uvlc }
}

// The payload of the first sequence header OBU in an AV1 temporal unit (OBUs with their size
// fields), or null.
function av1SequenceHeader(bytes) {
  let i = 0
  while (i < bytes.length) {
    const header = bytes[i]
    const type = (header >> 3) & 0x0f
    let at = i + 1 + ((header >> 2) & 1)
    let size = bytes.length - at
    if ((header >> 1) & 1) {
      size = 0
      for (let n = 0; ; n++) {
        if (at >= bytes.length || n === 8) return null
        const byte = bytes[at++]
        size += (byte & 0x7f) * 2 ** (7 * n)
        if (!(byte & 0x80)) break
      }
    }
    if (at + size > bytes.length) return null
    if (type === 1) return bytes.subarray(at, at + size)
    i = at + size
  }
  return null
}

// The codec string of an AV1 temporal unit from its sequence header ('av01.', the profile, the
// first operating point's level and tier, the bit depth), or null when it has none.
export function av1CodecString(bytes) {
  const payload = av1SequenceHeader(bytes)
  if (!payload) return null
  try {
    const { read, uvlc } = bitReader(payload)
    const profile = read(3)
    read(1) // still_picture
    const reduced = read(1) === 1
    let level
    let tier = 0
    if (reduced) {
      level = read(5)
    } else {
      let decoderModel = false
      let bufferDelayLength = 0
      if (read(1)) {
        // timing_info
        read(32)
        read(32)
        if (read(1)) uvlc()
        decoderModel = read(1) === 1
        if (decoderModel) {
          bufferDelayLength = read(5) + 1
          read(32)
          read(5)
          read(5)
        }
      }
      const initialDisplayDelay = read(1) === 1
      const points = read(5) + 1
      for (let n = 0; n < points; n++) {
        read(12) // operating_point_idc
        const pointLevel = read(5)
        const pointTier = pointLevel > 7 ? read(1) : 0
        if (n === 0) {
          level = pointLevel
          tier = pointTier
        }
        if (decoderModel && read(1)) {
          read(bufferDelayLength)
          read(bufferDelayLength)
          read(1)
        }
        if (initialDisplayDelay && read(1)) read(4)
      }
    }
    const widthBits = read(4) + 1
    const heightBits = read(4) + 1
    read(widthBits)
    read(heightBits)
    if (!reduced && read(1)) {
      // frame_id_numbers_present_flag
      read(4)
      read(3)
    }
    read(3) // use_128x128_superblock, enable_filter_intra, enable_intra_edge_filter
    if (!reduced) {
      read(4) // interintra and masked compound, warped motion, dual filter
      const orderHint = read(1) === 1
      if (orderHint) read(2)
      const screenContent = read(1) ? 2 : read(1)
      if (screenContent > 0 && !read(1)) read(1)
      if (orderHint) read(3)
    }
    read(3) // enable_superres, enable_cdef, enable_restoration
    const high = read(1) === 1
    const depth = profile === 2 && high ? (read(1) ? 12 : 10) : high ? 10 : 8
    return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`
  } catch {
    return null
  }
}

// The codec string of a key frame of `codec` ('h264' or 'av1', as preview_frame names it).
export function streamCodecString(codec, bytes) {
  if (codec === 'h264') return h264CodecString(bytes)
  if (codec === 'av1') return av1CodecString(bytes)
  return null
}

// The most a decoder that may be software (no-preference) is given: 1080p at 60, in pixels a
// second. A 4K60 stream preview decoded in software starved the renderer until the share ended.
export const SOFTWARE_PIXEL_RATE = 1920 * 1080 * 60

const pixelRate = (shape) => {
  const rate = Number(shape?.width) * Number(shape?.height) * Number(shape?.fps)
  return Number.isFinite(rate) ? rate : 0
}

// { mode: 'stream', hardwareAcceleration } when this VideoDecoder says it decodes the share's
// codec ('H264' or 'AV1'), first with the hardware, else { mode: 'jpeg', reason }. With only
// 'no-preference' the stream only when the share's `shape` ({ width, height, fps }, what is sent)
// is at most SOFTWARE_PIXEL_RATE (no shape: no limit). After a stream preview of this run
// could not keep up, always the JPEGs.
export async function chooseStreamPreview(VideoDecoder, shareCodec, shape = null) {
  if (behindThisRun) {
    return { mode: 'jpeg', reason: `a ${STREAM_BEHIND} earlier in this run of the app` }
  }
  const codec = STREAM_PROBE_CODECS[shareCodec]
  if (!codec) return { mode: 'jpeg', reason: `no stream preview for ${shareCodec}` }
  if (typeof VideoDecoder?.isConfigSupported !== 'function') {
    return { mode: 'jpeg', reason: 'no WebCodecs VideoDecoder' }
  }
  for (const hardwareAcceleration of ACCELERATIONS) {
    try {
      const answer = await VideoDecoder.isConfigSupported({
        codec,
        optimizeForLatency: true,
        hardwareAcceleration
      })
      if (answer?.supported !== true) continue
      if (hardwareAcceleration === 'no-preference' && pixelRate(shape) > SOFTWARE_PIXEL_RATE) {
        const { width, height, fps } = shape
        return {
          mode: 'jpeg',
          reason: `no hardware decoder for ${codec}, and ${width}x${height} at ${fps} is over 1080p at 60 for software`
        }
      }
      return { mode: 'stream', hardwareAcceleration }
    } catch {
      // Taken as a no.
    }
  }
  return { mode: 'jpeg', reason: `${codec} is not supported` }
}

// Decodes the stream preview's frames and draws the newest picture at the display's rate:
// the decoder's output only keeps the newest VideoFrame (the one it replaces is
// closed, counted as superseded), and an animation frame draws it, so drawing never queues and
// never runs more often than the display. Nothing is decoded before a key frame; the decoder is
// configured from the first key frame (and again when a key frame's codec string differs). It is
// behind when more than STREAM_QUEUE_LIMIT chunks have waited at every frame offered over
// STREAM_BEHIND_MS. The first time it is behind it is reset and a key frame is asked for
// (at most once every KEY_FRAME_ASK_MS; an ask that would come sooner is sent when that time is
// up, if still waiting); the second time it falls back with STREAM_BEHIND and marks this run.
// Any failure calls onFallback(reason) once, and nothing more is decoded.
//   VideoDecoder, EncodedVideoChunk   WebCodecs (fakes in tests)
//   hardwareAcceleration   what chooseStreamPreview found
//   draw(frame)      puts a VideoFrame on the canvas (it is closed after)
//   canDraw()        false once the share or its placeholder track is gone
//   askKeyFrame()    asks the sidecar for a key frame (a new preview request)
//   onFallback(reason)
//   now(), setTimer(fn, ms), clearTimer(id)   the clock, for tests
//   requestFrame(fn), cancelFrame(id)   the display's frame clock, for tests
// counts: received, decoded, drawn, superseded (replaced by a newer one before it was drawn),
// skipped (waiting for a key frame), late (canDraw() false), behind (passes of the limit),
// resets, keyAsks, timed (drawn by the timer, no animation frame came first).
export function createStreamPreviewDecoder({
  VideoDecoder,
  EncodedVideoChunk,
  hardwareAcceleration = 'no-preference',
  draw,
  canDraw,
  askKeyFrame,
  onFallback,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id)
}) {
  const counts = {
    received: 0,
    decoded: 0,
    drawn: 0,
    superseded: 0,
    skipped: 0,
    late: 0,
    behind: 0,
    resets: 0,
    keyAsks: 0,
    timed: 0
  }
  let codec = null
  let waitingForKey = true
  let failed = null
  let closed = false
  let lastAskAt = -Infinity
  let askTimer = null
  // Since when every frame offered found the queue over the limit, or null.
  let overSince = null
  // The newest decoded picture not drawn yet, and the animation frame that will draw it, and
  // the timer that draws it if no animation frame comes first.
  let kept = null
  let frameRequest = null
  let paintTimer = null

  const stop = () => {
    if (askTimer != null) clearTimer(askTimer)
    askTimer = null
    if (frameRequest != null) cancelFrame(frameRequest)
    frameRequest = null
    if (paintTimer != null) clearTimer(paintTimer)
    paintTimer = null
    kept?.close()
    kept = null
    try {
      if (decoder.state !== 'closed') decoder.close()
    } catch {
      // Closed already.
    }
  }
  const fail = (reason) => {
    if (failed || closed) return
    failed = reason
    stop()
    onFallback(reason)
  }
  // `byTimer`: the timer came first (an animation frame did not come in PAINT_TIMER_MS).
  const paint = (byTimer) => {
    if (frameRequest != null) cancelFrame(frameRequest)
    frameRequest = null
    if (paintTimer != null) clearTimer(paintTimer)
    paintTimer = null
    const frame = kept
    kept = null
    if (!frame) return
    try {
      if (!closed && !failed && canDraw()) {
        draw(frame)
        counts.drawn++
        if (byTimer) counts.timed++
      } else {
        counts.late++
      }
    } catch (err) {
      fail(`draw: ${err?.message ?? err}`)
    } finally {
      frame.close()
    }
  }
  const decoder = new VideoDecoder({
    output: (frame) => {
      counts.decoded++
      if (closed || failed) {
        counts.late++
        frame.close()
        return
      }
      if (kept) {
        kept.close()
        counts.superseded++
      }
      kept = frame
      if (frameRequest == null) frameRequest = requestFrame(() => paint(false))
      if (paintTimer == null) paintTimer = setTimer(() => paint(true), PAINT_TIMER_MS)
    },
    error: (err) => fail(`decoder: ${err?.message ?? err}`)
  })

  const ask = () => {
    askTimer = null
    if (closed || failed || !waitingForKey) return
    const wait = lastAskAt + KEY_FRAME_ASK_MS - now()
    if (wait > 0) {
      askTimer = setTimer(ask, wait)
      return
    }
    lastAskAt = now()
    counts.keyAsks++
    askKeyFrame()
  }

  const offer = (event) => {
    if (closed || failed) return
    counts.received++
    if (decoder.decodeQueueSize <= STREAM_QUEUE_LIMIT) overSince = null
    else overSince ??= now()
    if (overSince != null && now() - overSince >= STREAM_BEHIND_MS) {
      overSince = null
      counts.behind++
      // Behind twice in one share: the JPEGs, for this share and the rest of the run.
      // So the preview costs the viewers at most this share's one key frame ask.
      if (counts.behind > 1) {
        behindThisRun = true
        fail(STREAM_BEHIND)
        return
      }
      counts.resets++
      try {
        decoder.reset()
      } catch (err) {
        fail(`reset: ${err?.message ?? err}`)
        return
      }
      codec = null
      waitingForKey = true
      if (askTimer == null) ask()
    }
    const key = event?.key === true
    if (waitingForKey && !key) {
      counts.skipped++
      return
    }
    const data = base64Bytes(event?.data)
    if (!data) {
      fail('a frame that is not base64')
      return
    }
    if (key) {
      const wanted = streamCodecString(event.codec, data)
      if (!wanted) {
        fail(`a ${event.codec} key frame without its codec parameters`)
        return
      }
      if (wanted !== codec) {
        try {
          decoder.configure({ codec: wanted, optimizeForLatency: true, hardwareAcceleration })
        } catch (err) {
          fail(`configure ${wanted}: ${err?.message ?? err}`)
          return
        }
        codec = wanted
      }
      waitingForKey = false
    }
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: Math.round(Number(event.t_ms) * 1000) || 0,
          data
        })
      )
    } catch (err) {
      fail(`decode: ${err?.message ?? err}`)
    }
  }

  return {
    offer,
    close() {
      if (closed) return
      closed = true
      stop()
    },
    counts,
    get codec() {
      return codec
    },
    get failed() {
      return failed
    }
  }
}
