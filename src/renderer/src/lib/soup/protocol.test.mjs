// pylon-voice v1 wire protocol: encoders, FIFO reply matching, channel state,
// view roles, and the event-socket stream requests and directory.
//   node --test src/renderer/src/lib/soup/protocol.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CloseCode,
  Direction,
  ErrorCode,
  Request,
  StreamDirectory,
  StreamOp,
  StreamRequest,
  StreamRequestError,
  ViewRole,
  VoiceChannelState,
  VoiceProtocolError,
  VoiceRequestError,
  classifyClose,
  createRequestMatcher,
  createStreamRequests,
  decodeMessage,
  mapTransportParams,
  messageType,
  producedTypeForSource,
  sinkConfigChanges,
  sinkConfigFields,
  sinkConfigForViewRole,
  sinkLayerCapabilities,
  sourceMediaKind,
  sourceTypeForAppData,
  videoCodecForMime,
  videoCodecMime,
  viewRoleFor
} from './protocol.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

const CODECS = { allowed: ['Av1', 'Vp9', 'H264', 'Vp8'], preferred: 'Av1' }

function matcherHarness(options = {}) {
  const sent = []
  const timeouts = []
  const protocolErrors = []
  const timers = []
  const matcher = createRequestMatcher({
    transmit: (frame) => sent.push(JSON.parse(frame)),
    onTimeout: (type) => timeouts.push(type),
    onProtocolError: (error) => protocolErrors.push(error),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      timer.cleared = true
    },
    ...options
  })
  const reply = (raw) => matcher.handle(decodeMessage(JSON.stringify(raw)))
  return { matcher, sent, timeouts, protocolErrors, timers, reply }
}

test('requests encode as externally tagged enums with numeric node ids', () => {
  assert.deepEqual(Request.identify('t'), { Identify: { ticket: 't' } })
  assert.equal(JSON.stringify(Request.getRoutingParams()), '"GetRoutingParams"')
  assert.deepEqual(Request.setCapabilities({ codecs: [] }), {
    SetCapabilities: { capabilities: { codecs: [] } }
  })
  assert.deepEqual(Request.connectTransport(Direction.Send, { role: 'client' }), {
    ConnectTransport: {
      transport_parameters: { dtlsParameters: { role: 'client' } },
      direction: 'Send'
    }
  })
  // Microphone and Webcam never carry a stream key.
  assert.deepEqual(Request.createSource('Microphone', { codecs: [] }), {
    CreateSource: {
      kind: 'Microphone',
      rtp_parameters: { codecs: [] },
      replaces: null,
      stream_key: null
    }
  })
  assert.deepEqual(Request.createSource('Stream', { codecs: [] }, null, '1:2:abc'), {
    CreateSource: {
      kind: 'Stream',
      rtp_parameters: { codecs: [] },
      replaces: null,
      stream_key: '1:2:abc'
    }
  })
  // A replacement may leave the key out: it inherits its predecessor's.
  assert.deepEqual(Request.createSource('Stream', { codecs: [] }, 4), {
    CreateSource: { kind: 'Stream', rtp_parameters: { codecs: [] }, replaces: 4, stream_key: null }
  })
  assert.equal(JSON.stringify(Request.createSink(3)), '{"CreateSink":{"source":3}}')
  assert.equal(JSON.stringify(Request.close(0)), '{"Close":{"node":0}}')
})

test('sink config is flattened into CreateSink and SinkConfigure', () => {
  assert.deepEqual(Request.createSink(3, { paused: false }), {
    CreateSink: { source: 3, paused: false }
  })
  assert.deepEqual(Request.sinkConfigure(7, { paused: false }), {
    SinkConfigure: { node: 7, paused: false }
  })
  assert.deepEqual(
    Request.sinkConfigure(7, { layers: { spatial: 1, temporal: 2 }, priority: 2, paused: true }),
    { SinkConfigure: { node: 7, layers: { spatial: 1, temporal: 2 }, priority: 2, paused: true } }
  )
  // Nothing to change is still a valid (no-op) SinkConfigure.
  assert.equal(JSON.stringify(Request.sinkConfigure(7)), '{"SinkConfigure":{"node":7}}')
})

test('sink config leaves out what it does not set, and refuses what the server would', () => {
  assert.deepEqual(sinkConfigFields(), {})
  assert.deepEqual(sinkConfigFields({ layers: null, priority: undefined, paused: null }), {})
  // temporal is optional on the server (Option<u8>); null means "unset".
  assert.deepEqual(sinkConfigFields({ layers: { spatial: 0 } }), {
    layers: { spatial: 0, temporal: null }
  })
  assert.throws(() => sinkConfigFields({ priority: 0 }), RangeError)
  assert.throws(() => sinkConfigFields({ priority: 256 }), RangeError)
  assert.throws(() => sinkConfigFields({ layers: { spatial: -1 } }), RangeError)
  assert.throws(() => sinkConfigFields({ layers: { spatial: 1.5 } }), RangeError)
  assert.throws(() => sinkConfigFields({ layers: { spatial: 0, temporal: 300 } }), RangeError)
})

