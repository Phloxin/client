import { startScreenAudio, onScreenAudioError } from '../screenAudio'
import { detachRtpSender } from '../mediaRecovery'
import { MUSIC_AUDIO_BITRATE } from '../micAudioProfile'
import { screenCodecOptionsFor, screenEncodingFor } from '../screenVideoProfile'
import { createSerialQueue } from '../serialQueue'
import {
  SCREEN_MUTE_STALL_MS,
  SCREEN_RECOVERY_STABILITY_MS,
  nextRecoveryDelay,
  screenRecoveryDecision,
  shouldRecoverOnMuteStall
} from './screenShareRecovery'
import { codecLabel, computeOutboundVideoSample } from '../streamStats'

let getDevice = () => null
let getProducerTransport = () => null
let getCallbacks = () => ({})
let closeServerProducer = async () => {}
let localProducerIds = new Set()

export function configureScreenShare(dependencies = {}) {
  if (dependencies.getDevice) getDevice = dependencies.getDevice
  if (dependencies.getProducerTransport) getProducerTransport = dependencies.getProducerTransport
  if (dependencies.getCallbacks) getCallbacks = dependencies.getCallbacks
  if (dependencies.closeServerProducer) closeServerProducer = dependencies.closeServerProducer
  if (dependencies.localProducerIds) localProducerIds = dependencies.localProducerIds
}

let screenShareCtx = null
const enqueueShareClaim = createSerialQueue()
const enqueueShareProduce = createSerialQueue()

// Native capture dying mid-share (utility process crash, PipeWire/WASAPI
// device loss) degrades the share to video-only instead of tearing it down:
// close the audio producer, surface the reason to the active channel UI.
onScreenAudioError(({ message }) => {
  console.error('[Soup] Screen audio capture failed:', message)
  const ctx = screenShareCtx
  if (!ctx || ctx.type !== 'screen') return

  const audioProducer = ctx.audioProducer
  ctx.audioProducer = null
  if (audioProducer) {
    const audioProducerId = audioProducer.id
    audioProducer.close()
    localProducerIds.delete(audioProducerId)
    void closeServerProducer(audioProducerId)
  }

  const nativeAudio = ctx.nativeAudio
  const audioTrack = ctx.audioTrack
  ctx.nativeAudio = null
  ctx.audioTrack = null
  audioTrack?.stop()
  nativeAudio?.stop().catch(() => {})
  if (isActiveShare(ctx) && ctx.producer) {
    getCallbacks().onScreenAudioError?.(message)
  }
})

// ─── Video codec + encoder tuning helpers (screen + camera) ──────
// SVC layering. 'L3' = 3 spatial layers (quarter → full res), 'T3' = 3
// temporal (fps) layers; '_KEY' shares the keyframe across spatial layers for
// cleaner switching. setVideoStreamRoles() forwards a given consumer only the
// layer its view needs. Cameras always use the full mode (native resolution,
// no picker choice).
const VIDEO_SCALABILITY_MODE = 'L3T3_KEY'

// Screen shares deliberately have only temporal SVC (never spatial SVC or
// simulcast): sharp text needs the whole bitrate budget at full resolution.
// AV1/VP9 may support up to three temporal layers; H.264 must always remain
// plain because MediaFoundation rejects scalabilityMode on its screen encoder.
const SCREEN_SVC_RUNGS = ['L1T3', 'L1T2', 'plain']
const SCREEN_SVC_VERDICT_PREFIX = 'screenSvcVerdict:'

function screenCodecMime(codec) {
  return codec?.mimeType?.toLowerCase() ?? ''
}

function supportsScreenTemporalSvc(codec) {
  return /^video\/(av1|vp9)$/i.test(codec?.mimeType ?? '')
}

function screenSvcRungsFor(codec, startRung) {
  const rungs = supportsScreenTemporalSvc(codec) ? SCREEN_SVC_RUNGS : ['plain']
  const startIndex = startRung == null ? 0 : rungs.indexOf(startRung)
  return startIndex >= 0 ? rungs.slice(startIndex) : rungs
}

// Chromium's WebRTC sender is the only path that can use temporal SVC. Keep
// screenEncodingFor() bitrate/framerate-only: the native AV1 screen encoder
// reuses that helper with its intentionally plain RTP encoding.
function chromiumScreenEncodingFor(codec, rung, { width, height, fps, optimizeFor }) {
  const encoding = screenEncodingFor({ width, height, fps, codec, optimizeFor })
  const scalabilityMode = supportsScreenTemporalSvc(codec) && rung !== 'plain' ? rung : undefined
  return scalabilityMode ? { ...encoding, scalabilityMode } : encoding
}

// A video codec from the loaded device's sending capabilities, by mime type.
// The codec passed to produce() MUST come from sendRtpCapabilities: the legacy
// rtpCapabilities getter aliases the receiving capabilities, whose H.264 profile
// variants may not match what this device can send. undefined (no match)
// preserves mediasoup's default (first router codec).
function findVideoCodec(mime) {
  return getDevice()?.sendRtpCapabilities?.codecs?.find(
    (c) => c.kind === 'video' && c.mimeType?.toLowerCase() === mime
  )
}

// Set once a share's measured encoder came up software for AV1/VP9 (see
// maybeDowngradeScreenCodec): future shares then start on H.264 directly instead
// of re-running ~9s of libaom pain each time. This is the capability check —
// driven by the encoder the machine actually produced, not GPU-model sniffing.
// ponytail: sticky for this renderer session once set; cleared by
// resetScreenCodecPreference() when the encoder landscape changes (e.g. the
// hardware-acceleration toggle) so AV1 is re-probed.
const SCREEN_H264_KEY = 'screenPreferH264'
const SCREEN_H264_CACHE_VERSION_KEY = 'screenPreferH264Version'

function screenSvcVerdictKey(codec) {
  const mime = screenCodecMime(codec)
  return supportsScreenTemporalSvc(codec) && mime ? `${SCREEN_SVC_VERDICT_PREFIX}${mime}` : null
}

// sessionStorage may be unavailable in unusual/private renderer contexts, so
// every access is guarded; these caches are best-effort optimizations only.
function sessionVerdict(key) {
  return {
    get() {
      try {
        return sessionStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(value) {
      try {
        sessionStorage.setItem(key, value)
      } catch {
        // Ignore; callers re-probe when the cache is missing.
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(key)
      } catch {
        // Ignore; the next renderer session re-probes.
      }
    }
  }
}

function cachedScreenSvcRung(codec) {
  const key = screenSvcVerdictKey(codec)
  if (!key) return null
  const rung = sessionVerdict(key).get()
  return screenSvcRungsFor(codec).includes(rung) ? rung : null
}

function cacheScreenSvcRung(codec, rung) {
  const key = screenSvcVerdictKey(codec)
  if (!key || !screenSvcRungsFor(codec).includes(rung)) return
  sessionVerdict(key).set(rung)
}

function clearScreenSvcRungStorage() {
  try {
    const keys = []
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)
      if (key?.startsWith(SCREEN_SVC_VERDICT_PREFIX)) keys.push(key)
    }
    for (const key of keys) sessionStorage.removeItem(key)
  } catch {
    // Best-effort cleanup; ignore when storage is unavailable.
  }
}

// This is an optimization, not durable hardware capability knowledge. GPU
// process startup, driver state, and feature flags can differ across app
// launches (especially the first launch after an update), so a software result
// must not permanently pin future processes to H.264. Keep the optimization for
// later shares in this renderer, but force every fresh renderer to probe AV1.
function clearScreenCodecPreferenceStorage() {
  try {
    // Remove values written by older builds which incorrectly persisted this
    // decision across app restarts.
    localStorage.removeItem(SCREEN_H264_KEY)
    localStorage.removeItem(SCREEN_H264_CACHE_VERSION_KEY)
    sessionStorage.removeItem(SCREEN_H264_KEY)
  } catch {
    // localStorage is unavailable only in unusual/private renderer contexts;
    // the normal codec probe still works without the optimization cache.
  }
  clearScreenSvcRungStorage()
}

