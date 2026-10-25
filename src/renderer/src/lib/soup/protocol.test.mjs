// pylon-voice v1 wire protocol: encoders, answer matching, channel state,
// view roles, and the event-socket stream requests and directory.
//   node --test src/renderer/src/lib/soup/protocol.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CloseAction,
  CloseCode,
  Direction,
  EVENT_TYPES,
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
  VoiceTicketError,
  classifyClose,
  createEventCursor,
  createRequestMatcher,
  createStreamRequests,
  decodeFrame,
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
  viewRoleFor,
  voiceTicketError
} from './protocol.js'

const CODECS = { allowed: ['Av1', 'Vp9', 'H264', 'Vp8'], preferred: 'Av1' }

// Another client's source, as the server names it: "<owner's session>:<its LocalId>".
const remote = (local) => `7318226815121408:${local}`

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

test('requests encode as externally tagged enums, with LocalId numbers and NodeId strings', () => {
  assert.deepEqual(Request.identify('t'), { Identify: { ticket: 't' } })
  assert.deepEqual(Request.sync(12), { Sync: { callback: 12 } })
  assert.deepEqual(Request.setCapabilities({ codecs: [] }, [1]), {
    SetCapabilities: { capabilities: { codecs: [] }, e2ee_formats: [1] }
  })
  assert.deepEqual(Request.group({ Ready: { epoch: 3 } }), { Group: { Ready: { epoch: 3 } } })
  assert.deepEqual(Request.requestKeyFrame(5), { RequestKeyFrame: { node: 5 } })
  // The session id is a snowflake string, echoed as the Session message sent it;
  // last_seq is the highest seq received, 0 if none.
  assert.deepEqual(Request.resume('175928847299117063', 'tok', 409), {
    Resume: { session: '175928847299117063', resume_token: 'tok', last_seq: 409 }
  })
  assert.deepEqual(Request.resume('1', 'tok'), {
    Resume: { session: '1', resume_token: 'tok', last_seq: 0 }
  })
  assert.throws(() => Request.resume('1', 'tok', -1), TypeError)
  assert.throws(() => Request.resume('1', 'tok', '4'), TypeError)
  assert.deepEqual(Request.restartIce(Direction.Receive), {
    RestartIce: { direction: 'Receive' }
  })
  assert.deepEqual(Request.connectTransport(Direction.Send, { role: 'client' }), {
    ConnectTransport: {
      transport_parameters: { dtlsParameters: { role: 'client' } },
      direction: 'Send'
    }
  })
  // Microphone and Webcam never carry a stream key.
  assert.deepEqual(Request.createSource(1, 'Microphone', { codecs: [] }), {
    CreateSource: {
      new_node: 1,
      kind: 'Microphone',
      rtp_parameters: { codecs: [] },
      replaces: null,
      stream_key: null
    }
  })
  assert.deepEqual(Request.createSource(2, 'Stream', { codecs: [] }, null, '1:2:abc'), {
    CreateSource: {
      new_node: 2,
      kind: 'Stream',
      rtp_parameters: { codecs: [] },
      replaces: null,
      stream_key: '1:2:abc'
    }
  })
  // A replacement may leave the key out: it inherits its predecessor's.
  assert.deepEqual(Request.createSource(5, 'Stream', { codecs: [] }, 4), {
    CreateSource: {
      new_node: 5,
      kind: 'Stream',
      rtp_parameters: { codecs: [] },
      replaces: 4,
      stream_key: null
    }
  })
  assert.equal(
    JSON.stringify(Request.createSink(6, remote(3))),
    `{"CreateSink":{"new_node":6,"source":"${remote(3)}"}}`
  )
  assert.equal(JSON.stringify(Request.close(0)), '{"Close":{"node":0}}')
})