test('SetSourcePaused carries a boolean pause', () => {
  assert.deepEqual(Request.setSourcePaused(5, true), {
    SetSourcePaused: { node: 5, paused: true }
  })
  assert.deepEqual(Request.setSourcePaused(5, false), {
    SetSourcePaused: { node: 5, paused: false }
  })
  assert.deepEqual(Request.setSourcePaused(5, undefined), {
    SetSourcePaused: { node: 5, paused: false }
  })
})

test('decodeMessage handles unit, struct and newtype variants', () => {
  assert.deepEqual(decodeMessage('"SessionReady"'), { type: 'SessionReady', data: null })
  assert.deepEqual(decodeMessage('{"SinkConfigured":{"node":7}}'), {
    type: 'SinkConfigured',
    data: { node: 7 }
  })
  assert.deepEqual(
    decodeMessage('{"Error":{"object":"Session","code":"InvalidState","message":"x"}}'),
    {
      type: 'Error',
      data: { object: 'Session', code: 'InvalidState', message: 'x' }
    }
  )
  assert.throws(() => decodeMessage('{"a":1,"b":2}'))
  assert.throws(() => decodeMessage('42'))
  assert.throws(() => decodeMessage('not json'))
  assert.equal(messageType(null), null)
})

test('replies resolve requests in FIFO order with their payload', async () => {
  const { matcher, sent, reply } = matcherHarness()
  const routing = matcher.request(Request.getRoutingParams())
  const ready = matcher.request(Request.setCapabilities({}))
  assert.deepEqual(sent, ['GetRoutingParams', { SetCapabilities: { capabilities: {} } }])
  assert.equal(matcher.size, 2)

  assert.equal(reply({ RoutingParams: { router_capabilities: { codecs: [] } } }), true)
  assert.equal(reply('SessionReady'), true)
  assert.deepEqual(await routing, { router_capabilities: { codecs: [] } })
  assert.equal(await ready, null)
  assert.equal(matcher.size, 0)
})

test('events never touch the queue', async () => {
  const { matcher, reply } = matcherHarness()
  const sink = matcher.request(Request.createSink(3))
  for (const event of [
    { Channel: { channel_id: '1', codecs: CODECS, members: [], sources: [], speakers: [] } },
    { ClientsJoined: { clients: ['2'] } },
    { ClientsLeft: { clients: ['2'] } },
    { SourcesAdded: { sources: [] } },
    { SourcesRemoved: { nodes: [3] } },
    {
      SourceReplaced: {
        old: 3,
        new: { node: 8, owner: '2', kind: 'Stream', codec: 'Vp9', group: 'k', paused: false }
      }
    },
    {
      SourceUpdated: {
        source: { node: 8, owner: '2', kind: 'Stream', codec: 'Vp9', group: 'k', paused: true }
      }
    },
    { Codecs: { codecs: CODECS } },
    { Speakers: { speakers: [] } },
    { SinkLayers: { node: 7, layers: { spatial: 0, temporal: 1 } } },
    { SinkLayers: { node: 7, layers: null } },
    { Closed: { nodes: [7] } }
  ]) {
    assert.equal(reply(event), false)
  }
  assert.equal(matcher.size, 1)
  reply({ Sink: { node: 7, source: 3, rtp_parameters: {} } })
  assert.deepEqual(await sink, { node: 7, source: 3, rtp_parameters: {} })
})

test('Closed settles the head Close for its node and is always handed on as an event', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  const close = matcher.request(Request.close(4))
  const sink = matcher.request(Request.createSink(9))

  // Unprompted closes of other nodes, or of several at once, aren't its reply.
  assert.equal(reply({ Closed: { nodes: [5] } }), false)
  assert.equal(reply({ Closed: { nodes: [4, 5] } }), false)
  assert.equal(matcher.size, 2)

  assert.equal(reply({ Closed: { nodes: [4] } }), false)
  assert.deepEqual(await close, { nodes: [4] })
  assert.equal(matcher.headType, 'CreateSink')

  reply({ Sink: { node: 10, source: 9, rtp_parameters: {} } })
  assert.equal((await sink).node, 10)
  assert.equal(protocolErrors.length, 0)
})

test('a Close settled early by an unprompted Closed leaves its real reply harmless', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  // The server closed sink 4 on its own just as we asked it to.
  const close = matcher.request(Request.close(4))
  const resume = matcher.request(Request.sinkConfigure(6, { paused: false }))
  reply({ Closed: { nodes: [4] } })
  assert.deepEqual(await close, { nodes: [4] })

  // The real reply to Close arrives with SinkConfigure at the head: not a reply.
  assert.equal(reply({ Closed: { nodes: [4] } }), false)
  assert.equal(matcher.headType, 'SinkConfigure')
  reply({ SinkConfigured: { node: 6 } })
  assert.deepEqual(await resume, { node: 6 })

  // And with nothing in flight it's still just an event, not a protocol error.
  assert.equal(reply({ Closed: { nodes: [4] } }), false)
  assert.equal(protocolErrors.length, 0)
})

test('a reply other than Closed at the head of a Close is a protocol error', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  const close = matcher.request(Request.close(4))
  reply({ SinkConfigured: { node: 4 } })
  assert.ok((await close.catch((e) => e)) instanceof VoiceProtocolError)
  assert.equal(protocolErrors.length, 1)
})