clearScreenCodecPreferenceStorage()

function hasScreenCodecPreference() {
  return sessionVerdict(SCREEN_H264_KEY).get() === '1'
}

// Forget the session's "AV1 is software here → use H.264" verdict so the next
// share re-probes AV1 from scratch. Call when something that changes which
// encoders exist has changed — notably toggling hardware acceleration, after
// which AV1 that was software may now be hardware (or vice-versa).
export function resetScreenCodecPreference() {
  try {
    sessionStorage.removeItem(SCREEN_H264_KEY)
    localStorage.removeItem(SCREEN_H264_KEY)
    localStorage.removeItem(SCREEN_H264_CACHE_VERSION_KEY)
  } catch {
    // Ignore storage failures; the next renderer session will still probe AV1.
  }
  clearScreenSvcRungStorage()
}

// User-forced screen codec from PREFER_SCREENSHARE_CODEC=H264|AV1|VP9 (normalized
// in preload). When set, it overrides both the AV1-first default and the adaptive
// H.264 downgrade — the user explicitly asked for this codec, so we keep it even
// if it comes up software. undefined when unset/invalid.
const FORCED_SCREEN_CODEC_MIME = {
  H264: 'video/h264',
  AV1: 'video/av1',
  VP9: 'video/vp9'
}[(typeof window !== 'undefined' && window.api?.preferScreenshareCodec) || '']

function forcedScreenCodec() {
  return FORCED_SCREEN_CODEC_MIME ? findVideoCodec(FORCED_SCREEN_CODEC_MIME) : undefined
}

// Screen share prefers AV1 for efficiency, then VP9. Chromium AV1/VP9 starts on
// a temporal-SVC rung and falls through L1T3 → L1T2 → plain when needed; H.264
// always stays plain. Sender stats remain the final HW/SW verdict because a
// positive MediaCapabilities answer is not reliable on Windows/RDNA3.
function pickVideoCodec() {
  // An explicit PREFER_SCREENSHARE_CODEC wins outright when the router advertises
  // it; fall through to the normal selection if it's unavailable.
  const forced = forcedScreenCodec()
  if (forced) return forced
  if (hasScreenCodecPreference()) {
    return findVideoCodec('video/h264') ?? findVideoCodec('video/vp9')
  }
  return findVideoCodec('video/av1') ?? findVideoCodec('video/vp9')
}

// Camera codec verdicts are deliberately independent from screen verdicts. A
// renderer that had to use software AV1 for screenshare may still have a good
// hardware VP9 camera encoder (and vice versa). Keep this session-only so a
// different Chromium/GPU process gets a fresh probe.
const CAMERA_H264_KEY = 'cameraPreferH264'

function hasCameraCodecPreference() {
  return sessionVerdict(CAMERA_H264_KEY).get() === '1'
}

export function resetCameraCodecPreference() {
  sessionVerdict(CAMERA_H264_KEY).clear()
}

function cacheCameraCodecPreference() {
  sessionVerdict(CAMERA_H264_KEY).set('1')
}

// Webcam prefers VP9 for real spatial layer rationing, unless this renderer has
// already measured a software/struggling VP9 encoder. H.264 is the efficient
// hardware fallback and gets two simulcast encodings; AV1 remains a last
// compatibility fallback only.
function pickCameraCodec() {
  const vp9 = findVideoCodec('video/vp9')
  const h264 = findVideoCodec('video/h264')
  const av1 = findVideoCodec('video/av1')
  if (hasCameraCodecPreference() && h264) return h264
  return vp9 ?? h264 ?? av1
}

// Log the codec the SFU actually negotiated, and warn when it's one without
// spatial SVC. VP8/H264 have no spatial layers, so 'L3T3_KEY' degrades to
// temporal-only and setVideoStreamRoles() can't tier thumbnail/focus resolution.
function logNegotiatedVideoCodec(producer, scalabilityMode) {
  const mimeType = producer.rtpParameters?.codecs?.find(
    (c) => !c.mimeType?.toLowerCase().endsWith('/rtx')
  )?.mimeType
  console.log('[Soup] Video codec negotiated:', mimeType)

  // Spatial layer count is the 'L' number in the mode (e.g. 'L3T3_KEY' → 3).
  const spatialLayers = Number(/^L(\d+)/.exec(scalabilityMode ?? '')?.[1] ?? 1)
  if (spatialLayers > 1 && /^video\/(vp8|h264)$/i.test(mimeType ?? '')) {
    console.warn(
      `[Soup] ${mimeType} has no spatial SVC — thumbnail/focus resolution tiering ` +
        'will not work (temporal layers only).'
    )
  }
}

// Poll the video sender's outbound-rtp stats every 3s and report to onStats:
// codec + whether the encoder is hardware or software (encoderImplementation, e.g.
// 'libaom' = software AV1) for the sharer's HW/SW tile badge, and qualityLimitationReason
// ('cpu' = the encoder can't keep up) which drives maybeDowngradeScreenCodec.
// Also logged in dev. Returns a stop function; only the most recent share is
// polled.
let encoderStatsStop = null
function startEncoderStatsLog(producer, onStats) {
  encoderStatsStop?.()
  const sender = producer.rtpSender
  if (!sender?.getStats) return
  const previousByOutboundId = new Map()
  const id = setInterval(async () => {
    try {
      const stats = await sender.getStats()
      const sample = computeOutboundVideoSample(stats, previousByOutboundId)
      if (!sample) return

      if (import.meta.env.DEV) {
        console.log(
          `[Soup] encoder: ${sample.implementation ?? '?'} ` +
            `(${sample.activeEncodings} active encoding${sample.activeEncodings === 1 ? '' : 's'})` +
            ` | limited by: ${sample.qualityLimitationReason ?? '?'}` +
            ` | ${sample.width ?? '?'}x${sample.height ?? '?'}` +
            `@${Math.round(sample.fps ?? 0)}fps` +
            (sample.encodeMsPerFrame != null
              ? ` | ${sample.encodeMsPerFrame.toFixed(1)}ms/frame`
              : '') +
            (sample.sendKbps != null ? ` | ${sample.sendKbps.toFixed(0)}kbps` : '') +
            (sample.rttMs != null ? ` | RTT ${sample.rttMs.toFixed(0)}ms` : '')
        )
      }

      onStats?.({ codec: codecLabel(producer.rtpParameters), ...sample })
    } catch {
      // getStats can reject transiently around teardown — ignore.
    }
  }, 3000)
  const stop = () => {
    clearInterval(id)
    if (encoderStatsStop === stop) encoderStatsStop = null
  }
  encoderStatsStop = stop
  return stop
}

// ─── Adaptive screen-share SVC fallback ──────────────────────────
// AV1/VP9 start at L1T3 and use an explicit rung state machine. A hard
// produce()/setParameters() failure tries the next rung with the same capture
// track; a software verdict first steps down within the codec, and only a plain
// unforced AV1/VP9 share falls to H.264. Sustained CPU pressure retains its
// existing direct H.264 fallback. Each successful rung is cached per session.
const CPU_STRIKES_TO_DOWNGRADE = 3 // ~3 polls × 3s ≈ 9s of sustained cpu limiting
const SCREEN_FALLBACK_BASE_COOLDOWN_MS = 5000
const SCREEN_FALLBACK_MAX_COOLDOWN_MS = 300_000

function shareSupersededError() {
  const error = new Error('Screen share request was superseded')
  error.code = 'SCREEN_SHARE_SUPERSEDED'
  return error
}

function isShareSupersededError(error) {
  return error?.code === 'SCREEN_SHARE_SUPERSEDED'
}