test('sink config is flattened into CreateSink and ConfigureSink', () => {
  assert.deepEqual(Request.createSink(6, remote(3), { paused: false }), {
    CreateSink: { new_node: 6, source: remote(3), paused: false }
  })
  assert.deepEqual(Request.configureSink(7, { paused: false }), {
    ConfigureSink: { node: 7, paused: false }
  })
  assert.deepEqual(
    Request.configureSink(7, { layers: { spatial: 1, temporal: 2 }, priority: 2, paused: true }),
    { ConfigureSink: { node: 7, layers: { spatial: 1, temporal: 2 }, priority: 2, paused: true } }
  )
  // Nothing to change is still a valid (no-op) ConfigureSink.
  assert.equal(JSON.stringify(Request.configureSink(7)), '{"ConfigureSink":{"node":7}}')
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
  // No top-level message is a unit variant today, but serde would send one as a bare string.
  assert.deepEqual(decodeMessage('"Unit"'), { type: 'Unit', data: null })
  assert.deepEqual(decodeMessage('{"Done":{"callback":7}}'), {
    type: 'Done',
    data: { callback: 7 }
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

test('server frames are { seq, ev } envelopes; only Session and Resumed have no seq', () => {
  assert.deepEqual(
    decodeFrame('{"ev":{"Session":{"id":"175928847299117063","resume_token":"t"}}}'),
    { seq: null, type: 'Session', data: { id: '175928847299117063', resume_token: 't' } }
  )
  assert.deepEqual(decodeFrame('{"ev":{"Resumed":{"resume_token":"u"}}}'), {
    seq: null,
    type: 'Resumed',
    data: { resume_token: 'u' }
  })
  assert.deepEqual(decodeFrame('{"seq":1,"ev":{"RoutingParams":{"router_capabilities":{}}}}'), {
    seq: 1,
    type: 'RoutingParams',
    data: { router_capabilities: {} }
  })
  assert.deepEqual(decodeFrame('{"seq":412,"ev":{"Group":{"Commit":{"epoch":3}}}}'), {
    seq: 412,
    type: 'Group',
    data: { Commit: { epoch: 3 } }
  })
  // A bare message (the pre-envelope wire) is not a frame.
  assert.throws(() => decodeFrame('{"Done":{"callback":7}}'), /envelope/)
  assert.throws(() => decodeFrame('null'))
  // A handshake frame with a seq, or any other without a valid one, can't be placed.
  assert.throws(() => decodeFrame('{"seq":3,"ev":{"Resumed":{"resume_token":"u"}}}'), /seq/)
  assert.throws(() => decodeFrame('{"ev":{"Done":{"callback":7}}}'), /seq/)
  assert.throws(() => decodeFrame('{"seq":0,"ev":{"Done":{"callback":7}}}'), /seq/)
  assert.throws(() => decodeFrame('{"seq":"5","ev":{"Done":{"callback":7}}}'), /seq/)
  assert.throws(() => decodeFrame('{"seq":5,"ev":{"a":1,"b":2}}'))
})

test('the event cursor applies each seq once and remembers the highest', () => {
  const cursor = createEventCursor()
  assert.equal(cursor.lastSeq, 0)
  assert.equal(cursor.accept(1), true)
  assert.equal(cursor.accept(2), true)
  assert.equal(cursor.lastSeq, 2)
  // A duplicate between the node's queue and the replay, or an older frame.
  assert.equal(cursor.accept(2), false)
  assert.equal(cursor.accept(1), false)
  assert.equal(cursor.lastSeq, 2)
  // A gap isn't the cursor's to judge; it moves on.
  assert.equal(cursor.accept(5), true)
  assert.equal(cursor.lastSeq, 5)
  assert.throws(() => cursor.accept(null), TypeError)
  // Resuming at 4 with 5 and 6 already queued: the replay of 5..9 only adds 7..9.
  const resumed = createEventCursor(4)
  const applied = [5, 6, 5, 6, 7, 8, 9, 10].filter((seq) => resumed.accept(seq))
  assert.deepEqual(applied, [5, 6, 7, 8, 9, 10])
  assert.throws(() => createEventCursor(-1), TypeError)
})

test('Identify is answered by the pushed RoutingParams, SetCapabilities by the first Channel', async () => {
  const { matcher, sent, reply } = matcherHarness()
  const routing = matcher.request(Request.identify('ticket'))
  assert.deepEqual(sent, [{ Identify: { ticket: 'ticket' } }])
  assert.equal(reply({ RoutingParams: { router_capabilities: { codecs: [] } } }), true)
  assert.deepEqual(await routing, { router_capabilities: { codecs: [] } })

  const ready = matcher.request(Request.setCapabilities({}, [1]))
  assert.equal(matcher.ready, false)
  const snapshot = { channel_id: '1', codecs: CODECS, clients: [], sources: [], speakers: [] }
  // The snapshot is still the caller's to apply, and the session is READY before it does.
  assert.equal(reply({ Channel: snapshot }), false)
  assert.equal(matcher.ready, true)
  assert.deepEqual(await ready, snapshot)
  assert.equal(matcher.size, 0)
})

test('answers resolve the request they name, and new ids come from one counter', async () => {
  const { matcher, sent, reply } = matcherHarness()
  const source = matcher.create((node) => Request.createSource(node, 'Microphone', {}))
  const sink = matcher.create((node) => Request.createSink(node, remote(3)))
  const connect = matcher.request(Request.connectTransport(Direction.Receive, {}))
  const configured = matcher.requestSynced(Request.configureSink(2, { paused: false }))
  // Sources, sinks and Sync callbacks share the counter.
  assert.equal(sent[0].CreateSource.new_node, 1)
  assert.equal(sent[1].CreateSink.new_node, 2)
  assert.deepEqual(sent.slice(3), [
    { ConfigureSink: { node: 2, paused: false } },
    { Sync: { callback: 3 } }
  ])
  assert.equal(matcher.size, 4)

  // Paired by what they name, not by position.
  assert.equal(reply({ Sink: { node: 2, rtp_parameters: {} } }), true)
  assert.deepEqual(await sink, { node: 2, rtp_parameters: {} })
  assert.equal(reply({ TransportConnected: { direction: 'Receive' } }), true)
  assert.equal(reply({ Source: { node: 1, kind: { type: 'Microphone' } } }), true)
  assert.equal(reply({ Done: { callback: 3 } }), true)
  assert.deepEqual(await connect, { direction: 'Receive' })
  assert.deepEqual(await source, { node: 1, kind: { type: 'Microphone' } })
  assert.equal(await configured, undefined)
  assert.equal(matcher.size, 0)
})

test('events are handed on and settle nothing', async () => {
  const { matcher, reply } = matcherHarness()
  const sink = matcher.create((node) => Request.createSink(node, remote(3)))
  const stream = (node, paused) => ({
    node,
    owner: '2',
    kind: { type: 'Stream', attr: { codec: 'Vp9', stream_key: 'k' } },
    paused
  })
  for (const event of [
    { Channel: { channel_id: '1', codecs: CODECS, clients: [], sources: [], speakers: [] } },
    { ClientsJoined: { clients: ['2'] } },
    { ClientsLeft: { clients: ['2'] } },
    { SourcesAdded: { sources: [] } },
    { SourcesRemoved: { nodes: [remote(3)] } },
    { SourceReplaced: { old: remote(3), new: stream(remote(8), false) } },
    { SourceUpdated: { source: stream(remote(8), true) } },
    { Codecs: { codecs: CODECS } },
    { Speakers: { speakers: [] } },
    { SinkLayers: { node: 1, layers: { spatial: 0, temporal: 1 } } },
    { SinkLayers: { node: 1, layers: null } },
    { Closed: { nodes: [1] } }
  ]) {
    assert.equal(reply(event), false)
  }
  assert.equal(matcher.size, 1)
  reply({ Sink: { node: 1, rtp_parameters: {} } })
  assert.deepEqual(await sink, { node: 1, rtp_parameters: {} })
})

test('Close is sent and forgotten, and every Closed is an event', async () => {
  const { matcher, sent, protocolErrors, reply } = matcherHarness()
  // It's answered only while its node is alive, so nothing may wait for that answer.
  await assert.rejects(matcher.request(Request.close(4)), /no success answer/)
  matcher.notify(Request.close(4))
  assert.deepEqual(sent, [{ Close: { node: 4 } }])
  assert.equal(matcher.size, 0)

  // Its answer, or the server closing nodes on its own: both are events.
  assert.equal(reply({ Closed: { nodes: [4] } }), false)
  assert.equal(reply({ Closed: { nodes: [4, 5] } }), false)
  assert.equal(protocolErrors.length, 0)

  // A request that gets an answer can't be sent and forgotten.
  assert.throws(() => matcher.notify(Request.createSink(6, remote(3))), /send it with request/)
})

test('an Error rejects the request whose object it names and is not fatal', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  const first = matcher.create((node) => Request.createSink(node, remote(3)))
  const second = matcher.create((node) => Request.createSink(node, remote(4)))
  // A failed create names its new node, not the source it was for.
  assert.equal(
    reply({ Error: { object: { Sink: 2 }, code: 'NotFound', message: 'source not in channel' } }),
    true
  )

  const err = await second.catch((e) => e)
  assert.ok(err instanceof VoiceRequestError)
  assert.equal(err.request, 'CreateSink')
  assert.equal(err.code, 'NotFound')
  assert.deepEqual(err.object, { Sink: 2 })
  assert.equal(err.sourceGone, true)
  assert.match(err.message, /Sink\(2\) NotFound \(source not in channel\)/)

  reply({ Sink: { node: 1, rtp_parameters: {} } })
  assert.equal((await first).node, 1)
  // An Error nothing waits for (a request sent and forgotten) is the caller's to log.
  assert.equal(
    reply({ Error: { object: { Sink: 1 }, code: 'Internal', message: 'request keyframe' } }),
    false
  )
  assert.equal(protocolErrors.length, 0)
})

test('sourceGone is a NotFound on a source or sink, never on the session', () => {
  const sessionError = new VoiceRequestError('CreateSink', { object: 'Session', code: 'NotFound' })
  const internal = new VoiceRequestError('CreateSink', { object: { Sink: 1 }, code: 'Internal' })
  assert.equal(sessionError.sourceGone, false)
  assert.equal(internal.sourceGone, false)
})

test('Denied marks a request refused for want of a stream lease', async () => {
  const { matcher, reply } = matcherHarness()
  const source = matcher.create((node) => Request.createSource(node, 'Stream', {}, null, '1:2:abc'))
  const sink = matcher.create((node) => Request.createSink(node, remote(4)))
  // What the server sends for each (session.rs): both refusals name the new node.
  reply({
    Error: { object: { Source: 1 }, code: 'Denied', message: 'not allowed to publish this source' }
  })
  reply({
    Error: { object: { Sink: 2 }, code: 'Denied', message: 'not allowed to receive this source' }
  })

  const sourceErr = await source.catch((e) => e)
  assert.equal(sourceErr.code, ErrorCode.Denied)
  assert.equal(sourceErr.denied, true)
  assert.match(sourceErr.message, /Source\(1\) Denied/)
  const sinkErr = await sink.catch((e) => e)
  assert.equal(sinkErr.denied, true)
  // Denied isn't "the source is gone": the source is still there.
  assert.equal(sinkErr.sourceGone, false)
  assert.equal(new VoiceRequestError('CreateSink', { code: 'NotFound' }).denied, false)
})

test('a request without a success answer settles on the Sync behind it', async () => {
  const { matcher, sent, protocolErrors, reply } = matcherHarness()
  const sink = matcher.create((node) => Request.createSink(node, remote(3)))
  const stream = matcher.create((node) => Request.createSource(node, 'Stream', {}, null, 'k'))
  const mic = matcher.create((node) => Request.createSource(node, 'Microphone', {}))
  reply({ Sink: { node: 1, rtp_parameters: {} } })
  reply({ Source: { node: 2, kind: { type: 'Stream', attr: { codec: 'Vp9', stream_key: 'k' } } } })
  reply({ Source: { node: 3, kind: { type: 'Microphone' } } })
  await Promise.all([sink, stream, mic])
  sent.length = 0

  const configured = matcher.requestSynced(Request.configureSink(1, { paused: true }))
  const paused = matcher.requestSynced(Request.setSourcePaused(2, true))
  const micPaused = matcher.requestSynced(Request.setSourcePaused(3, true))
  assert.deepEqual(sent, [
    { ConfigureSink: { node: 1, paused: true } },
    { Sync: { callback: 4 } },
    { SetSourcePaused: { node: 2, paused: true } },
    { Sync: { callback: 5 } },
    { SetSourcePaused: { node: 3, paused: true } },
    { Sync: { callback: 6 } }
  ])
  assert.equal(reply({ Done: { callback: 4 } }), true)
  assert.equal(reply({ Done: { callback: 5 } }), true)
  // A microphone is muted through voice state, never SetSourcePaused.
  assert.equal(
    reply({
      Error: {
        object: { Source: 3 },
        code: 'NotSupported',
        message: 'microphones are muted through voice state'
      }
    }),
    true
  )
  // The failed request's Done still comes, and is no surprise.
  assert.equal(reply({ Done: { callback: 6 } }), true)
  assert.equal(await configured, undefined)
  assert.equal(await paused, undefined)
  assert.equal((await micPaused.catch((e) => e)).code, 'NotSupported')
  assert.equal(matcher.size, 0)
  assert.equal(protocolErrors.length, 0)
})

test('the removed requests and replies are gone', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  assert.equal(Request.getRoutingParams, undefined)
  assert.equal(Request.sinkConfigure, undefined)
  // No success answer to wait for: ConfigureSink takes requestSynced or notify.
  await assert.rejects(
    matcher.request(Request.configureSink(1, { paused: false })),
    /no success answer/
  )
  // An unknown frame is left to the caller, not paired with anything.
  for (const removed of [
    'SessionReady',
    'GroupReceived',
    { SinkConfigured: { node: 1 } },
    { SourcePaused: { node: 1, paused: true } },
    { KeyFrameRequested: { node: 1 } }
  ]) {
    assert.equal(reply(removed), false)
  }
  assert.equal(protocolErrors.length, 0)
})

test('an answer nothing is waiting for is a protocol error', async () => {
  const { matcher, protocolErrors, reply } = matcherHarness()
  const sink = matcher.create((node) => Request.createSink(node, remote(3)))
  // A Source for the node a CreateSink named, and a Done nobody asked for.
  assert.equal(reply({ Source: { node: 1, kind: { type: 'Microphone' } } }), true)
  assert.equal(reply({ Done: { callback: 9 } }), true)
  assert.equal(protocolErrors.length, 2)
  assert.ok(protocolErrors.every((error) => error instanceof VoiceProtocolError))
  // The request is still waiting for its own answer.
  assert.equal(matcher.size, 1)
  reply({ Sink: { node: 1, rtp_parameters: {} } })
  assert.equal((await sink).node, 1)
})

test('only the oldest waiting request has a running timeout', async () => {
  const { matcher, timers, timeouts, reply } = matcherHarness({ timeoutMs: 100 })
  matcher.create((node) => Request.createSink(node, remote(3))).catch(() => {})
  matcher.create((node) => Request.createSink(node, remote(4))).catch(() => {})
  assert.equal(timers.filter((t) => !t.cleared).length, 1)

  reply({ Sink: { node: 1, rtp_parameters: {} } })
  // The first timer was cleared and the second request got a fresh one.
  const live = timers.filter((t) => !t.cleared)
  assert.equal(live.length, 1)
  live[0].fn()
  assert.deepEqual(timeouts, ['CreateSink'])
})

test('close rejects everything in flight and refuses new requests', async () => {
  const { matcher, sent } = matcherHarness()
  const first = matcher.create((node) => Request.createSink(node, remote(3)))
  const synced = matcher.requestSynced(Request.configureSink(1, { paused: false }))
  const closed = new Error('socket closed')
  matcher.close(closed)
  assert.equal(await first.catch((e) => e), closed)
  assert.equal(await synced.catch((e) => e), closed)
  assert.equal(
    await matcher.create((node) => Request.createSink(node, remote(4))).catch((e) => e),
    closed
  )
  assert.throws(() => matcher.notify(Request.close(1)), closed)
  assert.equal(sent.length, 3)
})

test('a transmit failure rejects without leaving a stale entry', async () => {
  let fail = true
  const matcher = createRequestMatcher({
    transmit: () => {
      if (fail) throw new Error('send failed')
    },
    timeoutMs: 0
  })
  await assert.rejects(
    matcher.create((node) => Request.createSink(node, remote(3))),
    /send failed/
  )
  assert.equal(matcher.size, 0)
  fail = false
  // The failed create used up its id all the same.
  const next = matcher.create((node) => Request.createSink(node, remote(3)))
  matcher.handle({ type: 'Sink', data: { node: 2, rtp_parameters: {} } })
  assert.deepEqual(await next, { node: 2, rtp_parameters: {} })
})

test('a snapshot replaces channel state and reports the source diff', () => {
  const state = new VoiceChannelState()
  let diff = state.applySnapshot({
    channel_id: '100',
    codecs: CODECS,
    clients: ['1', '2'],
    sources: [
      { node: remote(3), owner: '1', kind: { type: 'Microphone' }, paused: false },
      { node: remote(4), owner: '2', kind: { type: 'Microphone' }, paused: false }
    ],
    speakers: ['1']
  })
  assert.equal(state.channelId, '100')
  assert.deepEqual(state.codecs, CODECS)
  assert.deepEqual([...state.clients], ['1', '2'])
  assert.deepEqual(
    diff.added.map((s) => s.node),
    [remote(3), remote(4)]
  )
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.speakers, { started: ['1'], stopped: [] })

  // A resync repeating node 4 must not report it as new.
  diff = state.applySnapshot({
    channel_id: '100',
    codecs: { allowed: ['Vp9', 'H264'], preferred: 'Vp9' },
    clients: ['2', '5'],
    sources: [
      { node: remote(4), owner: '2', kind: { type: 'Microphone' }, paused: false },
      {
        node: remote(9),
        owner: '5',
        kind: { type: 'Webcam', attr: { codec: 'Vp9' } },
        paused: false
      }
    ],
    speakers: ['5']
  })
  assert.deepEqual(state.codecs, { allowed: ['Vp9', 'H264'], preferred: 'Vp9' })
  assert.deepEqual(diff.added, [
    { node: remote(9), owner: '5', kind: 'Webcam', codec: 'Vp9', streamKey: null, paused: false }
  ])
  assert.deepEqual(
    diff.removed.map((s) => s.node),
    [remote(3)]
  )
  assert.deepEqual(diff.updated, [])
  assert.deepEqual(diff.speakers, { started: ['5'], stopped: ['1'] })
  assert.deepEqual([...state.clients], ['2', '5'])
})

test('a source kind flattens into its type, codec and stream', () => {
  const state = new VoiceChannelState()
  state.applySnapshot({
    channel_id: '1',
    codecs: CODECS,
    clients: ['7'],
    sources: [
      { node: remote(3), owner: '7', kind: { type: 'Microphone' }, paused: false },
      {
        node: remote(4),
        owner: '7',
        kind: { type: 'Webcam', attr: { codec: 'Vp9' } },
        paused: false
      },
      {
        node: remote(5),
        owner: '7',
        kind: { type: 'Stream', attr: { codec: 'Av1', stream_key: '1:7:abc' } },
        paused: true
      },
      {
        node: remote(6),
        owner: '7',
        kind: { type: 'StreamAudio', attr: { stream_key: '1:7:abc' } },
        paused: false
      }
    ],
    speakers: []
  })
  const flat = (node, kind, codec, streamKey, paused = false) => ({
    node,
    owner: '7',
    kind,
    codec,
    streamKey,
    paused
  })
  assert.deepEqual(state.source(remote(3)), flat(remote(3), 'Microphone', null, null))
  assert.deepEqual(state.source(remote(4)), flat(remote(4), 'Webcam', 'Vp9', null))
  assert.deepEqual(state.source(remote(5)), flat(remote(5), 'Stream', 'Av1', '1:7:abc', true))
  assert.deepEqual(state.source(remote(6)), flat(remote(6), 'StreamAudio', null, '1:7:abc'))
  assert.deepEqual(
    state.streamSources('1:7:abc').map((s) => s.node),
    [remote(5), remote(6)]
  )
  assert.deepEqual(state.streamSources('other'), [])
  assert.deepEqual(state.streamSources(null), [])
})

// One Stream source on the wire, and how the channel state holds it.
const WIRE_STREAM = {
  node: remote(4),
  owner: '7',
  kind: { type: 'Stream', attr: { codec: 'Vp9', stream_key: 'k' } },
  paused: false
}
const FLAT_STREAM = {
  node: remote(4),
  owner: '7',
  kind: 'Stream',
  codec: 'Vp9',
  streamKey: 'k',
  paused: false
}

test('SourceUpdated changes a known source and reports only real changes', () => {
  const state = new VoiceChannelState()
  const stream = WIRE_STREAM
  state.applySnapshot({ channel_id: '1', codecs: CODECS, clients: ['7'], sources: [stream] })

  assert.deepEqual(state.updateSource({ ...stream, paused: true }), {
    ...FLAT_STREAM,
    paused: true
  })
  assert.equal(state.source(remote(4)).paused, true)
  // Repeating it changes nothing.
  assert.equal(state.updateSource({ ...stream, paused: true }), null)
  // A source we don't know isn't added by an update.
  assert.equal(state.updateSource({ ...stream, node: remote(99) }), null)
  assert.equal(state.source(remote(99)), null)
  assert.equal(state.updateSource(null), null)
})

test('a resync snapshot reports sources whose pause changed', () => {
  const state = new VoiceChannelState()
  const stream = WIRE_STREAM
  state.applySnapshot({ channel_id: '1', codecs: CODECS, clients: ['7'], sources: [stream] })
  const diff = state.applySnapshot({
    channel_id: '1',
    codecs: CODECS,
    clients: ['7'],
    sources: [{ ...stream, paused: true }]
  })
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.updated, [{ ...FLAT_STREAM, paused: true }])
})

