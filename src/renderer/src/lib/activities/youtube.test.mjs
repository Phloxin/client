import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMBED_ORIGIN,
  SUBSCRIBE,
  captionCommands,
  captionsShowing,
  commandMessage,
  commandsFor,
  describedFrom,
  embedUrl,
  initialPlayer,
  isVideoId,
  listeningMessage,
  nextPlayer,
  oembedUrl,
  pickTrack,
  readEmbedMessage,
  statusOf
} from './youtube.js'

const decode = (messages) => messages.map((m) => JSON.parse(m))
const embed = (event, info) => ({ type: 'embed', message: { event, info } })
const run = (events, from = initialPlayer()) => events.reduce(nextPlayer, from)

test('the embed URL is the nocookie host with the player parameters', () => {
  assert.equal(EMBED_ORIGIN, 'https://www.youtube-nocookie.com')
  const url = new URL(embedUrl('M7lc1UVf-VE'))
  assert.equal(url.origin, EMBED_ORIGIN)
  assert.equal(url.pathname, '/embed/M7lc1UVf-VE')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    enablejsapi: '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    rel: '0',
    iv_load_policy: '3',
    playsinline: '1'
  })
})

test('a video id is 11 characters of A-Z a-z 0-9 _ -', () => {
  assert.ok(isVideoId('M7lc1UVf-VE'))
  assert.ok(isVideoId('a_b-c_d-e_f'))
  for (const bad of ['M7lc1UVf-V', 'M7lc1UVf-VEx', 'M7lc1UVf+VE', '', null, 12345678901]) {
    assert.equal(isVideoId(bad), false, String(bad))
  }
})

test('listening and commands are the widget protocol as JSON strings', () => {
  assert.deepEqual(JSON.parse(listeningMessage()), { event: 'listening', id: 1, channel: 'widget' })
  assert.deepEqual(JSON.parse(commandMessage('seekTo', [12, true])), {
    event: 'command',
    func: 'seekTo',
    args: [12, true],
    id: 1,
    channel: 'widget'
  })
  // Measured against the real embed: onStateChange comes only once it is asked for.
  assert.deepEqual(
    decode(SUBSCRIBE).map((m) => [m.func, m.args]),
    [
      ['addEventListener', ['onStateChange']],
      ['addEventListener', ['onError']]
    ]
  )
})

test('each player op becomes its embed commands', () => {
  const funcs = (op) => decode(commandsFor(op)).map((m) => [m.func, m.args])
  assert.deepEqual(funcs({ op: 'load', videoId: 'M7lc1UVf-VE', startMs: 61500, play: true }), [
    ['loadVideoById', [{ videoId: 'M7lc1UVf-VE', startSeconds: 61.5 }]]
  ])
  assert.deepEqual(funcs({ op: 'load', videoId: 'M7lc1UVf-VE', startMs: 0, play: false }), [
    ['cueVideoById', [{ videoId: 'M7lc1UVf-VE', startSeconds: 0 }]]
  ])
  assert.deepEqual(funcs({ op: 'play' }), [['playVideo', []]])
  assert.deepEqual(funcs({ op: 'pause' }), [['pauseVideo', []]])
  assert.deepEqual(funcs({ op: 'seek', positionMs: 600000 }), [['seekTo', [600, true]]])
  assert.deepEqual(funcs({ op: 'unload' }), [['stopVideo', []]])
  assert.deepEqual(funcs({ op: 'volume', volume: 30, muted: false }), [
    ['setVolume', [30]],
    ['unMute', []]
  ])
  assert.deepEqual(funcs({ op: 'volume', volume: 100, muted: true }), [
    ['setVolume', [100]],
    ['mute', []]
  ])
  assert.deepEqual(funcs({ op: 'volume', volume: 0, muted: false }), [
    ['setVolume', [0]],
    ['mute', []]
  ])
  assert.deepEqual(funcs({ op: 'rate', rate: 150 }), [['setPlaybackRate', [1.5]]])
  assert.deepEqual(funcs({ op: 'place', rect: null }), [])
  assert.deepEqual(funcs({ op: 'describe', id: 1, videoId: 'M7lc1UVf-VE' }), [])
})

test('only JSON strings with an event are embed messages', () => {
  assert.deepEqual(readEmbedMessage('{"event":"onStateChange","info":1}'), {
    event: 'onStateChange',
    info: 1
  })
  for (const bad of [null, {}, { event: 'onReady' }, 'not json', '[]', '{"info":1}', '"x"']) {
    assert.equal(readEmbedMessage(bad), null, JSON.stringify(bad))
  }
})

test('before any load the status is idle', () => {
  const p = run([embed('initialDelivery', { playerState: 5, currentTime: 0 }), embed('onReady')])
  assert.equal(p.ready, true)
  assert.deepEqual(statusOf(p), {
    state: 'idle',
    positionMs: 0,
    durationMs: 0,
    title: null,
    rate: 100
  })
})