function isActiveShare(ctx) {
  return screenShareCtx === ctx && !ctx.stopped
}

function screenRungKey(codec, rung) {
  return `${screenCodecMime(codec) || '__default__'}:${rung}`
}

function isScreenRungRejected(ctx, codec, rung) {
  return ctx.rejectedScreenRungs?.has(screenRungKey(codec, rung))
}

function rejectScreenRung(ctx, codec, rung) {
  ctx.rejectedScreenRungs?.add(screenRungKey(codec, rung))
}

function resetScreenFallbackCooldown(ctx) {
  ctx.fallbackFailureCount = 0
  ctx.fallbackCooldownUntil = 0
}

function armScreenFallbackCooldown(ctx) {
  const failureCount = ctx.fallbackFailureCount ?? 0
  const delay = Math.min(
    SCREEN_FALLBACK_MAX_COOLDOWN_MS,
    SCREEN_FALLBACK_BASE_COOLDOWN_MS * 2 ** Math.min(failureCount, 8)
  )
  ctx.fallbackFailureCount = failureCount + 1
  ctx.fallbackCooldownUntil = Date.now() + delay
  console.warn(`[Soup] Screen fallback cooling down for ${delay}ms`)
}

function screenFallbackIsCoolingDown(ctx) {
  return Date.now() < (ctx.fallbackCooldownUntil ?? 0)
}

// Serialize mediasoup produce operations for the single local video-share slot.
// If ownership changes during the await, close only the producer just created;
// never call a global teardown that could belong to the successor share.
function produceForShare(ctx, options) {
  let rejectedAttemptSender = null
  const result = enqueueShareProduce(async () => {
    try {
      if (!isActiveShare(ctx)) throw shareSupersededError()
      const producer = await ctx.transport.produce({
        ...options,
        // Chrome creates the transceiver before later SDP work can reject. The
        // callback is invoked before that work, so keep the sender outside the
        // mediasoup Producer as a cleanup handle for handler-level failures.
        onRtpSender: (sender) => {
          rejectedAttemptSender = sender
          options.onRtpSender?.(sender)
        }
      })
      if (!isActiveShare(ctx)) {
        await discardUnadoptedShareProducer(producer)
        throw shareSupersededError()
      }
      return producer
    } catch (error) {
      if (rejectedAttemptSender) {
        try {
          await detachRtpSender(rejectedAttemptSender)
        } catch (detachError) {
          console.warn('[Soup] Failed to detach rejected screen RTP sender:', detachError)
        }
      }
      throw error
    }
  })

  return result
}

function screenEncodingCapabilityError(codec) {
  const error = new Error(
    `No viable screen encoding rung for ${codec?.mimeType ?? 'the default codec'}`
  )
  error.code = 'SCREEN_ENCODING_CAPABILITY_REJECTED'
  return error
}

// MediaCapabilities is only a negative pre-hint. Positive answers are known to
// be unreliable on Windows/RDNA3, so every accepted rung still goes through the
// sender-stats verdict. A forced codec intentionally bypasses this optimization.
async function hasNegativeScreenEncodingCapabilityHint(ctx, codec, encoding) {
  if (!supportsScreenTemporalSvc(codec) || forcedScreenCodec()) return false
  const mediaCapabilities = globalThis.navigator?.mediaCapabilities
  if (typeof mediaCapabilities?.encodingInfo !== 'function') return false

  try {
    const info = await mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: codec.mimeType,
        width: Math.max(1, Math.round(ctx.width)),
        height: Math.max(1, Math.round(ctx.height)),
        framerate: encoding.maxFramerate,
        bitrate: encoding.maxBitrate,
        ...(encoding.scalabilityMode ? { scalabilityMode: encoding.scalabilityMode } : {})
      }
    })
    const negative = info?.supported === false || info?.powerEfficient === false
    if (negative) {
      console.warn(
        `[Soup] Skipping ${codec.mimeType} ${encoding.scalabilityMode ?? 'plain'} screen rung ` +
          'from negative MediaCapabilities hint'
      )
    }
    return negative
  } catch {
    // Unsupported query fields or browser errors are deliberately not a verdict.
    return false
  }
}

function screenProducerOptions(ctx, codec, encoding) {
  let sender = null
  return {
    track: ctx.track,
    codec,
    encodings: [encoding],
    // A failed produce/parameter attempt must not end the capture track: the
    // next SVC rung reuses it, and stopShareContext() remains its sole owner.
    stopTracks: false,
    codecOptions: screenCodecOptionsFor(encoding),
    onRtpSender: (rtpSender) => {
      sender = rtpSender
    },
    appData: {
      produced: 'ScreenShare',
      beforeServerProduce: async (rtpParameters) => {
        await setSenderDegradationPreference(
          sender,
          ctx.optimizeFor === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
          { strict: true }
        )
        confirmScreenRung(rtpParameters, sender, encoding)
      }
    }
  }
}

async function discardUnadoptedShareProducer(producer) {
  try {
    producer.close()
  } finally {
    await closeServerProducer(producer.id)
  }
}

function screenRungExhaustedError(codec) {
  const error = new Error(
    `All screen encoding rungs were rejected for ${codec?.mimeType ?? 'the default codec'}`
  )
  error.code = 'SCREEN_ENCODING_RUNGS_EXHAUSTED'
  return error
}

// Try a codec's temporal-SVC ladder from the requested rung down to plain.
// Each candidate is fully configured before it is returned, so a failed
// produce()/setParameters() never consumes the shared capture track or becomes
// the active producer.
async function produceScreenWithFallback(ctx, codec, { startRung } = {}) {
  const firstRung = startRung ?? cachedScreenSvcRung(codec) ?? screenSvcRungsFor(codec)[0]
  const rungs = screenSvcRungsFor(codec, firstRung).filter(
    (rung) => !isScreenRungRejected(ctx, codec, rung)
  )
  if (rungs.length === 0) throw screenRungExhaustedError(codec)
  let lastError = null

  for (const rung of rungs) {
    const encoding = chromiumScreenEncodingFor(codec, rung, ctx)
    if (await hasNegativeScreenEncodingCapabilityHint(ctx, codec, encoding)) {
      rejectScreenRung(ctx, codec, rung)
      lastError = screenEncodingCapabilityError(codec)
      continue
    }

    let producer
    try {
      producer = await produceForShare(ctx, screenProducerOptions(ctx, codec, encoding))
      if (!isActiveShare(ctx) || ctx.track?.readyState === 'ended') {
        throw shareSupersededError()
      }
      cacheScreenSvcRung(codec, rung)
      return { producer, codec, rung, encoding }
    } catch (error) {
      if (producer) await discardUnadoptedShareProducer(producer)
      if (isShareSupersededError(error)) throw error
      rejectScreenRung(ctx, codec, rung)
      lastError = error
      console.warn(
        `[Soup] Screen ${codec?.mimeType ?? 'default'} ${rung} rung failed; trying the next rung:`,
        error
      )
    }
  }

  throw lastError ?? screenEncodingCapabilityError(codec)
}

function uniqueCodecsByMime(codecs) {
  const seen = new Set()
  return codecs.filter((codec) => {
    if (!codec) return false
    // Preserve mediasoup's default-codec path for routers that advertise none
    // of our explicit AV1/VP9/H.264 candidates.
    const mime = screenCodecMime(codec) || '__default__'
    if (seen.has(mime)) return false
    seen.add(mime)
    return true
  })
}

// Try each candidate codec in order until one produces. Superseded errors abort
// the whole walk; any other failure is warned and remembered so the last one is
// rethrown when no codec works.
async function produceWithCodecFallback(codecs, attemptFn, { label, noCodecMessage }) {
  let lastError = null

  for (const codec of codecs) {
    try {
      return await attemptFn(codec)
    } catch (error) {
      if (isShareSupersededError(error)) throw error
      lastError = error
      console.warn(`[Soup] ${label} codec ${codec?.mimeType ?? 'default'} could not start:`, error)
    }
  }

  throw lastError ?? new Error(noCodecMessage)
}