test('deltas are idempotent and report only real changes', () => {
  const state = new VoiceChannelState()
  state.applySnapshot({ channel_id: '1', codecs: CODECS, clients: [], sources: [], speakers: [] })

  assert.deepEqual(state.addClients(['7', '7']), ['7'])
  assert.deepEqual(state.addClients(['7']), [])
  const mic = { node: remote(11), owner: '7', kind: { type: 'Microphone' }, paused: false }
  const added = state.addSources([mic])
  assert.deepEqual(added, [
    {
      node: remote(11),
      owner: '7',
      kind: 'Microphone',
      codec: null,
      streamKey: null,
      paused: false
    }
  ])
  assert.deepEqual(state.addSources([mic]), [])
  assert.equal(state.source(remote(11)).owner, '7')

  assert.deepEqual(
    state.removeSources([remote(11), remote(12)]).map((s) => s.node),
    [remote(11)]
  )
  assert.equal(state.source(remote(11)), null)
  assert.deepEqual(state.removeClients(['7', '8']), ['7'])
})

test('a replaced source swaps nodes and reports both halves', () => {
  const state = new VoiceChannelState()
  state.applySnapshot({
    channel_id: '1',
    codecs: CODECS,
    clients: ['7'],
    sources: [
      {
        node: remote(3),
        owner: '7',
        kind: { type: 'Stream', attr: { codec: 'Av1', stream_key: 'k' } },
        paused: true
      }
    ],
    speakers: []
  })

  // The replacement keeps its predecessor's stream and pause.
  const replacement = {
    node: remote(8),
    owner: '7',
    kind: { type: 'Stream', attr: { codec: 'H264', stream_key: 'k' } },
    paused: true
  }
  const { removed, added } = state.replaceSource(remote(3), replacement)
  assert.deepEqual(removed, {
    node: remote(3),
    owner: '7',
    kind: 'Stream',
    codec: 'Av1',
    streamKey: 'k',
    paused: true
  })
  assert.deepEqual(added, {
    node: remote(8),
    owner: '7',
    kind: 'Stream',
    codec: 'H264',
    streamKey: 'k',
    paused: true
  })
  assert.equal(state.source(remote(3)), null)
  assert.equal(state.source(remote(8)).codec, 'H264')
  assert.deepEqual(
    state.streamSources('k').map((s) => s.node),
    [remote(8)]
  )

  // Replaying it changes nothing.
  assert.deepEqual(state.replaceSource(remote(3), replacement), {
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
    clients: [6],
    sources: [{ node: remote(1), owner: 6, kind: { type: 'Microphone' }, paused: false }],
    speakers: [6]
  })
  assert.equal(state.channelId, '5')
  assert.ok(state.clients.has('6'))
  assert.equal(state.source(remote(1)).owner, '6')
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

test('one close-code table for both sockets, by action', () => {
  // The numbers are the server's utils::CloseCode.
  assert.deepEqual(
    [
      CloseCode.ServerShutdown,
      CloseCode.UpdateRequired,
      CloseCode.InvalidPayload,
      CloseCode.AuthFailed,
      CloseCode.TicketRejected,
      CloseCode.Replaced,
      CloseCode.HeartbeatTimeout,
      CloseCode.Kicked,
      CloseCode.Banned,
      CloseCode.VoiceEnded,
      CloseCode.E2eeFailed,
      CloseCode.InternalError
    ],
    [1001, 4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4008, 4009, 4010]
  )
  const action = (code) => classifyClose(code).action
  // A dropped connection resumes: /ws its event stream, /voice its session.
  for (const code of [1001, 4005, 4010, 1006, 1005, 1000, undefined, null]) {
    assert.equal(action(code), CloseAction.Resume, `code ${code}`)
  }
  // A new session (op 13, then Identify): a refused ticket or resume, a frame
  // the server couldn't read, the node's E2EE failing.
  assert.equal(action(4003), CloseAction.Fresh)
  assert.equal(action(4001), CloseAction.Fresh)
  assert.equal(action(4009), CloseAction.Fresh)
  assert.equal(action(4002), CloseAction.Reauth)
  assert.equal(action(4008), CloseAction.IfInVoice)
  // Another connection took over, or a moderator acted: never come back on our own.
  assert.equal(action(4004), CloseAction.Stop)
  assert.equal(action(4006), CloseAction.Stop)
  assert.equal(action(4007), CloseAction.Stop)
  assert.equal(action(4000), CloseAction.Update)
  assert.equal(classifyClose(4004).name, 'Replaced')
  assert.equal(classifyClose(4999).name, null)
})

test('ticket refusals are told apart by their text', () => {
  assert.equal(
    voiceTicketError('Client must join a voice channel before requesting a voice ticket'),
    VoiceTicketError.NotInVoice
  )
  assert.equal(voiceTicketError('Voice media is unavailable'), VoiceTicketError.VoiceUnavailable)
  assert.equal(voiceTicketError('Client is already streaming'), null)
  assert.equal(voiceTicketError(undefined), null)
})

// ─── Resume ──────────────────────────────────────────────────────

test('RestartIce is answered by IceRestarted for its direction', async () => {
  const { matcher, sent, reply } = matcherHarness()
  const send = matcher.request(Request.restartIce(Direction.Send))
  const receive = matcher.request(Request.restartIce(Direction.Receive))
  assert.deepEqual(sent, [
    { RestartIce: { direction: 'Send' } },
    { RestartIce: { direction: 'Receive' } }
  ])
  const ice = { usernameFragment: 'u', password: 'p', iceLite: true }
  assert.equal(reply({ IceRestarted: { direction: 'Receive', ice_parameters: ice } }), true)
  assert.deepEqual(await receive, { direction: 'Receive', ice_parameters: ice })
  // A failure names the transport.
  assert.equal(
    reply({ Error: { object: { Transport: 'Send' }, code: 'Internal', message: 'x' } }),
    true
  )
  await assert.rejects(send, (err) => err instanceof VoiceRequestError && err.code === 'Internal')
  assert.equal(matcher.size, 0)
})

test('a detached matcher holds what is in flight, refuses new requests, and times nothing', async () => {
  const { matcher, sent, timers } = matcherHarness()
  const sink = matcher.create((node) => Request.createSink(node, remote(3)))
  assert.equal(timers.filter((timer) => !timer.cleared).length, 1)
  matcher.detach(new Error('socket gone'))
  assert.equal(matcher.detached, true)
  assert.equal(matcher.size, 1)
  assert.equal(timers.filter((timer) => !timer.cleared).length, 0)
  await assert.rejects(matcher.request(Request.sync(9)), /socket gone/)
  await assert.rejects(
    matcher.create((node) => Request.createSink(node, remote(4))),
    /socket gone/
  )
  await assert.rejects(matcher.requestSynced(Request.configureSink(1, {})), /socket gone/)
  assert.throws(() => matcher.notify(Request.close(1)), /socket gone/)
  assert.equal(sent.length, 1)
  // Closing for good still rejects what was held.
  matcher.close(new Error('over'))
  await assert.rejects(sink, /over/)
  assert.equal(matcher.detached, false)
})

test('after a resume, the replay answers what arrived and the Done behind it resends what was lost', async () => {
  const { matcher, sent, reply, timers, protocolErrors } = matcherHarness()
  const source = matcher.create((node) => Request.createSource(node, 'Webcam', {})) // 1
  const lostSink = matcher.create((node) => Request.createSink(node, remote(3))) // 2
  const synced = matcher.requestSynced(Request.configureSink(9, { paused: false })) // Sync 3
  const lostConfig = matcher.requestSynced(Request.configureSink(9, { priority: 2 })) // Sync 4
  const connectSend = matcher.request(Request.connectTransport(Direction.Send, {}))
  const lostConnect = matcher.request(Request.connectTransport(Direction.Receive, {}))
  const lostRestart = matcher.request(Request.restartIce(Direction.Send))
  const lostGroup = matcher.requestSynced(Request.group({ Ready: { epoch: 2 } })) // Sync 5
  matcher.detach(new Error('socket gone'))
  sent.length = 0

  // Resumed: new requests are accepted again, and only a Sync goes out, behind the replay.
  const resumed = matcher.resume()
  assert.equal(matcher.detached, false)
  assert.deepEqual(sent, [{ Sync: { callback: 6 } }])
  assert.equal(timers.filter((timer) => !timer.cleared).length, 1)

  // The replay answers whatever reached the server, like any answer.
  assert.equal(reply({ Source: { node: 1, kind: { type: 'Webcam' } } }), true)
  assert.equal(reply({ Done: { callback: 3 } }), true)
  assert.equal(reply({ TransportConnected: { direction: 'Send' } }), true)
  assert.deepEqual(await source, { node: 1, kind: { type: 'Webcam' } })
  assert.equal(await synced, undefined)
  assert.deepEqual(await connectSend, { direction: 'Send' })

  // A request made before the Done goes out after the Sync, so it is never in doubt.
  const fresh = matcher.create((node) => Request.createSink(node, remote(7))) // 7
  sent.length = 0

  // The Done: everything sent before the drop and still waiting was lost. Creates and
  // Syncs get new ids (the old ones are below ids the server has seen); the rest goes
  // out as it was, in order.
  assert.equal(reply({ Done: { callback: 6 } }), true)
  await resumed
  assert.deepEqual(sent, [
    { CreateSink: { new_node: 8, source: remote(3) } },
    { ConfigureSink: { node: 9, priority: 2 } },
    { Sync: { callback: 9 } },
    {
      ConnectTransport: { transport_parameters: { dtlsParameters: {} }, direction: 'Receive' }
    },
    { RestartIce: { direction: 'Send' } },
    { Group: { Ready: { epoch: 2 } } },
    { Sync: { callback: 10 } }
  ])
  assert.equal(matcher.size, 6)

  // And they are answered like any request; a create resolves with its new node.
  reply({ Sink: { node: 7, rtp_parameters: {} } })
  reply({ Sink: { node: 8, rtp_parameters: { codecs: ['x'] } } })
  reply({ Done: { callback: 9 } })
  reply({ TransportConnected: { direction: 'Receive' } })
  reply({ IceRestarted: { direction: 'Send', ice_parameters: {} } })
  reply({ Done: { callback: 10 } })
  assert.deepEqual(await fresh, { node: 7, rtp_parameters: {} })
  assert.deepEqual(await lostSink, { node: 8, rtp_parameters: { codecs: ['x'] } })
  assert.equal(await lostConfig, undefined)
  assert.deepEqual(await lostConnect, { direction: 'Receive' })
  assert.deepEqual(await lostRestart, { direction: 'Send', ice_parameters: {} })
  assert.equal(await lostGroup, undefined)
  assert.equal(matcher.size, 0)
  assert.equal(protocolErrors.length, 0)

  // New ids continue above everything this session used.
  matcher.create((node) => Request.createSink(node, remote(6)))
  assert.equal(sent.at(-1).CreateSink.new_node, 11)
})

test('a replayed Error settles a request in doubt, and only its Sync can still be lost', async () => {
  const { matcher, sent, reply } = matcherHarness()
  const sink = matcher.create((node) => Request.createSink(node, remote(3))) // 1
  const paused = matcher.requestSynced(Request.setSourcePaused(4, true)) // Sync 2
  matcher.detach(new Error('socket gone'))
  sent.length = 0
  const resumed = matcher.resume() // Sync 3
  reply({ Error: { object: { Sink: 1 }, code: 'NotFound', message: 'no source' } })
  // SetSourcePaused failed and its Sync never made it: nothing is left to send.
  reply({ Error: { object: { Source: 4 }, code: 'NotSupported', message: 'x' } })
  reply({ Done: { callback: 3 } })
  await resumed
  await assert.rejects(sink, (err) => err.sourceGone)
  assert.equal((await paused.catch((e) => e)).code, 'NotSupported')
  assert.deepEqual(sent, [{ Sync: { callback: 3 } }])
  assert.equal(matcher.size, 0)
})

test('a drop before the Done leaves everything for the next resume, whose Sync takes over', async () => {
  const { matcher, sent, reply, protocolErrors } = matcherHarness()
  const lost = matcher.create((node) => Request.createSink(node, remote(3))) // 1
  matcher.detach(new Error('socket gone'))
  const first = matcher.resume() // Sync 2
  matcher.detach(new Error('socket gone again'))
  assert.equal(matcher.size, 2)
  sent.length = 0

  const second = matcher.resume() // Sync 3
  assert.deepEqual(sent, [{ Sync: { callback: 3 } }])
  // The first Sync did reach the server, so its Done comes in the replay. It sorts
  // nothing out: requests on the second socket aren't covered by it.
  reply({ Done: { callback: 2 } })
  await first
  assert.deepEqual(sent, [{ Sync: { callback: 3 } }])
  reply({ Done: { callback: 3 } })
  await second
  assert.deepEqual(sent.at(-1), { CreateSink: { new_node: 4, source: remote(3) } })
  reply({ Sink: { node: 4, rtp_parameters: {} } })
  assert.equal((await lost).node, 4)
  assert.equal(protocolErrors.length, 0)

  // When the earlier Sync was lost too, the later Done settles it, and it isn't resent.
  matcher.detach(new Error('socket gone'))
  const lostSync = matcher.resume() // Sync 5
  matcher.detach(new Error('socket gone again'))
  sent.length = 0
  const third = matcher.resume() // Sync 6
  reply({ Done: { callback: 6 } })
  await third
  await assert.rejects(lostSync, /Superseded/)
  assert.deepEqual(sent, [{ Sync: { callback: 6 } }])
  assert.equal(matcher.size, 0)
})

test('a notified request lost with the socket goes out again, unless an answer vouched for it', async () => {
  const { matcher, sent, reply } = matcherHarness()
  matcher.notify(Request.close(4))
  const confirmed = matcher.requestSynced(Request.configureSink(5, {})) // Sync 1
  // The Sync went out after Close 4, so Close 4 arrived.
  reply({ Done: { callback: 1 } })
  await confirmed
  matcher.notify(Request.close(6))
  matcher.notify(Request.requestKeyFrame(7))
  matcher.detach(new Error('socket gone'))
  sent.length = 0

  // The resume's own Sync went out on the new socket: its Done vouches for nothing sent
  // on the old one.
  const resumed = matcher.resume() // Sync 2
  reply({ Done: { callback: 2 } })
  await resumed
  assert.deepEqual(sent, [
    { Sync: { callback: 2 } },
    { Close: { node: 6 } },
    { RequestKeyFrame: { node: 7 } }
  ])

  // A replayed Done of a Sync sent after them on the old socket does.
  const later = matcher.requestSynced(Request.configureSink(5, {})) // Sync 3
  matcher.detach(new Error('socket gone'))
  sent.length = 0
  const again = matcher.resume() // Sync 4
  reply({ Done: { callback: 3 } })
  reply({ Done: { callback: 4 } })
  await again
  await later
  assert.deepEqual(sent, [{ Sync: { callback: 4 } }])
})

test('a resume can only lose what a ready session can resend', async () => {
  const { matcher, reply } = matcherHarness()
  const caps = matcher.request(Request.setCapabilities({}, [1]))
  matcher.detach(new Error('socket gone'))
  const resumed = matcher.resume() // Sync 1
  reply({ Done: { callback: 1 } })
  await resumed
  await assert.rejects(caps, (err) => err instanceof VoiceProtocolError)
  matcher.close(new Error('over'))
  await assert.rejects(matcher.resume(), /over/)
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

test('the stream directory groups owners by channel', () => {
  const directory = new StreamDirectory()
  assert.deepEqual(directory.ownersByChannel(), new Map())
  directory.applyReady([
    { stream_key: 'a', owner: '7', channel_id: '10', viewers: [] },
    { stream_key: 'b', owner: 2, channel_id: 10, viewers: [] },
    { stream_key: 'c', owner: '5', channel_id: '11', viewers: ['7'] },
    // An owner listed twice (a stream that is ending next to its successor)
    // shows once.
    { stream_key: 'd', owner: '5', channel_id: '11', viewers: [] },
    { stream_key: 'e', channel_id: '12', viewers: [] }
  ])
  assert.deepEqual(
    directory.ownersByChannel(),
    new Map([
      ['10', ['2', '7']],
      ['11', ['5']]
    ])
  )

  directory.ended({ stream_key: 'c' })
  directory.ended({ stream_key: 'd' })
  directory.started({ stream_key: 'f', owner: '9', channel_id: '12' })
  assert.deepEqual(
    directory.ownersByChannel(),
    new Map([
      ['10', ['2', '7']],
      ['12', ['9']]
    ])
  )
})

test('group requests settle on a Sync; group events and UpdateRequired', async () => {
  const { matcher, sent, reply } = matcherHarness()
  const keyPackage = matcher.requestSynced(Request.group({ KeyPackage: { key_package: 'AQID' } }))
  assert.deepEqual(sent, [
    { Group: { KeyPackage: { key_package: 'AQID' } } },
    { Sync: { callback: 1 } }
  ])
  assert.equal(reply({ Done: { callback: 1 } }), true)
  assert.equal(await keyPackage, undefined)

  // Group events are handed on and settle nothing.
  assert.equal(EVENT_TYPES.has('Group'), true)
  assert.equal(reply({ Group: { Execute: { epoch: 2 } } }), false)
  assert.equal(reply({ Group: 'Rejoin' }), false)

  const capabilities = matcher.request(Request.setCapabilities({}, [1]))
  reply({ Error: { object: 'Session', code: 'UpdateRequired', message: 'update' } })
  await assert.rejects(capabilities, (err) => err.updateRequired === true)
})

test('snapshots keep the group params', () => {
  const state = new VoiceChannelState()
  const group = { ciphersuite: 1, external_sender: 'AA==', format: 1 }
  state.applySnapshot({ channel_id: '1', group })
  assert.deepEqual(state.group, group)
  state.reset()
  assert.equal(state.group, null)
})
