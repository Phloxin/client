import assert from 'node:assert/strict'
import test from 'node:test'

import {
  channelRoomsDeleted,
  findRoom,
  roomClosed,
  roomOpened,
  roomUpdated,
  roomsFromReady,
  roomsInChannel
} from './rooms.js'

const room = (id, channel = 'c1', extra = {}) => ({
  id,
  channel_id: channel,
  activity_id: 'connect4',
  creator: 'u1',
  clients: [],
  opened_at: 1000,
  ...extra
})

test('Ready gives the list, and a missing or bad rooms field gives none', () => {
  assert.deepEqual(roomsFromReady([room('r1'), room('r2', 'c2')]), [room('r1'), room('r2', 'c2')])
  assert.deepEqual(roomsFromReady(undefined), [])
  assert.deepEqual(roomsFromReady(null), [])
  assert.deepEqual(roomsFromReady([null, { id: '' }, { id: 5 }, room('r1')]), [room('r1')])
})

test('a room without clients reads as empty clients', () => {
  const { clients, ...bare } = room('r1')
  assert.deepEqual(clients, [])
  assert.deepEqual(roomsFromReady([bare])[0].clients, [])
  assert.deepEqual(roomOpened([], bare)[0].clients, [])
})

test('Opened adds a new room and replaces a known one', () => {
  let list = roomOpened([], room('r1'))
  list = roomOpened(list, room('r2'))
  assert.deepEqual(
    list.map((r) => r.id),
    ['r1', 'r2']
  )
  list = roomOpened(list, room('r1', 'c1', { clients: ['u1', 'u2'] }))
  assert.deepEqual(
    list.map((r) => r.id),
    ['r1', 'r2']
  )
  assert.deepEqual(findRoom(list, 'r1').clients, ['u1', 'u2'])
  assert.equal(roomOpened(list, null), list)
})

test('Updated changes a known room and ignores an unknown one', () => {
  const list = [room('r1'), room('r2')]
  const next = roomUpdated(list, { room_id: 'r2', channel_id: 'c1', clients: ['u3'] })
  assert.deepEqual(findRoom(next, 'r2').clients, ['u3'])
  assert.equal(findRoom(next, 'r1'), list[0])
  assert.equal(roomUpdated(list, { room_id: 'nope', channel_id: 'c1', clients: ['u3'] }), list)
  assert.deepEqual(findRoom(roomUpdated(list, { room_id: 'r1' }), 'r1').clients, [])
})

test('Closed removes a known room and ignores an unknown one', () => {
  const list = [room('r1'), room('r2')]
  assert.deepEqual(
    roomClosed(list, { room_id: 'r1', channel_id: 'c1' }).map((r) => r.id),
    ['r2']
  )
  assert.equal(roomClosed(list, { room_id: 'nope', channel_id: 'c1' }), list)
})

test('a deleted channel takes its rooms', () => {
  const list = [room('r1', 'c1'), room('r2', 'c2'), room('r3', 'c1')]
  assert.deepEqual(
    channelRoomsDeleted(list, 'c1').map((r) => r.id),
    ['r2']
  )
  assert.equal(channelRoomsDeleted(list, 'c9'), list)
})

test('a channel lists its own rooms, oldest first', () => {
  const list = [
    room('r1', 'c1', { opened_at: 30 }),
    room('r2', 'c2', { opened_at: 10 }),
    room('r3', 'c1', { opened_at: 20 })
  ]
  assert.deepEqual(
    roomsInChannel(list, 'c1').map((r) => r.id),
    ['r3', 'r1']
  )
  assert.deepEqual(roomsInChannel(list, 'c9'), [])
  assert.equal(findRoom(list, 'r9'), null)
})

test('a room keeps its detail from Ready and from Opened', () => {
  const withDetail = room('r1', 'c1', { detail: 'Now playing: Clocks' })
  assert.equal(roomsFromReady([withDetail])[0].detail, 'Now playing: Clocks')
  assert.equal(roomOpened([], withDetail)[0].detail, 'Now playing: Clocks')
  assert.equal('detail' in roomsFromReady([room('r1')])[0], false)
})

test('Updated replaces the detail, and a missing one clears it', () => {
  const list = [room('r1', 'c1', { detail: 'old' })]
  const replaced = roomUpdated(list, {
    room_id: 'r1',
    channel_id: 'c1',
    clients: [],
    detail: 'new'
  })
  assert.equal(findRoom(replaced, 'r1').detail, 'new')
  const cleared = roomUpdated(list, { room_id: 'r1', channel_id: 'c1', clients: ['u2'] })
  assert.equal('detail' in findRoom(cleared, 'r1'), false)
  assert.deepEqual(findRoom(cleared, 'r1').clients, ['u2'])
})

test('a detail that is not a string is dropped', () => {
  assert.equal('detail' in roomsFromReady([room('r1', 'c1', { detail: 5 })])[0], false)
  assert.equal('detail' in roomOpened([], room('r1', 'c1', { detail: null }))[0], false)
  const list = [room('r1', 'c1', { detail: 'old' })]
  const next = roomUpdated(list, { room_id: 'r1', channel_id: 'c1', clients: [], detail: {} })
  assert.equal('detail' in findRoom(next, 'r1'), false)
})