// A pre-produce failure may mean AV1/VP9 is advertised but unavailable in this
// Chromium process. Exhaust that codec's rung ladder first, then try the next
// compatible codec. An explicit PREFER_SCREENSHARE_CODEC never leaves its codec.
function produceInitialScreenWithFallback(ctx, initialCodec) {
  const forced = forcedScreenCodec()
  const codecs = uniqueCodecsByMime(
    forced ? [forced] : [initialCodec, findVideoCodec('video/vp9'), findVideoCodec('video/h264')]
  )
  return produceWithCodecFallback(codecs, (codec) => produceScreenWithFallback(ctx, codec), {
    label: 'Screen',
    noCodecMessage: 'No supported screen-share video codec is available'
  })
}

// Make a freshly produced candidate the context's active producer: stop the old
// stats poller, apply the caller's per-type ctx state, then close the previous
// producer WITHOUT a server CloseProducer — producing a ScreenShare/Camera
// atomically replaces its server-side predecessor, so an explicit close of
// previous.id would return NotFound and desync the signaling FIFO.
function adoptShareProducer(ctx, candidate, { applyState, scalabilityMode, onStats }) {
  const previous = ctx.producer
  ctx.statsStop?.()
  ctx.statsStop = null
  ctx.producer = candidate.producer
  applyState?.(ctx, candidate)
  localProducerIds.add(candidate.producer.id)

  if (previous && previous !== candidate.producer) {
    previous.close()
    localProducerIds.delete(previous.id)
    ctx.onProducerReplaced?.({
      previousProducerId: previous.id,
      producerId: candidate.producer.id,
      codec: codecLabel(candidate.producer.rtpParameters)
    })
  }

  logNegotiatedVideoCodec(candidate.producer, scalabilityMode)
  ctx.statsStop = startEncoderStatsLog(candidate.producer, (stats) => {
    // A getStats() call already in flight for the replaced producer may finish
    // after its interval is cleared. Do not let that stale software verdict skip
    // a freshly selected SVC rung.
    if (ctx.producer !== candidate.producer) return
    onStats(ctx, stats)
  })
}

function adoptScreenProducer(ctx, candidate) {
  adoptShareProducer(ctx, candidate, {
    applyState: (share, adopted) => {
      share.screenCodec = adopted.codec
      share.screenSvcRung = adopted.rung
      share.cpuStrikes = 0
      resetScreenFallbackCooldown(share)
    },
    scalabilityMode: candidate.encoding.scalabilityMode,
    onStats: screenStatsHandler
  })
}

function nextScreenSvcRung(ctx) {
  const rungs = screenSvcRungsFor(ctx.screenCodec)
  const current = rungs.includes(ctx.screenSvcRung) ? ctx.screenSvcRung : 'plain'
  const index = rungs.indexOf(current)
  if (index < 0) return null
  return (
    rungs.slice(index + 1).find((rung) => !isScreenRungRejected(ctx, ctx.screenCodec, rung)) ?? null
  )
}

async function stepDownScreenSvcRung(ctx, reason) {
  const nextRung = nextScreenSvcRung(ctx)
  if (!nextRung) return false

  try {
    const candidate = await produceScreenWithFallback(ctx, ctx.screenCodec, { startRung: nextRung })
    if (!isActiveShare(ctx)) {
      await discardUnadoptedShareProducer(candidate.producer)
      throw shareSupersededError()
    }
    adoptScreenProducer(ctx, candidate)
    console.log(
      `[Soup] Screen ${ctx.screenCodec?.mimeType ?? 'default'} stepped down to ${candidate.rung} ` +
        `(${reason}) [id:${candidate.producer.id}]`
    )
    return true
  } catch (error) {
    if (isShareSupersededError(error)) throw error
    console.warn('[Soup] Screen SVC rungs exhausted; considering codec fallback:', error)
    return false
  }
}

async function stopShareContext(ctx, { notifyServer = true } = {}) {
  if (!ctx || ctx.stopped) return ctx?.stopPromise
  ctx.stopped = true
  if (screenShareCtx === ctx) screenShareCtx = null

  // Remove the watchdogs first so stopping the tracks below doesn't look
  // like a capture failure and trigger recovery.
  clearScreenRecoveryTimers(ctx)
  detachScreenTrackWatch(ctx)
  detachWindowFollow(ctx)

  ctx.statsStop?.()
  ctx.statsStop = null

  const videoProducer = ctx.producer
  const audioProducer = ctx.audioProducer
  ctx.producer = null
  ctx.audioProducer = null

  const producerIds = []
  if (videoProducer) {
    videoProducer.close()
    localProducerIds.delete(videoProducer.id)
    producerIds.push(videoProducer.id)
  }
  if (audioProducer) {
    audioProducer.close()
    localProducerIds.delete(audioProducer.id)
    producerIds.push(audioProducer.id)
  }

  const ownedTracks = new Set(ctx.stream?.getTracks?.() ?? [])
  if (ctx.track) ownedTracks.add(ctx.track)
  if (ctx.audioTrack) ownedTracks.add(ctx.audioTrack)
  const nativeAudio = ctx.nativeAudio
  ctx.stream = null
  ctx.track = null
  ctx.audioTrack = null
  ctx.nativeAudio = null
  for (const track of ownedTracks) track.stop()

  if (notifyServer) void Promise.all(producerIds.map((id) => closeServerProducer(id)))

  ctx.stopPromise = (async () => {
    if (!nativeAudio) return
    await nativeAudio
      .stop()
      .catch((error) =>
        console.warn('[Soup] Failed to stop owned native screen audio cleanly:', error)
      )
  })()
  return ctx.stopPromise
}

function claimShareContext(ctx) {
  return enqueueShareClaim(async () => {
    if (screenShareCtx) await stopShareContext(screenShareCtx)
    screenShareCtx = ctx
  })
}

// Composed stats sink for the screen producer: feeds the UI badge and the downgrade.
function screenStatsHandler(ctx, stats) {
  if (!isActiveShare(ctx)) return
  ctx.onEncoderStats?.(stats)
  void maybeDowngradeScreenCodec(ctx, stats)
}

async function downgradeScreenCodecToH264(ctx, { softwareEncoder, reason }) {
  if (isH264Codec(ctx.producer?.rtpParameters?.codecs?.[0])) return false

  const h264 = findVideoCodec('video/h264')
  if (!h264) return false

  const candidate = await produceScreenWithFallback(ctx, h264, { startRung: 'plain' })
  if (!isActiveShare(ctx)) {
    await discardUnadoptedShareProducer(candidate.producer)
    throw shareSupersededError()
  }
  adoptScreenProducer(ctx, candidate)

  // Only an observed software encoder proves that this renderer should skip
  // AV1/VP9 next time. CPU pressure alone must not create that preference.
  if (softwareEncoder) {
    sessionVerdict(SCREEN_H264_KEY).set('1')
  }
  console.log(`[Soup] Screen codec downgraded to H264 (${reason}) [id:${candidate.producer.id}]`)
  return true
}