test('an Error rejects only the head request and is not fatal', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  const sink = matcher.request(Request.createSink(3))
  const resume = matcher.request(Request.sinkConfigure(9, { paused: false }))
  reply({ Error: { object: { Source: 3 }, code: 'NotFound', message: 'source gone' } })
  reply({ SinkConfigured: { node: 9 } })

  const err = await sink.catch((e) => e)
  assert.ok(err instanceof VoiceRequestError)
  assert.equal(err.request, 'CreateSink')
  assert.equal(err.code, 'NotFound')
  assert.deepEqual(err.object, { Source: 3 })
  assert.equal(err.sourceGone, true)
  assert.match(err.message, /Source\(3\) NotFound \(source gone\)/)
  assert.deepEqual(await resume, { node: 9 })
  assert.equal(protocolErrors.length, 0)
})

test('sourceGone is only true for a NotFound on a source', () => {
  const sessionError = new VoiceRequestError('CreateSink', { object: 'Session', code: 'NotFound' })
  const internal = new VoiceRequestError('CreateSink', { object: { Source: 1 }, code: 'Internal' })
  assert.equal(sessionError.sourceGone, false)
  assert.equal(internal.sourceGone, false)
})

test('Denied marks a request refused for want of a stream lease', async () => {
  const { matcher, reply } = matcherHarness()
  const source = matcher.request(Request.createSource('Stream', {}, null, '1:2:abc'))
  const sink = matcher.request(Request.createSink(4))
  // What the server sends for each (session.rs): the source refusal names the
  // send transport, the sink refusal the source it was for.
  reply({
    Error: {
      object: { Transport: 'Send' },
      code: 'Denied',
      message: 'not allowed to publish this source'
    }
  })
  reply({
    Error: { object: { Source: 4 }, code: 'Denied', message: 'not allowed to receive this source' }
  })

  const sourceErr = await source.catch((e) => e)
  assert.equal(sourceErr.code, ErrorCode.Denied)
  assert.equal(sourceErr.denied, true)
  assert.match(sourceErr.message, /Transport\(Send\) Denied/)
  const sinkErr = await sink.catch((e) => e)
  assert.equal(sinkErr.denied, true)
  // Denied isn't "the source is gone": the source is still there.
  assert.equal(sinkErr.sourceGone, false)
  assert.equal(new VoiceRequestError('CreateSink', { code: 'NotFound' }).denied, false)
})

test('SinkConfigure and SetSourcePaused are answered by their own replies', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  const configured = matcher.request(Request.sinkConfigure(7, { paused: true }))
  const paused = matcher.request(Request.setSourcePaused(4, true))
  const mic = matcher.request(Request.setSourcePaused(1, true))
  assert.equal(reply({ SinkConfigured: { node: 7 } }), true)
  assert.equal(reply({ SourcePaused: { node: 4, paused: true } }), true)
  // A microphone is muted through voice state, never SetSourcePaused.
  reply({
    Error: {
      object: { Source: 1 },
      code: 'NotSupported',
      message: 'microphones are muted through voice state'
    }
  })
  assert.deepEqual(await configured, { node: 7 })
  assert.deepEqual(await paused, { node: 4, paused: true })
  assert.equal((await mic.catch((e) => e)).code, 'NotSupported')
  assert.equal(protocolErrors.length, 0)
})

test('the removed ResumeSink is no longer a request, and Resumed no longer a reply', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  assert.equal(Request.resumeSink, undefined)
  await assert.rejects(
    matcher.request({ ResumeSink: { node: 1 } }),
    /not a request that gets a reply/
  )
  // An unknown frame is left to the caller, not paired with anything.
  assert.equal(reply({ Resumed: { node: 1 } }), false)
  assert.equal(protocolErrors.length, 0)
})

test('a reply of the wrong type rejects the head and reports a protocol error', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  const source = matcher.request(Request.createSource('Microphone', {}))
  reply({ Sink: { node: 1, source: 2, rtp_parameters: {} } })
  const err = await source.catch((e) => e)
  assert.ok(err instanceof VoiceProtocolError)
  assert.equal(protocolErrors.length, 1)
})

test('a reply with nothing in flight is a protocol error', () => {
  const { protocolErrors, reply } = matcherHarness()
  assert.equal(reply({ SinkConfigured: { node: 1 } }), true)
  assert.equal(protocolErrors.length, 1)
  assert.ok(protocolErrors[0] instanceof VoiceProtocolError)
})

test('only the head request has a running timeout', async () => {
  const { matcher, timers, timeouts, reply } = matcherHarness({ timeoutMs: 100 })
  matcher.request(Request.createSink(1)).catch(() => {})
  matcher.request(Request.createSink(2)).catch(() => {})
  assert.equal(timers.filter((t) => !t.cleared).length, 1)

  reply({ Sink: { node: 10, source: 1, rtp_parameters: {} } })
  // The first timer was cleared and the second request got a fresh one.
  const live = timers.filter((t) => !t.cleared)
  assert.equal(live.length, 1)
  live[0].fn()
  assert.deepEqual(timeouts, ['CreateSink'])
})

test('close rejects everything in flight and refuses new requests', async () => {
  const { matcher, sent } = matcherHarness()
  const first = matcher.request(Request.createSink(1))
  const closed = new Error('socket closed')
  matcher.close(closed)
  assert.equal(await first.catch((e) => e), closed)
  assert.equal(await matcher.request(Request.createSink(2)).catch((e) => e), closed)
  assert.throws(() => matcher.notify(Request.identify('t')), closed)
  assert.equal(sent.length, 1)
})

