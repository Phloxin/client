// Self-check for viewChannelOverride's precedence: node src/renderer/src/lib/permissions.check.mjs
import assert from 'node:assert/strict'
import { viewChannelOverride, EVERYONE_ROLE_ID } from './permissions.js'

const VIEW = '1' // 1 << 0
const CONNECT = '128' // 1 << 7
const ow = (id, type, allow = '0', deny = '0') => ({ id, type, allow, deny })
const everyone = (allow, deny) => ow(EVERYONE_ROLE_ID, 'role', allow, deny)

const ME = 7
const MOD = 42

// Nothing to say -> base permissions decide.
assert.equal(viewChannelOverride([], { roleIds: [MOD], userId: ME }), null)
assert.equal(
  viewChannelOverride([everyone('0', CONNECT)], { roleIds: [], userId: ME }),
  null,
  'an overwrite touching only other bits leaves VIEW_CHANNEL undecided'
)

// The moderator-only channel: deny @everyone, allow the one role.
const modOnly = [everyone('0', VIEW), ow(MOD, 'role', VIEW)]
assert.equal(viewChannelOverride(modOnly, { roleIds: [MOD], userId: ME }), true)
assert.equal(viewChannelOverride(modOnly, { roleIds: [], userId: ME }), false)

// Across held roles, an allow beats a deny.
assert.equal(
  viewChannelOverride([ow(1000, 'role', '0', VIEW), ow(MOD, 'role', VIEW)], {
    roleIds: [1000, MOD],
    userId: ME
  }),
  true
)

// A user overwrite is last word, both ways.
assert.equal(
  viewChannelOverride([everyone('0', VIEW), ow(ME, 'user', VIEW)], { roleIds: [], userId: ME }),
  true
)
assert.equal(
  viewChannelOverride([ow(MOD, 'role', VIEW), ow(ME, 'user', '0', VIEW)], {
    roleIds: [MOD],
    userId: ME
  }),
  false
)
// Someone else's user overwrite is not ours.
assert.equal(
  viewChannelOverride([everyone('0', VIEW), ow(999, 'user', VIEW)], { roleIds: [], userId: ME }),
  false
)

// Ids cross the wire as both strings and numbers.
assert.equal(
  viewChannelOverride([ow(String(MOD), 'role', VIEW)], { roleIds: [MOD], userId: ME }),
  true
)

console.log('permissions self-check ok')