async function maybeDowngradeScreenCodec(ctx, stats) {
  if (
    !isActiveShare(ctx) ||
    !ctx.producer ||
    ctx.screenTransition ||
    screenFallbackIsCoolingDown(ctx)
  )
    return

  if (isH264Codec(ctx.producer.rtpParameters?.codecs?.[0])) return // already on the lightest codec

  const softwareEncoder = stats.hardware === false
  if (softwareEncoder) {
    // A measured software encoder may be caused by the SVC rung itself. Lower
    // that rung before abandoning AV1/VP9 for H.264.
    ctx.cpuStrikes = CPU_STRIKES_TO_DOWNGRADE
  } else {
    // Hardware (or not-yet-known) encoder: only step down under sustained cpu
    // limitation. Decay rather than reset so cpu/bandwidth oscillation cannot
    // avoid a needed fallback forever.
    ctx.cpuStrikes =
      stats.qualityLimitationReason === 'cpu' ? ctx.cpuStrikes + 1 : Math.max(0, ctx.cpuStrikes - 1)
  }
  if (ctx.cpuStrikes < CPU_STRIKES_TO_DOWNGRADE) return

  const forced = forcedScreenCodec()
  const nextRung = nextScreenSvcRung(ctx)
  // Preserve the existing forced-codec contract for CPU pressure: only a
  // measured software encoder walks the SVC ladder, and forced shares never
  // auto-switch to H.264.
  if (forced && !softwareEncoder) return
  if (forced && !nextRung) {
    armScreenFallbackCooldown(ctx)
    return
  }
  if (!forced && !nextRung) {
    const h264 = findVideoCodec('video/h264')
    if (!h264 || isScreenRungRejected(ctx, h264, 'plain')) {
      armScreenFallbackCooldown(ctx)
      return
    }
  }
  const reason = softwareEncoder ? 'software encoder' : 'cpu limited'
  const transition = (async () => {
    if (softwareEncoder && nextRung && (await stepDownScreenSvcRung(ctx, reason))) return
    // Forced-codec mode can lose temporal SVC rungs but may never switch codec.
    if (forced) {
      armScreenFallbackCooldown(ctx)
      return
    }
    const downgraded = await downgradeScreenCodecToH264(ctx, { softwareEncoder, reason })
    if (!downgraded) armScreenFallbackCooldown(ctx)
  })()
  ctx.screenTransition = transition

  try {
    await transition
  } catch (error) {
    if (isShareSupersededError(error)) return
    // Keep the current producer if every candidate failed; a later stats sample
    // should wait for the backoff before considering another transition.
    console.warn('[Soup] Screen fallback transition failed; keeping current producer:', error)
    armScreenFallbackCooldown(ctx)
    if (!softwareEncoder) ctx.cpuStrikes = 0
  } finally {
    if (ctx.screenTransition === transition) ctx.screenTransition = null
  }
}

function confirmScreenRung(rtpParameters, sender, encoding) {
  const expected = encoding.scalabilityMode
  if (!expected) return

  const negotiated = rtpParameters?.encodings?.[0]?.scalabilityMode
  let senderMode
  try {
    senderMode = sender?.getParameters?.().encodings?.[0]?.scalabilityMode
  } catch {
    // The negotiated RTP parameters below are still useful if sender readback
    // is unavailable in this browser.
  }
  const actual = senderMode ?? negotiated
  if (actual !== expected) {
    const error = new Error(`Screen sender selected ${actual ?? 'plain'} instead of ${expected}`)
    error.code = 'SCREEN_SCALABILITY_MODE_MISMATCH'
    throw error
  }
}

// Bias how the encoder sheds quality under CPU/bandwidth pressure, via the RTP
// sender's top-level degradationPreference. Mirrors the audio setParameters path
// (getParameters → mutate → setParameters). Strict mode is used while probing a
// screen rung: a rejected parameter update must reject that rung, not be cached.
async function setSenderDegradationPreference(sender, preference, { strict = false } = {}) {
  if (!sender) {
    const error = new Error('Screen producer has no RTP sender')
    if (strict) throw error
    console.warn('[Soup] Failed to set degradationPreference:', error)
    return false
  }
  try {
    const params = sender.getParameters()
    params.degradationPreference = preference
    await sender.setParameters(params)
    return true
  } catch (error) {
    if (strict) throw error
    console.warn('[Soup] Failed to set degradationPreference:', error)
    return false
  }
}

async function setDegradationPreference(producer, preference, options) {
  return setSenderDegradationPreference(producer.rtpSender, preference, options)
}

// ─── Screen capture track recovery ───────────────────────────────
// On Windows, the shared window can get rebuilt (this happens around
// fullscreen transitions) which ends the capture even though the window is
// still there. Rather than treating that as the user stopping the share, this
// section re-acquires the capture and swaps the new track into the existing
// producer with replaceTrack(), so the share keeps running. The retry policy
// lives in screenShareRecovery.js so it can be tested on its own.

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unrecoverableSourceError() {
  const error = new Error('The shared source could not be re-resolved')
  error.code = 'SCREEN_SOURCE_UNRECOVERABLE'
  return error
}

function recoveryState(ctx) {
  return {
    active: isActiveShare(ctx),
    type: ctx.type,
    sourceId: ctx.sourceId,
    recovering: ctx.recovering,
    attempts: ctx.recoveryAttempts ?? 0
  }
}

function clearScreenRecoveryTimers(ctx) {
  if (ctx.muteTimer) clearTimeout(ctx.muteTimer)
  if (ctx.stabilityTimer) clearTimeout(ctx.stabilityTimer)
  ctx.muteTimer = null
  ctx.stabilityTimer = null
}

function detachScreenTrackWatch(ctx) {
  const watch = ctx.trackWatch
  ctx.trackWatch = null
  if (!watch) return
  for (const [event, handler] of Object.entries(watch.handlers)) {
    watch.track.removeEventListener(event, handler)
  }
}

// Installs the capture watchdogs on a track, at the start of a share and
// again after each recovery.
function watchScreenTrack(ctx, track) {
  detachScreenTrackWatch(ctx)

  const handlers = {
    // The capture itself ended, for example the window closed or permission
    // was revoked. Try to recover it.
    ended: () => {
      if (ctx.track !== track) return
      void recoverScreenShare(ctx, 'track-ended')
    },
    // Frames stopped arriving even though the track is still alive, which is
    // one symptom of the Windows fullscreen bug. A generous timeout avoids
    // false positives on genuinely static content.
    mute: () => {
      if (ctx.track !== track) return
      if (ctx.muteTimer) clearTimeout(ctx.muteTimer)
      ctx.muteTimer = setTimeout(() => {
        ctx.muteTimer = null
        if (ctx.track !== track) return
        if (!shouldRecoverOnMuteStall({ muted: track.muted, ...recoveryState(ctx) })) return
        console.warn(`[Soup] Screen capture delivered no frames for ${SCREEN_MUTE_STALL_MS}ms`)
        void recoverScreenShare(ctx, 'frames-stalled')
      }, SCREEN_MUTE_STALL_MS)
    },
    unmute: () => {
      if (ctx.muteTimer) clearTimeout(ctx.muteTimer)
      ctx.muteTimer = null
    }
  }

  for (const [event, handler] of Object.entries(handlers)) {
    track.addEventListener(event, handler)
  }
  ctx.trackWatch = { track, handlers }
}

// ─── Window following ────────────────────────────────────────────
// The main process watches the shared window and moves the share onto the
// window that replaces it - a game opening out of its client, and that client
// coming back when the game exits (see main/windowFollow.js). Moving the
// share means re-acquiring the source and swapping the track in, which is
// exactly what recovery already does, so this just runs the same path.

function watchWindowFollow(ctx) {
  const ipc = window.electron?.ipcRenderer
  if (!ipc) return
  ctx.followWatch = ipc.on('screen-follow', (_, { name } = {}) => {
    if (!isActiveShare(ctx)) return
    console.log(`[Soup] Shared window moved to "${name}"`)
    void recoverScreenShare(ctx, 'window-follow')
  })
}

function detachWindowFollow(ctx) {
  ctx.followWatch?.()
  ctx.followWatch = null
  // Main polls for as long as a share is running, and only the renderer knows
  // that this one has ended.
  if (ctx.type === 'screen') window.electron?.ipcRenderer?.send('end-screen-share')
}