test('a transmit failure rejects without leaving a stale queue entry', async () => {
  let fail = true
  const matcher = createRequestMatcher({
    transmit: () => {
      if (fail) throw new Error('send failed')
    },
    timeoutMs: 0
  })
  await assert.rejects(matcher.request(Request.createSink(1)), /send failed/)
  assert.equal(matcher.size, 0)
  fail = false
  const next = matcher.request(Request.createSink(2))
  matcher.handle({ type: 'Sink', data: { node: 3, source: 2 } })
  assert.deepEqual(await next, { node: 3, source: 2 })
})

test('Identify goes out through notify and never enters the queue', async () => {
  const { matcher, sent } = matcherHarness()
  matcher.notify(Request.identify('ticket'))
  await flush()
  assert.deepEqual(sent, [{ Identify: { ticket: 'ticket' } }])
  assert.equal(matcher.size, 0)
  await assert.rejects(
    matcher.request(Request.identify('again')),
    /not a request that gets a reply/
  )
})

test('a snapshot replaces channel state and reports the source diff', () => {
  const state = new VoiceChannelState()
  let diff = state.applySnapshot({
    channel_id: '100',
    codecs: CODECS,
    members: ['1', '2'],
    sources: [
      { node: 3, owner: '1', kind: 'Microphone', codec: null },
      { node: 4, owner: '2', kind: 'Microphone', codec: null }
    ],
    speakers: ['1']
  })
  assert.equal(state.channelId, '100')
  assert.deepEqual(state.codecs, CODECS)
  assert.deepEqual([...state.members], ['1', '2'])
  assert.deepEqual(
    diff.added.map((s) => s.node),
    [3, 4]
  )
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.speakers, { started: ['1'], stopped: [] })

  // A resync repeating node 4 must not report it as new.
  diff = state.applySnapshot({
    channel_id: '100',
    codecs: { allowed: ['Vp9', 'H264'], preferred: 'Vp9' },
    members: ['2', '5'],
    sources: [
      { node: 4, owner: '2', kind: 'Microphone', codec: null },
      { node: 9, owner: '5', kind: 'Webcam', codec: 'Vp9' }
    ],
    speakers: ['5']
  })
  assert.deepEqual(state.codecs, { allowed: ['Vp9', 'H264'], preferred: 'Vp9' })
  assert.deepEqual(diff.added, [
    { node: 9, owner: '5', kind: 'Webcam', codec: 'Vp9', group: null, paused: false }
  ])
  assert.deepEqual(
    diff.removed.map((s) => s.node),
    [3]
  )
  assert.deepEqual(diff.updated, [])
  assert.deepEqual(diff.speakers, { started: ['5'], stopped: ['1'] })
  assert.deepEqual([...state.members], ['2', '5'])
})

test('sources carry their stream (group) and owner pause', () => {
  const state = new VoiceChannelState()
  state.applySnapshot({
    channel_id: '1',
    codecs: CODECS,
    members: ['7'],
    sources: [
      { node: 3, owner: '7', kind: 'Microphone', codec: null, group: null, paused: false },
      { node: 4, owner: '7', kind: 'Stream', codec: 'Av1', group: '1:7:abc', paused: true },
      { node: 5, owner: '7', kind: 'StreamAudio', codec: null, group: '1:7:abc', paused: false }
    ],
    speakers: []
  })
  assert.deepEqual(state.source(4), {
    node: 4,
    owner: '7',
    kind: 'Stream',
    codec: 'Av1',
    group: '1:7:abc',
    paused: true
  })
  assert.equal(state.source(3).group, null)
  assert.deepEqual(
    state.streamSources('1:7:abc').map((s) => s.node),
    [4, 5]
  )
  assert.deepEqual(state.streamSources('other'), [])
  assert.deepEqual(state.streamSources(null), [])
  // A frame without the fields (older shape) reads as ungrouped and unpaused.
  state.addSources([{ node: 9, owner: '7', kind: 'Webcam', codec: 'Vp9' }])
  assert.equal(state.source(9).group, null)
  assert.equal(state.source(9).paused, false)
})

test('SourceUpdated changes a known source and reports only real changes', () => {
  const state = new VoiceChannelState()
  const stream = { node: 4, owner: '7', kind: 'Stream', codec: 'Vp9', group: 'k', paused: false }
  state.applySnapshot({ channel_id: '1', codecs: CODECS, members: ['7'], sources: [stream] })

  assert.deepEqual(state.updateSource({ ...stream, paused: true }), { ...stream, paused: true })
  assert.equal(state.source(4).paused, true)
  // Repeating it changes nothing.
  assert.equal(state.updateSource({ ...stream, paused: true }), null)
  // A source we don't know isn't added by an update.
  assert.equal(state.updateSource({ ...stream, node: 99 }), null)
  assert.equal(state.source(99), null)
  assert.equal(state.updateSource(null), null)
})