// The sequence after loadVideoById at 120 s against the real embed: a stale paused report about
// the old video comes before the new video's -1.
test('a load reports loading until the new video has started, then its state', () => {
  const info = {
    duration: 1343.661,
    videoData: { title: 'Dev Live', video_id: 'M7lc1UVf-VE' },
    playbackRate: 1
  }
  let p = run([
    embed('onReady'),
    embed('infoDelivery', { ...info, playerState: 1, currentTime: 62.7 })
  ])
  p = nextPlayer(p, { type: 'load' })
  const states = []
  for (const ev of [
    embed('infoDelivery', { playerState: 3, currentTime: 0 }),
    embed('infoDelivery', { playerState: 2, currentTime: 0 }),
    embed('onStateChange', 2),
    embed('infoDelivery', { playerState: -1, currentTime: 0 }),
    embed('infoDelivery', { playerState: 3, currentTime: 0 }),
    embed('infoDelivery', { playerState: -1, currentTime: 120 }),
    embed('infoDelivery', { playerState: 3, currentTime: 120 }),
    embed('infoDelivery', { playerState: 1, currentTime: 120.024604 }),
    embed('infoDelivery', { currentTime: 120.5 })
  ]) {
    p = nextPlayer(p, ev)
    states.push(statusOf(p).state)
  }
  assert.deepEqual(states, [
    'loading',
    'loading',
    'loading',
    'loading',
    'buffering',
    'loading',
    'buffering',
    'playing',
    'playing'
  ])
  assert.deepEqual(statusOf(p), {
    state: 'playing',
    positionMs: 120500,
    durationMs: 1343661,
    title: 'Dev Live',
    rate: 100
  })
})

test('a cue reports cued, and onStateChange alone moves the state', () => {
  let p = run([embed('onReady'), { type: 'load' }])
  p = run(
    [
      embed('infoDelivery', { playerState: -1, currentTime: 60 }),
      embed('infoDelivery', { playerState: 5, currentTime: 60 })
    ],
    p
  )
  assert.equal(statusOf(p).state, 'cued')
  assert.equal(statusOf(p).positionMs, 60000)
  p = run([embed('onStateChange', 1)], p)
  assert.equal(statusOf(p).state, 'playing')
  p = run([embed('onStateChange', 2)], p)
  assert.equal(statusOf(p).state, 'paused')
  p = run([embed('onStateChange', 0)], p)
  assert.equal(statusOf(p).state, 'ended')
})

test('the rate is reported as the server percentage', () => {
  const p = run([
    embed('onReady'),
    { type: 'load' },
    embed('infoDelivery', { playerState: -1 }),
    embed('infoDelivery', { playerState: 1, playbackRate: 1.5 })
  ])
  assert.equal(statusOf(p).rate, 150)
})

test('an error is reported once, and a load clears it', () => {
  let p = run([embed('onReady'), { type: 'load' }, embed('onError', 150)])
  assert.equal(p.error, 150)
  p = nextPlayer(p, embed('infoDelivery', { muted: false }))
  assert.equal(p.error, undefined)
  p = run([embed('onError', 5), { type: 'load' }], p)
  assert.equal(p.error, undefined)
})

test('an unload is idle again, at 0, with no title', () => {
  let p = run([
    embed('onReady'),
    { type: 'load' },
    embed('infoDelivery', { playerState: -1 }),
    embed('infoDelivery', {
      playerState: 1,
      currentTime: 5,
      duration: 10,
      videoData: { title: 'x' }
    })
  ])
  p = nextPlayer(p, { type: 'unload' })
  assert.deepEqual(statusOf(p), {
    state: 'idle',
    positionMs: 0,
    durationMs: 0,
    title: null,
    rate: 100
  })
})

// As the real embed sends them when a video loads: first with no tracks, then with them.
const EN = { languageCode: 'en', languageName: 'English', kind: '' }
const EN_ASR = { languageCode: 'en', languageName: 'English (auto-generated)', kind: 'asr' }
const DE = { languageCode: 'de', languageName: 'German', kind: '' }
const apiInfo = (track, tracklist) =>
  embed('apiInfoDelivery', { namespaces: ['captions'], captions: { track, tracklist } })

test('apiInfoDelivery keeps the subtitle tracks, and a load or unload forgets them', () => {
  let p = run([embed('onReady'), { type: 'load' }, apiInfo({}, [])])
  assert.deepEqual(p.captions, { track: {}, tracklist: [] })
  p = nextPlayer(p, apiInfo({ ...EN }, [EN, DE]))
  assert.deepEqual(p.captions, { track: EN, tracklist: [EN, DE] })
  // A tracklist that is not an array is none.
  assert.deepEqual(nextPlayer(p, apiInfo({}, 'x')).captions, { track: {}, tracklist: [] })
  // An apiInfoDelivery about something else leaves them.
  assert.equal(nextPlayer(p, embed('apiInfoDelivery', { namespaces: [] })), p)
  assert.equal(nextPlayer(p, embed('apiInfoDelivery')), p)
  assert.equal(nextPlayer(p, { type: 'load' }).captions, undefined)
  assert.equal(nextPlayer(p, { type: 'unload' }).captions, undefined)
})