// Resets the recovery attempt count once a share has run stably for a while,
// so repeated fullscreen toggles over a long stream don't exhaust it.
function scheduleRecoveryStabilityReset(ctx) {
  if (ctx.stabilityTimer) clearTimeout(ctx.stabilityTimer)
  ctx.stabilityTimer = setTimeout(() => {
    ctx.stabilityTimer = null
    if (!isActiveShare(ctx)) return
    ctx.recoveryAttempts = 0
  }, SCREEN_RECOVERY_STABILITY_MS)
}

// Tears the share down as if the user stopped it, and tells the caller why so
// it can clear the self tile and show a message.
async function finalStopShare(ctx, reason) {
  const notify = isActiveShare(ctx)
  await stopShareContext(ctx)
  if (notify) ctx.onShareEnded?.(reason)
}

// A single re-acquire attempt. Returns true when the recovery loop should
// stop, either because the track was swapped in or because this share is no
// longer active. Throws when the attempt failed but can be retried.
async function attemptScreenRecovery(ctx, reason) {
  const resolved = await window.electron?.ipcRenderer?.invoke('resolve-screen-source', {
    previousSourceId: ctx.sourceId
  })
  if (!isActiveShare(ctx)) return true
  // No match was found, or this platform can't retry without popping a
  // picker dialog. Either way, let the caller stop the share.
  if (!resolved?.recoverable) throw unrecoverableSourceError()

  const { width, height, fps } = ctx.requestedVideo
  // Only video is requested here. The audio producer keeps running
  // separately, so asking for loopback again would create a duplicate.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: fps, max: fps },
      width: { ideal: width, max: width },
      height: { ideal: height, max: height }
    },
    audio: false
  })
  const track = stream.getVideoTracks()[0]
  // The share may have been stopped or replaced while we were waiting on
  // the picker. Just release the tracks this attempt created.
  if (!isActiveShare(ctx) || !ctx.producer) {
    stream.getTracks().forEach((ownedTrack) => ownedTrack.stop())
    return true
  }
  if (!track) {
    stream.getTracks().forEach((ownedTrack) => ownedTrack.stop())
    throw new Error('The re-resolved source did not provide a video track')
  }

  track.contentHint = ctx.optimizeFor === 'motion' ? 'motion' : 'detail'
  // replaceTrack only re-points the sender, so the producer and its stats
  // keep running. The encoder sends a fresh keyframe on its own, so viewers
  // just see the picture resume.
  await ctx.producer.replaceTrack({ track })
  if (!isActiveShare(ctx)) {
    track.stop()
    return true
  }

  const previousTrack = ctx.track
  // Detach the watchdogs first, or the old track's 'ended' event would
  // trigger recovery for a track we're intentionally discarding.
  detachScreenTrackWatch(ctx)
  ctx.track = track
  ctx.sourceId = resolved.sourceId ?? ctx.sourceId
  // Swap the track inside the existing streams, so nothing downstream (the
  // video element, React state) needs to change.
  if (previousTrack) {
    ctx.stream?.removeTrack(previousTrack)
    ctx.previewStream?.removeTrack(previousTrack)
  }
  ctx.stream?.addTrack(track)
  ctx.previewStream?.addTrack(track)
  previousTrack?.stop()

  watchScreenTrack(ctx, track)
  scheduleRecoveryStabilityReset(ctx)
  console.log(`[Soup] Screen capture recovered after ${reason}`)
  return true
}

async function recoverScreenShare(ctx, reason) {
  const decision = screenRecoveryDecision(recoveryState(ctx))
  if (decision === 'ignore') return
  if (decision === 'final-stop') return finalStopShare(ctx, reason)

  ctx.recovering = true
  clearScreenRecoveryTimers(ctx)
  console.warn(`[Soup] Screen capture ${reason}; re-acquiring the shared source`)

  let recovered = false
  try {
    for (
      let delayMs = nextRecoveryDelay(ctx.recoveryAttempts);
      delayMs != null;
      delayMs = nextRecoveryDelay(ctx.recoveryAttempts)
    ) {
      ctx.recoveryAttempts += 1
      if (delayMs > 0) await wait(delayMs)
      if (!isActiveShare(ctx)) return

      try {
        if (await attemptScreenRecovery(ctx, reason)) {
          recovered = true
          return
        }
      } catch (error) {
        if (!isActiveShare(ctx)) return
        if (error?.code === 'SCREEN_SOURCE_UNRECOVERABLE') {
          console.warn('[Soup] Shared source is gone; ending the share:', error)
          break
        }
        console.warn('[Soup] Screen capture recovery attempt failed:', error)
      }
    }
  } finally {
    ctx.recovering = false
    // A successful recovery already returned above, so reaching here means
    // every attempt failed.
    if (!recovered && isActiveShare(ctx)) void finalStopShare(ctx, reason)
  }
}