test('a resync snapshot reports sources whose pause changed', () => {
  const state = new VoiceChannelState()
  const stream = { node: 4, owner: '7', kind: 'Stream', codec: 'Vp9', group: 'k', paused: false }
  state.applySnapshot({ channel_id: '1', codecs: CODECS, members: ['7'], sources: [stream] })
  const diff = state.applySnapshot({
    channel_id: '1',
    codecs: CODECS,
    members: ['7'],
    sources: [{ ...stream, paused: true }]
  })
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.updated, [{ ...stream, paused: true }])
})

test('deltas are idempotent and report only real changes', () => {
  const state = new VoiceChannelState()
  state.applySnapshot({ channel_id: '1', codecs: CODECS, members: [], sources: [], speakers: [] })

  assert.deepEqual(state.addClients(['7', '7']), ['7'])
  assert.deepEqual(state.addClients(['7']), [])
  const added = state.addSources([{ node: 11, owner: '7', kind: 'Microphone', codec: null }])
  assert.deepEqual(added, [
    { node: 11, owner: '7', kind: 'Microphone', codec: null, group: null, paused: false }
  ])
  assert.deepEqual(state.addSources([{ node: 11, owner: '7', kind: 'Microphone' }]), [])
  assert.equal(state.source(11).owner, '7')

  assert.deepEqual(
    state.removeSources([11, 12]).map((s) => s.node),
    [11]
  )
  assert.equal(state.source(11), null)
  assert.deepEqual(state.removeClients(['7', '8']), ['7'])
})

test('a replaced source swaps nodes and reports both halves', () => {
  const state = new VoiceChannelState()
  state.applySnapshot({
    channel_id: '1',
    codecs: CODECS,
    members: ['7'],
    sources: [{ node: 3, owner: '7', kind: 'Stream', codec: 'Av1', group: 'k', paused: true }],
    speakers: []
  })

  // The replacement keeps its predecessor's stream and pause.
  const { removed, added } = state.replaceSource(3, {
    node: 8,
    owner: '7',
    kind: 'Stream',
    codec: 'H264',
    group: 'k',
    paused: true
  })
  assert.deepEqual(removed, {
    node: 3,
    owner: '7',
    kind: 'Stream',
    codec: 'Av1',
    group: 'k',
    paused: true
  })
  assert.deepEqual(added, {
    node: 8,
    owner: '7',
    kind: 'Stream',
    codec: 'H264',
    group: 'k',
    paused: true
  })
  assert.equal(state.source(3), null)
  assert.equal(state.source(8).codec, 'H264')
  assert.deepEqual(
    state.streamSources('k').map((s) => s.node),
    [8]
  )

  // Replaying it changes nothing.
  assert.deepEqual(state.replaceSource(3, { node: 8, owner: '7', kind: 'Stream' }), {
    removed: null,
    added: null
  })
})

test('allowed codecs gate video by mime type', () => {
  const state = new VoiceChannelState()
  // Nothing to check against before the first snapshot.
  assert.equal(state.allowsVideo('video/AV1'), true)

  state.setCodecs({ allowed: ['Vp9', 'H264'], preferred: 'Vp9' })
  assert.equal(state.allowsVideo('video/AV1'), false)
  assert.equal(state.allowsVideo('video/VP9'), true)
  assert.equal(state.allowsVideo('video/h264'), true)
  // Off the server's ladder, so the server doesn't check it either.
  assert.equal(state.allowsVideo('video/H265'), true)

  state.reset()
  assert.equal(state.codecs, null)
})

test('video codecs map to and from mime types', () => {
  assert.equal(videoCodecForMime('video/AV1'), 'Av1')
  assert.equal(videoCodecForMime('video/VP9'), 'Vp9')
  assert.equal(videoCodecForMime('video/H264'), 'H264')
  assert.equal(videoCodecForMime('video/VP8'), 'Vp8')
  assert.equal(videoCodecForMime('video/rtx'), null)
  assert.equal(videoCodecForMime(undefined), null)
  assert.equal(videoCodecMime('Av1'), 'video/av1')
  assert.equal(videoCodecMime('Nope'), null)
})

test('snowflakes are normalized to strings', () => {
  const state = new VoiceChannelState()
  state.applySnapshot({
    channel_id: 5,
    codecs: CODECS,
    members: [6],
    sources: [{ node: 1, owner: 6, kind: 'Microphone' }],
    speakers: [6]
  })
  assert.equal(state.channelId, '5')
  assert.ok(state.members.has('6'))
  assert.equal(state.source(1).owner, '6')
  assert.ok(state.speakers.has('6'))
})

test('speakers are replaced, never merged', () => {
  const state = new VoiceChannelState()
  assert.deepEqual(state.setSpeakers(['1', '2']), { started: ['1', '2'], stopped: [] })
  assert.deepEqual(state.setSpeakers(['2', '3']), { started: ['3'], stopped: ['1'] })
  assert.deepEqual(state.setSpeakers([]), { started: [], stopped: ['2', '3'] })
})