test('apiInfoDelivery does not clear an error', () => {
  const p = run([embed('onReady'), { type: 'load' }, embed('onError', 150), apiInfo({}, [EN])])
  assert.equal(p.error, 150)
})

test("the track turned on is the viewer's language first, made by a person before auto-generated", () => {
  const FR_ASR = { languageCode: 'fr', kind: 'asr' }
  const EN_GB = { languageCode: 'en-GB', kind: '' }
  // The viewer's language by its base, a person's track first.
  assert.equal(pickTrack([DE, EN_ASR, EN_GB], {}, 'en-US'), 'en-GB')
  assert.equal(pickTrack([DE, EN_ASR], {}, 'en-US'), 'en')
  assert.equal(pickTrack([DE, EN_ASR], { languageCode: 'de' }, 'EN'), 'en')
  // Then the one the embed has on.
  assert.equal(pickTrack([DE, EN, FR_ASR], { languageCode: 'fr' }, 'ja'), 'fr')
  // Then the first made by a person, then the first.
  assert.equal(pickTrack([FR_ASR, DE, EN], {}, 'ja'), 'de')
  assert.equal(pickTrack([FR_ASR, EN_ASR], {}, 'ja'), 'fr')
  assert.equal(pickTrack([FR_ASR, DE], undefined, ''), 'de')
  assert.equal(pickTrack([FR_ASR, DE], { languageCode: '' }, undefined), 'de')
  // With no track known, the viewer's language by its base: the embed lists no auto-generated
  // track but turns one on when asked for its language.
  assert.equal(pickTrack([], {}, 'en'), 'en')
  assert.equal(pickTrack(undefined, undefined, 'en-US'), 'en')
  assert.equal(pickTrack([{ kind: '' }, { languageCode: '' }], {}, 'PT-br'), 'pt')
  // Nothing to turn on.
  assert.equal(pickTrack([], {}, ''), null)
  assert.equal(pickTrack(undefined, undefined, undefined), null)
  assert.equal(pickTrack([], { languageCode: '' }, null), null)
})

test('subtitles are turned on with the picked track and off with an empty one', () => {
  const funcs = (messages) => decode(messages).map((m) => [m.func, m.args])
  const p = run([embed('onReady'), { type: 'load' }, apiInfo({}, [DE, EN_ASR])])
  assert.deepEqual(funcs(captionCommands(p, true, 'en-US')), [
    ['setOption', ['captions', 'track', { languageCode: 'en' }]]
  ])
  assert.deepEqual(funcs(captionCommands(p, true, 'fr')), [
    ['setOption', ['captions', 'track', { languageCode: 'de' }]]
  ])
  assert.deepEqual(funcs(captionCommands(p, false, 'en')), [
    ['setOption', ['captions', 'track', {}]]
  ])
  // No track known: the viewer's language.
  assert.deepEqual(funcs(captionCommands(nextPlayer(p, apiInfo({}, [])), true, 'en-US')), [
    ['setOption', ['captions', 'track', { languageCode: 'en' }]]
  ])
  assert.deepEqual(funcs(captionCommands(nextPlayer(p, { type: 'load' }), true, 'de')), [
    ['setOption', ['captions', 'track', { languageCode: 'de' }]]
  ])
  // Nothing to ask for: no command.
  assert.deepEqual(captionCommands(nextPlayer(p, { type: 'load' }), true, ''), [])
  // Off needs no track.
  assert.deepEqual(funcs(captionCommands(initialPlayer(), false, 'en')), [
    ['setOption', ['captions', 'track', {}]]
  ])
})

test('subtitles are showing when the embed has a track on', () => {
  const p = run([embed('onReady'), { type: 'load' }])
  assert.equal(captionsShowing(p), false)
  assert.equal(captionsShowing(nextPlayer(p, apiInfo({}, [EN]))), false)
  assert.equal(captionsShowing(nextPlayer(p, apiInfo({ languageCode: '' }, [EN]))), false)
  assert.equal(captionsShowing(nextPlayer(p, apiInfo({ ...EN }, [EN]))), true)
})

test('the oEmbed URL asks for the watch URL as JSON', () => {
  const url = new URL(oembedUrl('M7lc1UVf-VE'))
  assert.equal(url.origin + url.pathname, 'https://www.youtube.com/oembed')
  assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=M7lc1UVf-VE')
  assert.equal(url.searchParams.get('format'), 'json')
})

test('what an oEmbed answer means', () => {
  assert.deepEqual(describedFrom(200, { title: 'Dev Live' }), { title: 'Dev Live', playable: true })
  assert.deepEqual(describedFrom(200, {}), { title: null, playable: true })
  // Every 4xx, the 400 a missing id answered against the real embed included.
  for (const status of [400, 401, 403, 404, 410, 429, 499]) {
    assert.deepEqual(describedFrom(status, null), { title: null, playable: false }, String(status))
  }
  for (const status of [500, 502, 503, 599]) {
    assert.deepEqual(describedFrom(status, null), { title: null, playable: true }, String(status))
  }
  assert.deepEqual(describedFrom(null, null), { title: null, playable: true })
})