// ─── Share screen ────────────────────────────────────────────────
// audioMode selects where screenshare audio comes from:
//   'app'                 native capture of the shared app only (audioTargets)
//   'system-exclude-self' native system capture minus our own audio
//   'system'              native whole-system capture
//   'system-legacy'       Chromium's loopback (rides the getDisplayMedia stream)
//   'none'                video only
// Native modes are produced from the audio-capture pipeline (screenAudio.js);
// only 'system-legacy' asks getDisplayMedia for audio.
export async function shareScreen({
  fps = 30,
  width = 1920,
  height = 1080,
  audioMode = 'none',
  audioTargets = null,
  // 'detail' (default) keeps text sharp, 'motion' favors smoothness — drives
  // the track contentHint and degradationPreference below.
  optimizeFor = 'detail',
  // Legacy boolean from the old picker API - maps to system-legacy loopback.
  audio = undefined,
  // Fires with { implementation, hardware } from encoder stats, ~3s after the
  // share starts, so the caller can show HW/SW on the self tile.
  onEncoderStats = undefined,
  // A fallback publishes a successor producer. The caller owns the self tile,
  // so it must replace its producer id for viewer bookkeeping to follow it.
  onProducerReplaced = undefined,
  // The source id this share was started with (null on Wayland, where the OS
  // picks it). Recovery uses it to re-resolve the same source later.
  sourceId = null,
  // Fires once with a reason when the share ends on its own, meaning the
  // capture failed and could not be recovered.
  onShareEnded = undefined
} = {}) {
  const transport = getProducerTransport()
  if (!transport) throw new Error('Not connected to voice')
  if (audio !== undefined && audioMode === 'none' && audio) audioMode = 'system-legacy'

  // Claim ownership before getDisplayMedia. A Stop/new share during the picker
  // invalidates this context; when the old prompt eventually resolves it can
  // release only its own returned tracks without touching the successor.
  const ctx = {
    type: 'screen',
    transport,
    stream: null,
    previewStream: null,
    track: null,
    audioTrack: null,
    nativeAudio: null,
    producer: null,
    audioProducer: null,
    statsStop: null,
    stopPromise: null,
    stopped: false,
    width,
    height,
    fps,
    // The original requested video settings, kept separate from width/height/fps
    // below (which get overwritten by the actual capture), so recovery asks
    // for the same constraints again rather than whatever one window gave.
    requestedVideo: { width, height, fps },
    sourceId,
    onShareEnded,
    // Recovery bookkeeping, see the recovery section above.
    recovering: false,
    recoveryAttempts: 0,
    trackWatch: null,
    muteTimer: null,
    stabilityTimer: null,
    // Unsubscribe for the 'screen-follow' listener, see window following above.
    followWatch: null,
    optimizeFor,
    onEncoderStats,
    cpuStrikes: 0,
    screenCodec: null,
    screenSvcRung: 'plain',
    screenTransition: null,
    rejectedScreenRungs: new Set(),
    fallbackFailureCount: 0,
    fallbackCooldownUntil: 0,
    onProducerReplaced
  }
  await claimShareContext(ctx)

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: fps, max: fps },
        width: { ideal: width, max: width },
        height: { ideal: height, max: height }
      },
      audio: audioMode === 'system-legacy'
    })

    if (!isActiveShare(ctx)) {
      stream.getTracks().forEach((ownedTrack) => ownedTrack.stop())
      throw shareSupersededError()
    }
    ctx.stream = stream

    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('The selected source did not provide a video track')
    ctx.track = track
    // Local preview is video-only, since playing back captured audio locally
    // would echo it. Stored on the context so recovery can swap the track in
    // place, leaving the caller's video element and React state untouched.
    ctx.previewStream = new MediaStream([track])
    // A capture that ends or stalls may be recoverable, so watch it instead
    // of tearing the share down directly. See the recovery section above.
    watchScreenTrack(ctx, track)
    watchWindowFollow(ctx)
    track.contentHint = optimizeFor === 'motion' ? 'motion' : 'detail'

    const settings = track.getSettings()
    ctx.width = settings.width > 0 ? settings.width : width
    ctx.height = settings.height > 0 ? settings.height : height
    ctx.fps = settings.frameRate > 0 ? Math.min(settings.frameRate, fps) : fps
    const screenCodec = pickVideoCodec()
    const screenEncoding = screenEncodingFor({
      width: ctx.width,
      height: ctx.height,
      fps: ctx.fps,
      codec: screenCodec,
      optimizeFor
    })
    console.log(
      `[Soup] Screen capture selected ${ctx.width}x${ctx.height}@${ctx.fps}fps, ` +
        `ceiling ${Math.round(screenEncoding.maxBitrate / 1000)}kbps`
    )

    const initialProducer = await produceInitialScreenWithFallback(ctx, screenCodec)
    if (!isActiveShare(ctx) || track.readyState === 'ended') {
      await discardUnadoptedShareProducer(initialProducer.producer)
      throw shareSupersededError()
    }
    adoptScreenProducer(ctx, initialProducer)
    console.log(
      `[Soup] Screen sharing ${initialProducer.codec?.mimeType ?? 'default'} ` +
        `${initialProducer.rung} [id:${initialProducer.producer.id}]`
    )

    // Screenshare audio: native capture for per-app/system modes, or the legacy
    // loopback track riding getDisplayMedia. Audio failure keeps video live.
    let audioTrack = null
    let nativeAudio = null
    if (audioMode === 'system-legacy') {
      audioTrack = stream.getAudioTracks()[0] ?? null
      if (!audioTrack) {
        const message = 'The selected capture source did not provide a system-audio track'
        console.error(`[Soup] ${message}; sharing video-only`)
        getCallbacks().onScreenAudioError?.(message)
      }
    } else if (audioMode !== 'none') {
      try {
        nativeAudio = await startScreenAudio({
          mode: audioMode,
          targets: audioTargets ?? undefined
        })
        if (!isActiveShare(ctx)) {
          await nativeAudio.stop().catch(() => {})
          throw shareSupersededError()
        }
        ctx.nativeAudio = nativeAudio
        audioTrack = nativeAudio.track
        console.log(`[Soup] Native screen audio capture started [backend:${nativeAudio.backend}]`)
      } catch (err) {
        if (isShareSupersededError(err) || !isActiveShare(ctx)) throw shareSupersededError()
        console.error('[Soup] Native screen audio failed, sharing video-only:', err)
        getCallbacks().onScreenAudioError?.(err.message)
      }
    }

    if (audioTrack) {
      ctx.audioTrack = audioTrack
      try {
        audioTrack.contentHint = 'music'
        const audioProducer = await produceForShare(ctx, {
          track: audioTrack,
          // Stereo + a real bitrate: captured app/system audio is music/media,
          // not speech, and the old mono default audibly degraded it. Shares the
          // hi-fi mic profile's ceiling (micAudioProfile.js) because it is the
          // same content class — the two must not drift apart.
          codecOptions: {
            opusStereo: true,
            opusDtx: false,
            opusFec: true,
            opusMaxAverageBitrate: MUSIC_AUDIO_BITRATE,
            opusPtime: 20
          },
          encodings: [{ maxBitrate: MUSIC_AUDIO_BITRATE }],
          appData: { produced: 'ScreenShareAudio' }
        })

        if (audioTrack.readyState === 'ended') {
          const failureAlreadyReported = ctx.audioTrack !== audioTrack
          audioProducer.close()
          await closeServerProducer(audioProducer.id)
          if (ctx.audioTrack === audioTrack) ctx.audioTrack = null
          if (ctx.nativeAudio === nativeAudio) ctx.nativeAudio = null
          audioTrack.stop()
          await nativeAudio?.stop().catch(() => {})
          if (!isActiveShare(ctx)) throw shareSupersededError()
          const message = 'Screen audio capture ended while starting'
          console.error(`[Soup] ${message}; sharing video-only`)
          if (!failureAlreadyReported) getCallbacks().onScreenAudioError?.(message)
        } else {
          ctx.audioProducer = audioProducer
          localProducerIds.add(audioProducer.id)
          audioTrack.addEventListener(
            'ended',
            () => {
              if (!isActiveShare(ctx) || ctx.audioTrack !== audioTrack) return
              ctx.audioTrack = null
              if (ctx.nativeAudio === nativeAudio) ctx.nativeAudio = null
              if (ctx.audioProducer === audioProducer) ctx.audioProducer = null
              audioProducer.close()
              localProducerIds.delete(audioProducer.id)
              void closeServerProducer(audioProducer.id)
              void nativeAudio?.stop().catch(() => {})
              if (isActiveShare(ctx) && ctx.producer) {
                getCallbacks().onScreenAudioError?.('Screen audio capture ended')
              }
            },
            { once: true }
          )
          console.log(`[Soup] Screen audio sharing [id:${audioProducer.id}]`)
        }
      } catch (err) {
        if (isShareSupersededError(err) || !isActiveShare(ctx)) throw shareSupersededError()
        const failureAlreadyReported = ctx.audioTrack !== audioTrack
        if (ctx.audioTrack === audioTrack) ctx.audioTrack = null
        if (ctx.nativeAudio === nativeAudio) ctx.nativeAudio = null
        audioTrack.stop()
        await nativeAudio
          ?.stop()
          .catch((stopErr) =>
            console.warn('[Soup] Failed to stop owned screen audio after produce failure:', stopErr)
          )
        if (!isActiveShare(ctx)) throw shareSupersededError()
        console.error('[Soup] Screen audio produce failed, sharing video-only:', err)
        if (!failureAlreadyReported) getCallbacks().onScreenAudioError?.(err.message)
      }
    }

    if (!isActiveShare(ctx) || !ctx.producer) throw shareSupersededError()

    return {
      id: ctx.producer.id,
      stream: ctx.previewStream,
      codec: codecLabel(ctx.producer.rtpParameters),
      stop: () => stopShareContext(ctx)
    }
  } catch (err) {
    await stopShareContext(ctx)
    throw err
  }
}

// ─── Camera codec probing and fallback ───────────────────────────
const CAMERA_FULL_MAX_BITRATE = 2_500_000
const CAMERA_THUMBNAIL_MAX_BITRATE = 300_000

function isH264Codec(codec) {
  return /video\/h264/i.test(codec?.mimeType ?? '')
}

function cameraEncodingsFor(codec, { simulcast = true } = {}) {
  if (isH264Codec(codec)) {
    return simulcast
      ? [
          { scaleResolutionDownBy: 4, maxBitrate: CAMERA_THUMBNAIL_MAX_BITRATE },
          { scaleResolutionDownBy: 1, maxBitrate: CAMERA_FULL_MAX_BITRATE }
        ]
      : [{ maxBitrate: CAMERA_FULL_MAX_BITRATE }]
  }

  // VP9 is the normal camera path. AV1 only reaches this helper when it is the
  // last codec advertised by an older/incomplete router, but it can use the same
  // spatial + temporal mode when available.
  return [{ maxBitrate: CAMERA_FULL_MAX_BITRATE, scalabilityMode: VIDEO_SCALABILITY_MODE }]
}