test('source types map to media kinds and legacy producer labels', () => {
  assert.equal(sourceMediaKind('Microphone'), 'audio')
  assert.equal(sourceMediaKind('StreamAudio'), 'audio')
  assert.equal(sourceMediaKind('Webcam'), 'video')
  assert.equal(sourceMediaKind('Stream'), 'video')

  assert.equal(sourceTypeForAppData({ produced: 'Audio' }), 'Microphone')
  assert.equal(sourceTypeForAppData({ produced: 'ScreenShare' }), 'Stream')
  assert.equal(sourceTypeForAppData({ produced: 'ScreenShareAudio' }), 'StreamAudio')
  assert.equal(sourceTypeForAppData({ produced: 'Camera' }), 'Webcam')
  assert.equal(sourceTypeForAppData(undefined), 'Microphone')
  assert.equal(sourceTypeForAppData({ produced: 'Nonsense' }), null)

  assert.equal(producedTypeForSource('Microphone'), 'Audio')
  assert.equal(producedTypeForSource('StreamAudio'), 'ScreenShareAudio')
  assert.equal(producedTypeForSource('Stream'), 'ScreenShare')
  assert.equal(producedTypeForSource('Webcam'), 'Camera')
})

test('transport descriptors map snake_case keys only', () => {
  const ice = { usernameFragment: 'u', password: 'p' }
  assert.deepEqual(
    mapTransportParams({
      id: 't1',
      ice_parameters: ice,
      ice_candidates: [{ foundation: 'f' }],
      dtls_parameters: { role: 'auto', fingerprints: [] }
    }),
    {
      id: 't1',
      iceParameters: ice,
      iceCandidates: [{ foundation: 'f' }],
      dtlsParameters: { role: 'auto', fingerprints: [] }
    }
  )
  assert.equal(mapTransportParams(null), null)
})

test('close codes classify into recoverable and fatal', () => {
  assert.equal(classifyClose(CloseCode.UNSUPPORTED).recoverable, false)
  assert.equal(classifyClose(CloseCode.PARSE).recoverable, false)
  assert.equal(classifyClose(CloseCode.FAIL_IDENTIFY).recoverable, true)
  assert.equal(classifyClose(CloseCode.INTERNAL_ERROR).recoverable, true)
  assert.equal(classifyClose(CloseCode.SESSION_TERMINATED).expected, true)
  // Kicked or banned: rejoining on our own would undo a moderator's decision.
  assert.equal(classifyClose(CloseCode.KICKED).recoverable, false)
  assert.equal(classifyClose(CloseCode.KICKED).expected, false)
  assert.equal(classifyClose(1006).recoverable, true)
  assert.equal(classifyClose(undefined).recoverable, true)
})

// ─── View roles ──────────────────────────────────────────────────

test('view roles follow the grid: focused wins, visible is grid or thumbnail', () => {
  const view = { focusedConsumerId: '7', visibleConsumerIds: ['7', '8'] }
  assert.equal(viewRoleFor('7', view), ViewRole.Focused)
  assert.equal(viewRoleFor('8', view), ViewRole.Thumbnail)
  assert.equal(viewRoleFor('9', view), ViewRole.Hidden)
  // Nothing focused: visible tiles fill the grid.
  assert.equal(viewRoleFor('8', { visibleConsumerIds: new Set(['8']) }), ViewRole.Grid)
  // No roles applied yet: everything is hidden.
  assert.equal(viewRoleFor('8'), ViewRole.Hidden)
  assert.equal(viewRoleFor(null, { focusedConsumerId: null }), ViewRole.Hidden)
})

test('sink layer capabilities come from the encodings and their scalability mode', () => {
  // A screen share: temporal SVC only.
  assert.deepEqual(sinkLayerCapabilities({ encodings: [{ ssrc: 1, scalabilityMode: 'L1T3' }] }), {
    maxSpatial: 0,
    maxTemporal: 2
  })
  // An SVC camera.
  assert.deepEqual(sinkLayerCapabilities({ encodings: [{ scalabilityMode: 'L3T3_KEY' }] }), {
    maxSpatial: 2,
    maxTemporal: 2
  })
  // Simulcast as mediasoup describes it to a consumer.
  assert.deepEqual(sinkLayerCapabilities({ encodings: [{ scalabilityMode: 'S2T1' }] }), {
    maxSpatial: 1,
    maxTemporal: 0
  })
  // Plain video, and nothing at all.
  assert.deepEqual(sinkLayerCapabilities({ encodings: [{ ssrc: 1 }] }), {
    maxSpatial: 0,
    maxTemporal: 0
  })
  assert.deepEqual(sinkLayerCapabilities(undefined), { maxSpatial: 0, maxTemporal: 0 })
})

test('each view role maps to a sink config', () => {
  const camera = { maxSpatial: 2, maxTemporal: 2 }
  const screen = { maxSpatial: 0, maxTemporal: 2 }
  const plain = { maxSpatial: 0, maxTemporal: 0 }

  // Hidden only pauses; the next role picks the layers.
  assert.deepEqual(sinkConfigForViewRole(ViewRole.Hidden, camera), { paused: true })
  assert.deepEqual(sinkConfigForViewRole(ViewRole.Focused, camera), {
    paused: false,
    priority: 2,
    layers: { spatial: 2, temporal: 2 }
  })
  assert.deepEqual(sinkConfigForViewRole(ViewRole.Grid, camera), {
    paused: false,
    priority: 1,
    layers: { spatial: 1, temporal: 2 }
  })
  assert.deepEqual(sinkConfigForViewRole(ViewRole.Thumbnail, camera), {
    paused: false,
    priority: 1,
    layers: { spatial: 0, temporal: 0 }
  })
  // A screen share keeps its only resolution in the grid.
  assert.deepEqual(sinkConfigForViewRole(ViewRole.Grid, screen).layers, {
    spatial: 0,
    temporal: 2
  })
  // Nothing to choose between: no layers at all.
  assert.deepEqual(sinkConfigForViewRole(ViewRole.Focused, plain), {
    paused: false,
    priority: 2
  })
  assert.deepEqual(sinkConfigForViewRole(ViewRole.Grid), { paused: false, priority: 1 })
})

