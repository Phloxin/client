// The sender page of probe 3's Chromium baseline (.plans/native-media-engine-m5a-encoder.md,
// D26): a moving field of noise drawn on a canvas, captured and sent through mediasoup-client on
// a send transport to the probe's node. With `cuts`, the whole picture changes every 10 s. With
// `light`, the first picture is still bars with a small moving box (little to send, as a screen),
// cut every 10 s to and from the noise.
// sender.mjs drives it through `window.sender`.
import { Device } from 'mediasoup-client'

const WIDTH = 1280
const HEIGHT = 720
const FPS = 30
const CUT_MS = 10_000

const canvas = document.getElementById('canvas')
canvas.width = WIDTH
canvas.height = HEIGHT
const context = canvas.getContext('2d')

// A picture twice as wide whose halves are the same, so the field moves without a seam.
function scene(seed, colourful) {
  const tile = document.createElement('canvas')
  tile.width = WIDTH
  tile.height = HEIGHT
  const g = tile.getContext('2d')
  const image = g.createImageData(WIDTH, HEIGHT)
  let s = seed >>> 0
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const x = i % WIDTH
    const y = Math.floor(i / WIDTH)
    const base = colourful ? ((Math.floor(x / 96) + 3 * Math.floor(y / 96)) % 8) * 30 : ((x + 2 * y) >> 6) % 2 ? 220 : 40
    const n = (s & 63) - 32
    image.data[i * 4] = base + n
    image.data[i * 4 + 1] = 255 - base + n
    image.data[i * 4 + 2] = (base * 3) % 256 + n
    image.data[i * 4 + 3] = 255
  }
  g.putImageData(image, 0, 0)
  const wide = document.createElement('canvas')
  wide.width = WIDTH * 2
  wide.height = HEIGHT
  const w = wide.getContext('2d')
  w.drawImage(tile, 0, 0)
  w.drawImage(tile, WIDTH, 0)
  return wide
}

// Still colour bars.
function bars() {
  const c = document.createElement('canvas')
  c.width = WIDTH
  c.height = HEIGHT
  const g = c.getContext('2d')
  const colours = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0']
  colours.forEach((colour, i) => {
    g.fillStyle = colour
    g.fillRect((i * WIDTH) / 7, 0, WIDTH / 7 + 1, HEIGHT)
  })
  return c
}

let producer = null
let transport = null

window.sender = {
  async setup({ routing, cuts, light }) {
    const scenes = [light ? bars() : scene(0x9e3779b9, true), scene(0x85ebca77, false)]
    const started = performance.now()
    let n = 0
    setInterval(() => {
      const elapsed = performance.now() - started
      const which = cuts ? Math.floor(elapsed / CUT_MS) % 2 : 0
      if (light && which === 0) {
        context.drawImage(scenes[0], 0, 0)
        context.fillStyle = '#fff'
        context.fillRect((n * 16) % (WIDTH - 96), HEIGHT / 2, 96, 96)
      } else {
        context.drawImage(scenes[which], -(n % WIDTH), 0)
      }
      context.fillStyle = '#000'
      context.fillRect(20, 20, 300, 50)
      context.fillStyle = '#fff'
      context.font = '40px monospace'
      context.fillText(`F ${n}`, 30, 60)
      n++
    }, 1000 / FPS)

    const device = new Device()
    await device.load({ routerRtpCapabilities: routing.routerRtpCapabilities })
    transport = device.createSendTransport(routing.transport)
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      window.probeConnect(dtlsParameters).then(callback, errback)
    })
    transport.on('produce', ({ rtpParameters }, callback, errback) => {
      window.probeProduce(rtpParameters).then((id) => callback({ id }), errback)
    })
    transport.on('connectionstatechange', (state) => console.log(`[sender] transport ${state}`))
    const track = canvas.captureStream(FPS).getVideoTracks()[0]
    producer = await transport.produce({ track, encodings: [{ maxBitrate: 8_000_000 }] })
    return { codec: producer.rtpParameters.codecs[0].mimeType, handler: device.handlerName }
  },

  async sample() {
    const report = await producer.getStats()
    const out = {}
    report.forEach((stat) => {
      if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
        for (const key of [
          'bytesSent',
          'retransmittedBytesSent',
          'framesEncoded',
          'frameWidth',
          'frameHeight',
          'framesPerSecond',
          'qualityLimitationReason',
          'targetBitrate'
        ]) {
          out[key] = stat[key] ?? null
        }
      }
      if (stat.type === 'candidate-pair' && stat.nominated && stat.availableOutgoingBitrate != null) {
        out.availableOutgoingBitrate = stat.availableOutgoingBitrate
      }
    })
    return out
  }
}