function cameraCodecCandidates(initialCodec) {
  const h264 = findVideoCodec('video/h264')
  const av1 = findVideoCodec('video/av1')
  return uniqueCodecsByMime(
    hasCameraCodecPreference() && h264 ? [h264, av1] : [initialCodec, h264, av1]
  )
}

function cameraProducerOptions(ctx, codec, encodings) {
  return {
    track: ctx.track,
    codec,
    encodings,
    // Camera fallback may retry on the same capture track. mediasoup otherwise
    // stops the supplied track when produce() rejects, preventing the retry.
    stopTracks: false,
    codecOptions: { videoGoogleStartBitrate: 1500 },
    appData: { produced: 'Camera' }
  }
}

// H.264 first tries the two-layer simulcast shape. A browser/handler that
// rejects that shape gets one full-resolution encoding on the same track.
async function produceCameraWithFallback(ctx, codec) {
  const encodingAttempts = isH264Codec(codec)
    ? [cameraEncodingsFor(codec), cameraEncodingsFor(codec, { simulcast: false })]
    : [cameraEncodingsFor(codec)]
  let lastError = null

  for (const encodings of encodingAttempts) {
    let producer
    try {
      producer = await produceForShare(ctx, cameraProducerOptions(ctx, codec, encodings))
      if (!isActiveShare(ctx) || ctx.track?.readyState === 'ended') {
        await discardUnadoptedShareProducer(producer)
        throw shareSupersededError()
      }
      return { producer, codec, encodings }
    } catch (error) {
      if (isShareSupersededError(error)) throw error
      if (producer) await discardUnadoptedShareProducer(producer)
      lastError = error
      console.warn(
        `[Soup] Camera ${codec?.mimeType ?? 'default'} ` +
          `${encodings.length} encoding attempt failed; trying the next shape:`,
        error
      )
    }
  }

  throw lastError ?? new Error(`No viable camera encoding for ${codec?.mimeType ?? 'default'}`)
}

function adoptCameraProducer(ctx, candidate) {
  adoptShareProducer(ctx, candidate, {
    applyState: (share, adopted) => {
      share.cameraCodec = adopted.codec
      share.cameraEncodings = adopted.encodings
    },
    scalabilityMode:
      candidate.encodings.length === 1 ? candidate.encodings[0].scalabilityMode : undefined,
    onStats: cameraStatsHandler
  })
}

async function downgradeCameraToH264(ctx) {
  if (!isActiveShare(ctx) || isH264Codec(ctx.cameraCodec)) return false
  const h264 = findVideoCodec('video/h264')
  if (!h264) return false

  const candidate = await produceCameraWithFallback(ctx, h264)
  if (!isActiveShare(ctx)) {
    await discardUnadoptedShareProducer(candidate.producer)
    throw shareSupersededError()
  }
  await setDegradationPreference(candidate.producer, 'maintain-framerate')
  // stopShareContext() can run while setParameters is pending. Do not adopt a
  // successor into an already-stopped context: it would no longer be owned by
  // the context and its server-side producer could outlive the share.
  if (!isActiveShare(ctx) || ctx.track?.readyState === 'ended') {
    await discardUnadoptedShareProducer(candidate.producer)
    throw shareSupersededError()
  }
  adoptCameraProducer(ctx, candidate)
  cacheCameraCodecPreference()
  console.log(`[Soup] Camera codec downgraded to H264 simulcast [id:${candidate.producer.id}]`)
  return true
}

function cameraStatsHandler(ctx, stats) {
  if (!isActiveShare(ctx)) return
  ctx.onEncoderStats?.(stats)
  if (
    ctx.cameraTransition ||
    ctx.cameraFallbackAttempted ||
    !ctx.producer ||
    !/^video\/vp9$/i.test(ctx.cameraCodec?.mimeType ?? '')
  )
    return

  // A measured libvpx/software VP9 result is the camera probe's negative
  // verdict. Unknown implementations are intentionally left alone, and the
  // verdict is only written after H.264 replacement succeeds.
  if (stats.hardware !== false) return
  ctx.cameraFallbackAttempted = true
  const transition = downgradeCameraToH264(ctx).catch((error) => {
    if (!isShareSupersededError(error)) {
      console.warn('[Soup] Camera H264 fallback failed; keeping VP9:', error)
    }
    return false
  })
  ctx.cameraTransition = transition
  void transition.finally(() => {
    if (ctx.cameraTransition === transition) ctx.cameraTransition = null
  })
}

// ─── Share webcam ────────────────────────────────────────────────
// Streams a camera device into the same producer slot as screen share, so the
// existing stop/preview/remote-render paths all apply. Camera capture is capped
// at an HD/30fps ideal to avoid opening a 4K-native webcam that the sender would
// immediately crush into its 2.5 Mbps ceiling.
export async function shareCamera(deviceId, onEncoderStats, onProducerReplaced = undefined) {
  const transport = getProducerTransport()
  if (!transport) throw new Error('Not connected to voice')
  const ctx = {
    type: 'camera',
    transport,
    stream: null,
    track: null,
    audioTrack: null,
    nativeAudio: null,
    producer: null,
    audioProducer: null,
    statsStop: null,
    stopPromise: null,
    stopped: false,
    onEncoderStats,
    onProducerReplaced,
    cameraCodec: null,
    cameraEncodings: null,
    cameraTransition: null,
    cameraFallbackAttempted: false
  }
  await claimShareContext(ctx)

  try {
    const videoConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false
    })
    if (!isActiveShare(ctx)) {
      stream.getTracks().forEach((ownedTrack) => ownedTrack.stop())
      throw shareSupersededError()
    }
    ctx.stream = stream

    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('The selected camera did not provide a video track')
    ctx.track = track
    track.onended = () => {
      void stopShareContext(ctx)
    }
    track.contentHint = 'motion'

    const cameraCodec = pickCameraCodec()
    const candidateCodecs = cameraCodecCandidates(cameraCodec)
    const initialCandidate = await produceWithCodecFallback(
      candidateCodecs,
      (codec) => produceCameraWithFallback(ctx, codec),
      { label: 'Camera', noCodecMessage: 'No supported camera video codec is available' }
    )

    await setDegradationPreference(initialCandidate.producer, 'maintain-framerate')
    if (!isActiveShare(ctx) || ctx.track !== track || track.readyState === 'ended') {
      await discardUnadoptedShareProducer(initialCandidate.producer)
      throw shareSupersededError()
    }
    adoptCameraProducer(ctx, initialCandidate)
    if (isH264Codec(initialCandidate.codec) && initialCandidate.encodings.length > 1) {
      console.log('[Soup] Camera sharing with H264 simulcast (thumbnail + full layers)')
    }

    const previewStream = new MediaStream([track])
    return {
      id: ctx.producer.id,
      stream: previewStream,
      codec: codecLabel(ctx.producer.rtpParameters),
      stop: () => stopShareContext(ctx)
    }
  } catch (err) {
    await stopShareContext(ctx)
    throw err
  }
}

// ─── Stop screen share ───────────────────────────────────────────
export async function stopScreenShare() {
  return enqueueShareClaim(async () => {
    const ctx = screenShareCtx
    if (!ctx) return
    await stopShareContext(ctx)
    console.log('[Soup] Screen share stopped')
  })
}

export function getScreenShareContext() {
  return screenShareCtx
}

export function resetActiveScreenShare() {
  const activeShare = screenShareCtx
  if (activeShare) void stopShareContext(activeShare, { notifyServer: false })
}

export function stopScreenEncoderStats() {
  encoderStatsStop?.()
}