test('only the sink config fields that changed are sent', () => {
  const shown = { paused: false, priority: 1, layers: { spatial: 1, temporal: 2 } }
  assert.equal(sinkConfigChanges(shown, { ...shown, layers: { spatial: 1, temporal: 2 } }), null)
  assert.deepEqual(sinkConfigChanges(shown, { paused: true }), { paused: true })
  assert.deepEqual(
    sinkConfigChanges(shown, { paused: false, priority: 2, layers: { spatial: 2, temporal: 2 } }),
    { priority: 2, layers: { spatial: 2, temporal: 2 } }
  )
  // A fresh sink: the server created it paused, nothing else known.
  assert.deepEqual(sinkConfigChanges({ paused: true }, shown), shown)
  // After a failure the client forgets everything and resends it all.
  assert.deepEqual(sinkConfigChanges({}, { paused: true }), { paused: true })
  assert.equal(sinkConfigChanges({ paused: true }, { paused: true }), null)
  // A missing temporal reads the same as null.
  assert.equal(
    sinkConfigChanges({ layers: { spatial: 0, temporal: null } }, { layers: { spatial: 0 } }),
    null
  )
})

// ─── Event socket: screen streams ────────────────────────────────

function streamHarness(options = {}) {
  const sent = []
  const orphans = []
  const timers = []
  let open = true
  const requests = createStreamRequests({
    transmit: (frame) => {
      if (!open) return false
      sent.push(frame)
      return true
    },
    onOrphan: (orphan) => orphans.push(orphan),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      timer.cleared = true
    },
    ...options
  })
  const setOpen = (value) => {
    open = value
  }
  return { requests, sent, orphans, timers, setOpen }
}

test('stream requests encode as event-socket ops with string ids', () => {
  assert.deepEqual(StreamRequest.create(123), { op: 7, data: { channel_id: '123' } })
  assert.deepEqual(StreamRequest.create('123'), { op: 7, data: { channel_id: '123' } })
  assert.deepEqual(StreamRequest.watch('1:2:abc'), { op: 8, data: { stream_key: '1:2:abc' } })
  assert.deepEqual(StreamRequest.stopWatching('1:2:abc'), {
    op: 9,
    data: { stream_key: '1:2:abc' }
  })
  assert.deepEqual(StreamRequest.end('1:2:abc'), { op: 10, data: { stream_key: '1:2:abc' } })
  assert.equal(StreamOp.STREAM_CREATED, 11)
  assert.equal(StreamOp.STREAM_WATCHING, 12)
})

test('op 11 answers the oldest create, op 12 the watch of its key', async () => {
  const { requests, sent, orphans } = streamHarness()
  const first = requests.create('100')
  const watch = requests.watch('1:2:abc')
  const second = requests.create('100')
  assert.deepEqual(
    sent.map((frame) => frame.op),
    [7, 8, 7]
  )
  assert.equal(requests.size, 3)

  assert.equal(requests.handle({ op: 11, stream_key: '100:1:aaa' }), true)
  assert.equal(requests.handle({ op: 12, stream_key: '1:2:abc' }), true)
  assert.equal(requests.handle({ op: 11, stream_key: '100:1:bbb' }), true)
  assert.equal(await first, '100:1:aaa')
  assert.equal(await watch, '1:2:abc')
  assert.equal(await second, '100:1:bbb')
  assert.equal(requests.size, 0)
  assert.deepEqual(orphans, [])
})

test('other event-socket frames are not stream replies', () => {
  const { requests } = streamHarness()
  for (const msg of [
    { op: 6, ticket: 't' },
    { op: 3, data: { ev: 'StreamStarted', data: {} }, seq: 1 },
    { op: 4 },
    { err: 'nope' },
    null
  ]) {
    assert.equal(requests.handle(msg), false)
  }
})

test('watching a key already being asked for joins that request', async () => {
  const { requests, sent } = streamHarness()
  const a = requests.watch('k')
  const b = requests.watch('k')
  assert.equal(a, b)
  assert.equal(sent.length, 1)
  requests.handle({ op: 12, stream_key: 'k' })
  assert.equal(await b, 'k')
  // Once answered, a new watch asks again.
  requests.watch('k').catch(() => {})
  assert.equal(sent.length, 2)
})

test('an err rejects the oldest stream request and says which op it was', async () => {
  const { requests } = streamHarness()
  const create = requests.create('1')
  const watch = requests.watch('k')
  assert.equal(requests.fail('Missing required permission'), StreamOp.CREATE_STREAM)
  const err = await create.catch((e) => e)
  assert.ok(err instanceof StreamRequestError)
  assert.equal(err.message, 'Missing required permission')
  assert.equal(err.request, StreamOp.CREATE_STREAM)
  assert.equal(err.timedOut, false)

  assert.equal(requests.fail('Stream not found'), StreamOp.WATCH_STREAM)
  assert.equal((await watch.catch((e) => e)).message, 'Stream not found')
  // Nothing waiting: the err answered op 1 or op 5, not us.
  assert.equal(requests.fail('Invalid presence update'), null)
})

test('a reply nothing waits for is handed back as an orphan', async () => {
  const { requests, orphans } = streamHarness()
  // An err meant for an earlier op 1 failed our create...
  const create = requests.create('1')
  requests.fail('voice join failed')
  await create.catch(() => {})
  // ...so its real answer arrives with nothing waiting.
  assert.equal(requests.handle({ op: 11, stream_key: '1:2:abc' }), true)
  // A watch for a key nobody asked about.
  assert.equal(requests.handle({ op: 12, stream_key: 'other' }), true)
  assert.deepEqual(orphans, [
    { op: 11, streamKey: '1:2:abc' },
    { op: 12, streamKey: 'other' }
  ])
})

test('a timed-out stream request rejects, and its late reply is an orphan', async () => {
  const { requests, timers, orphans } = streamHarness({ timeoutMs: 50 })
  const create = requests.create('1')
  const watch = requests.watch('k')
  assert.equal(timers.length, 2)
  assert.equal(timers[0].ms, 50)

  timers[0].fn()
  const err = await create.catch((e) => e)
  assert.equal(err.timedOut, true)
  assert.equal(requests.size, 1)
  requests.handle({ op: 11, stream_key: 'late' })
  assert.deepEqual(orphans, [{ op: 11, streamKey: 'late' }])

  // An answered request's timer is cleared.
  requests.handle({ op: 12, stream_key: 'k' })
  await watch
  assert.equal(timers[1].cleared, true)
})

test('a stream request with no open socket fails at once and is never queued', async () => {
  const { requests, setOpen, sent } = streamHarness()
  setOpen(false)
  const err = await requests.create('1').catch((e) => e)
  assert.ok(err instanceof StreamRequestError)
  assert.equal(requests.size, 0)
  assert.equal(requests.notify(StreamRequest.end('k')), false)

  const throwing = createStreamRequests({
    transmit: () => {
      throw new Error('socket gone')
    }
  })
  await assert.rejects(throwing.watch('k'), StreamRequestError)
  assert.equal(throwing.size, 0)

  setOpen(true)
  assert.equal(requests.notify(StreamRequest.stopWatching('k')), true)
  assert.deepEqual(sent, [{ op: 9, data: { stream_key: 'k' } }])
})

test('reset rejects every stream request still waiting', async () => {
  const { requests, timers } = streamHarness()
  const create = requests.create('1')
  const watch = requests.watch('k')
  requests.reset()
  assert.ok((await create.catch((e) => e)) instanceof StreamRequestError)
  assert.ok((await watch.catch((e) => e)) instanceof StreamRequestError)
  assert.equal(requests.size, 0)
  assert.ok(timers.every((timer) => timer.cleared))
})

test('Ready replaces the stream directory and reports what came and went', () => {
  const directory = new StreamDirectory()
  directory.started({ stream_key: 'old', owner: '1', channel_id: '10' })
  const diff = directory.applyReady([
    { stream_key: 'a', owner: 2, channel_id: 10, viewers: [3, '4'] },
    { stream_key: 'b', owner: '5', channel_id: '11', viewers: [] },
    { owner: '6' }
  ])
  assert.deepEqual(diff, { started: ['a', 'b'], ended: ['old'] })
  assert.deepEqual(directory.get('a'), {
    streamKey: 'a',
    owner: '2',
    channelId: '10',
    viewers: new Set(['3', '4'])
  })
  assert.deepEqual(directory.viewers('a'), ['3', '4'])
  assert.equal(directory.has('old'), false)
  assert.deepEqual(directory.applyReady(undefined), { started: [], ended: ['a', 'b'] })
})

test('stream events apply idempotently on top of Ready', () => {
  const directory = new StreamDirectory()
  directory.applyReady([{ stream_key: 'a', owner: '2', channel_id: '10', viewers: ['3'] }])

  // A StreamStarted repeating Ready changes nothing.
  assert.equal(directory.started({ stream_key: 'a', owner: '2', channel_id: '10' }), false)
  assert.equal(directory.started({ stream_key: 'b', owner: '5', channel_id: '10' }), true)
  assert.deepEqual(directory.viewers('b'), [])

  // Deltas, possibly repeating what we have.
  assert.equal(directory.viewersUpdated({ stream_key: 'a', added: ['3'], removed: [] }), false)
  assert.equal(directory.viewersUpdated({ stream_key: 'a', added: ['4'], removed: ['3'] }), true)
  assert.deepEqual(directory.viewers('a'), ['4'])
  assert.equal(directory.viewersUpdated({ stream_key: 'a', removed: ['9'] }), false)
  // Viewers of a stream we never heard of are ignored.
  assert.equal(directory.viewersUpdated({ stream_key: 'zzz', added: ['1'] }), false)
  assert.equal(directory.has('zzz'), false)

  assert.equal(directory.ended({ stream_key: 'a' }), true)
  // StreamEnded for an unknown key is a no-op.
  assert.equal(directory.ended({ stream_key: 'a' }), false)
  assert.equal(directory.ended({ stream_key: 'never' }), false)
  assert.deepEqual(directory.viewers('a'), [])
  assert.equal(directory.get('a'), null)
})
