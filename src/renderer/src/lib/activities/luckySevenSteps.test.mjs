// Lucky Seven's steps.js (activities/ui/lucky_seven/steps.js), a plain bundle script with no DOM,
// loaded through node:vm. Snapshots are built by hand in the shape of the server's View
// (lucky_seven.rs), with seats 1, 2 and 3 playing.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const code = readFileSync(
  new URL('../../activities/ui/lucky_seven/steps.js', import.meta.url),
  'utf8'
)
const context = {}
context.window = context
vm.createContext(context)
vm.runInContext(code, context)
const { tally, arrange, repeats, dealOrder, diff } = context.l7steps

// Values from the vm's realm, compared by value, a Map as an object and a Set as an array.
const plain = (v) =>
  JSON.parse(
    JSON.stringify(v, (_key, x) => {
      const tag = Object.prototype.toString.call(x)
      if (tag === '[object Map]') return Object.fromEntries(x)
      if (tag === '[object Set]') return [...x]
      return x
    })
  )

const n = (id, value) => ({ id, face: 'number', value })
const plus = (id, value) => ({ id, face: 'plus', value })
const double = (id) => ({ id, face: 'double' })
const freeze = (id) => ({ id, face: 'freeze' })
const flip3 = (id) => ({ id, face: 'flip_three' })
const chance = (id) => ({ id, face: 'second_chance' })

// The server's score: numbers summed and doubled, then the plus cards and the seven bonus.
function scoreOf(cards, state) {
  if (state === 'busted') return 0
  let numbers = 0
  let plusses = 0
  for (const c of cards) if (c.face === 'number') numbers += c.value
  for (const c of cards) {
    if (c.face === 'double') numbers *= 2
    if (c.face === 'plus') plusses += c.value
  }
  return numbers + plusses + (state === 'seven' ? 15 : 0)
}
const hand = (client, cards, state = 'active') => ({
  client,
  cards,
  state,
  score: scoreOf(cards, state)
})

function round({
  number = 1,
  dealer = '1',
  players,
  turn = null,
  choice = null,
  until_ms = 5000,
  spent = []
}) {
  return { number, dealer, players, turn, choice, until_ms, spent }
}

function view({
  status = 'playing',
  winner = null,
  seats = ['1', '2', '3'],
  round = null,
  deck = 60,
  discard = 0,
  totals = { 1: 0, 2: 0, 3: 0 }
} = {}) {
  return {
    seats: [...seats, ...Array(10 - seats.length).fill(null)],
    leader: '1',
    status: status === 'over' ? { kind: 'over', winner } : { kind: status },
    away: [],
    totals,
    round,
    deck,
    discard,
    wins: { 1: 0, 2: 0, 3: 0 }
  }
}

const card = (client, c, from = 'deck') => ({ kind: 'card', client, card: c, from })

// Round 1, dealt by 1, each player holding one number and 2 to play.
const dealt = () => [hand('1', [n(11, 6)]), hand('2', [n(20, 7)]), hand('3', [n(30, 8)])]
const midRound = (patch = {}) =>
  view({ round: round({ players: dealt(), turn: '2', ...patch }), deck: 50, discard: 4 })

test('tally scores a hand as the server does, the double on the numbers only', () => {
  const faces = [n(0, 5), plus(80, 4), n(1, 3), double(84), chance(87)]
  assert.deepEqual(plain(tally(faces, 'stayed')), {
    values: [5, 3],
    sum: 8,
    doubles: 1,
    plus: 4,
    bonus: 0,
    total: 20,
    unique: 2
  })
  assert.equal(tally(faces, 'frozen').total, 20)
  assert.equal(tally(faces, 'active').total, 20)
  // Where the double lies makes no difference.
  assert.equal(tally([double(84), plus(80, 4), n(0, 5), n(1, 3)], 'stayed').total, 20)
})

test('tally gives a bust nothing and seven numbers 15 more', () => {
  const bust = tally([n(0, 5), plus(80, 4), n(1, 5)], 'busted')
  assert.equal(bust.total, 0)
  assert.equal(bust.unique, 1)
  const seven = tally(
    [0, 1, 2, 3, 4, 5, 6].map((v, i) => n(i, v)),
    'seven'
  )
  assert.equal(seven.total, 21 + 15)
  assert.equal(seven.bonus, 15)
  assert.equal(seven.unique, 7)
})

test('arrange puts the numbers low to high, then the plus cards, the double and the actions', () => {
  const cards = [
    flip3(91),
    n(10, 9),
    plus(83, 10),
    n(2, 2),
    double(84),
    plus(80, 2),
    chance(87),
    n(1, 2)
  ]
  const { numbers, extras } = arrange(cards)
  assert.deepEqual(
    plain(numbers).map((c) => c.id),
    [1, 2, 10]
  )
  // Action cards stay in the order they came.
  assert.deepEqual(
    plain(extras).map((c) => c.id),
    [80, 83, 84, 91, 87]
  )
})

test('repeats names the values a hand holds twice', () => {
  assert.deepEqual(plain(repeats([n(3, 3), n(5, 5), n(4, 3), freeze(90)])), [3])
  assert.deepEqual(plain(repeats([n(3, 3), n(5, 5)])), [])
})

test('dealOrder starts left of the dealer', () => {
  const players = [hand('1', []), hand('2', []), hand('3', [])]
  const order = (dealer) => plain(dealOrder(round({ dealer, players }))).map((p) => p.client)
  assert.deepEqual(order('1'), ['2', '3', '1'])
  assert.deepEqual(order('2'), ['3', '1', '2'])
  assert.deepEqual(order('3'), ['1', '2', '3'])
})

test('the first deal comes from the deck, starting left of the dealer', () => {
  const a = view({ status: 'waiting', deck: 0 })
  const b = view({ round: round({ players: dealt(), turn: '2' }), deck: 91 })
  const d = plain(diff(a, b))
  assert.equal(d.fresh, true)
  assert.deepEqual(d.steps, [card('2', n(20, 7)), card('3', n(30, 8)), card('1', n(11, 6))])
  for (const id of ['1', '2', '3']) {
    assert.deepEqual(d.before[id], { client: id, cards: [], state: 'active', score: 0 })
  }
  assert.deepEqual(d.stays, [])
  assert.equal(d.pick, null)
  assert.equal(d.ended, false)
  assert.deepEqual(d.gains, {})
  assert.equal(d.reshuffled, false)
})

test('a hit brings one card from the deck to the hitter', () => {
  const a = midRound()
  const b = midRound({
    players: [hand('1', [n(11, 6)]), hand('2', [n(20, 7), n(10, 5)]), hand('3', [n(30, 8)])],
    turn: '3'
  })
  const d = plain(diff(a, b))
  assert.equal(d.fresh, false)
  assert.deepEqual(d.steps, [card('2', n(10, 5))])
  assert.deepEqual(d.before['2'].cards, [n(20, 7)])
  assert.deepEqual(d.stays, [])
  assert.equal(d.ended, false)
})

test('a bust is the repeated number landing, the hand it started from active', () => {
  const b = midRound({
    players: [
      hand('1', [n(11, 6)]),
      hand('2', [n(20, 7), n(21, 7)], 'busted'),
      hand('3', [n(30, 8)])
    ],
    turn: '3'
  })
  const d = plain(diff(midRound(), b))
  assert.deepEqual(d.steps, [card('2', n(21, 7))])
  assert.equal(d.before['2'].state, 'active')
  assert.equal(d.ended, false)
})

test('a stay with no card is in stays, with no step', () => {
  const b = midRound({
    players: [hand('1', [n(11, 6)]), hand('2', [n(20, 7)], 'stayed'), hand('3', [n(30, 8)])],
    turn: '3'
  })
  const d = plain(diff(midRound(), b))
  assert.deepEqual(d.steps, [])
  assert.deepEqual(d.stays, ['2'])
})

test('a Second Chance spent on a hit is a save step with the repeat it cancelled', () => {
  const players = [hand('1', [n(11, 6)]), hand('2', [chance(87), n(20, 7)]), hand('3', [n(30, 8)])]
  const a = midRound({ players })
  const b = midRound({
    players: [hand('1', [n(11, 6)]), hand('2', [n(20, 7)]), hand('3', [n(30, 8)])],
    turn: '3',
    spent: [
      { client: '2', card: n(21, 7), why: 'repeat' },
      { client: '2', card: chance(87), why: 'second_chance' }
    ]
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [{ kind: 'save', client: '2', card: chance(87), repeat: n(21, 7) }])
  assert.deepEqual(d.stays, [])
})

test('a save comes after a Flip Three the server played on the hitter', () => {
  // 2 is the only one left, so the Flip Three it hits plays on 2 itself: a repeated 4, saved, then
  // a 9 and an 11.
  const a = midRound({
    players: [
      hand('1', [n(11, 6)], 'stayed'),
      hand('2', [chance(87), n(10, 4)]),
      hand('3', [n(30, 8)], 'stayed')
    ]
  })
  const b = midRound({
    players: [
      hand('1', [n(11, 6)], 'stayed'),
      hand('2', [n(10, 4), flip3(90), n(40, 9), n(50, 11)]),
      hand('3', [n(30, 8)], 'stayed')
    ],
    spent: [
      { client: '2', card: n(11, 4), why: 'repeat' },
      { client: '2', card: chance(87), why: 'second_chance' }
    ]
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [
    card('2', flip3(90)),
    { kind: 'save', client: '2', card: chance(87), repeat: n(11, 4) },
    card('2', n(40, 9)),
    card('2', n(50, 11))
  ])
})

test('a save comes after a given Flip Three when its target is saved', () => {
  const players = [hand('1', [n(11, 6)]), hand('2', [chance(87), n(20, 7)]), hand('3', [n(30, 8)])]
  const a = midRound({
    players,
    turn: null,
    choice: { by: '1', card: flip3(90), targets: ['1', '2', '3'] }
  })
  const b = midRound({
    players: [
      hand('1', [n(11, 6)]),
      hand('2', [n(20, 7), flip3(90), n(5, 3), n(40, 9)]),
      hand('3', [n(30, 8)])
    ],
    spent: [
      { client: '2', card: n(21, 7), why: 'repeat' },
      { client: '2', card: chance(87), why: 'second_chance' }
    ]
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [
    card('2', flip3(90), 'play'),
    { kind: 'save', client: '2', card: chance(87), repeat: n(21, 7) },
    card('2', n(5, 3)),
    card('2', n(40, 9))
  ])
})

test('a Second Chance spent in the change it arrived in is a save after the number it repeats', () => {
  // Given a Flip Three, 3 turns up a Second Chance, a 5 and another 5.
  const a = midRound({
    turn: null,
    choice: { by: '2', card: flip3(90), targets: ['1', '2', '3'] }
  })
  const b = midRound({
    players: [
      hand('1', [n(11, 6)]),
      hand('2', [n(20, 7)]),
      hand('3', [n(30, 8), flip3(90), n(15, 5)])
    ],
    spent: [
      { client: '3', card: n(16, 5), why: 'repeat' },
      { client: '3', card: chance(88), why: 'second_chance' }
    ]
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [
    card('3', flip3(90), 'play'),
    card('3', n(15, 5)),
    { kind: 'save', client: '3', card: chance(88), repeat: n(16, 5) }
  ])
})

test('an action card nobody could be given is a drop from the deck', () => {
  // 2 turns up a spare Second Chance: 1 has stayed and 3 holds one already.
  const players = [
    hand('1', [n(11, 6)], 'stayed'),
    hand('2', [chance(87), n(20, 7)]),
    hand('3', [chance(88), n(30, 8)])
  ]
  const a = midRound({ players })
  const b = midRound({
    players,
    turn: '3',
    spent: [{ client: '2', card: chance(86), why: 'unplayed' }]
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [{ kind: 'drop', client: '2', card: chance(86), from: 'deck' }])
  assert.equal(d.pick, null)
})

test('an action card lost when a Flip Three busts drops after the Flip Three', () => {
  // The server's a_bust_ends_flip_three_early_and_loses_its_action_cards: a 5, a Freeze, a 5.
  const a = midRound({
    turn: null,
    choice: { by: '2', card: flip3(90), targets: ['1', '2', '3'] }
  })
  const b = midRound({
    players: [
      hand('1', [n(11, 6)]),
      hand('2', [n(20, 7)]),
      hand('3', [n(30, 8), flip3(90), n(15, 5), n(16, 5)], 'busted')
    ],
    spent: [{ client: '3', card: freeze(91), why: 'unplayed' }]
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [
    card('3', flip3(90), 'play'),
    { kind: 'drop', client: '3', card: freeze(91), from: 'deck' },
    card('3', n(15, 5)),
    card('3', n(16, 5))
  ])
})

test('an action card left when the round ends drops after the Flip Three that turned it up', () => {
  // The server's a_choice_still_open_when_the_round_ends_is_spent_unplayed: 2 hits a Flip Three
  // that plays on 2 itself and turns up a 4, a Freeze and a second Flip Three.
  const a = midRound({
    players: [hand('1', [n(100, 1)], 'stayed'), hand('2', [n(101, 2)])]
  })
  const b = view({
    status: 'scoring',
    round: round({
      players: [
        hand('1', [n(100, 1)], 'stayed'),
        hand('2', [n(101, 2), flip3(90), n(103, 4), freeze(91)], 'frozen')
      ],
      spent: [{ client: '2', card: flip3(92), why: 'unplayed' }]
    }),
    deck: 46,
    discard: 5
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [
    card('2', flip3(90)),
    { kind: 'drop', client: '2', card: flip3(92), from: 'deck' },
    card('2', n(103, 4)),
    card('2', freeze(91))
  ])
  assert.equal(d.ended, true)
})

test('the card that was waiting for a target drops from play', () => {
  // The server does not spend the card in view this way today; diff reads it as `from: 'play'`.
  const a = midRound({
    turn: null,
    choice: { by: '2', card: freeze(91), targets: ['1', '2', '3'] }
  })
  const b = midRound({
    turn: '3',
    spent: [{ client: '2', card: freeze(91), why: 'unplayed' }]
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [{ kind: 'drop', client: '2', card: freeze(91), from: 'play' }])
  assert.equal(d.pick, null)
})

test('spent entries already in the snapshot before are not played again', () => {
  const spent = [
    { client: '2', card: n(21, 7), why: 'repeat' },
    { client: '2', card: chance(87), why: 'second_chance' }
  ]
  const a = midRound({ turn: '3', spent })
  const b = midRound({
    players: [hand('1', [n(11, 6)]), hand('2', [n(20, 7)]), hand('3', [n(30, 8), n(31, 9)])],
    turn: '1',
    spent: [...spent, { client: '3', card: freeze(91), why: 'unplayed' }]
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [
    { kind: 'drop', client: '3', card: freeze(91), from: 'deck' },
    card('3', n(31, 9))
  ])
  // Nothing new spent, nothing played.
  assert.deepEqual(plain(diff(a, midRound({ turn: '3', spent }))).steps, [])
})

test('a choice resolved in the deal: the given card goes first, from play, then the deal', () => {
  // Dealt by 1: 2 turned up a Freeze and gives it to 3, who is skipped; the deal goes on to 1.
  const empty = [hand('1', []), hand('2', []), hand('3', [])]
  const a = view({
    round: round({
      players: empty,
      choice: { by: '2', card: freeze(91), targets: ['1', '2', '3'] }
    }),
    deck: 93
  })
  const b = view({
    round: round({
      players: [hand('1', [n(11, 6)]), hand('2', []), hand('3', [freeze(91)], 'frozen')],
      turn: '2'
    }),
    deck: 92
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [card('3', freeze(91), 'play'), card('1', n(11, 6))])
  assert.deepEqual(d.stays, [])
  assert.equal(d.pick, null)
})

test('a given Flip Three’s cards follow it, and an action it turns up is the new pick', () => {
  const a = midRound({
    turn: null,
    choice: { by: '1', card: flip3(90), targets: ['1', '2', '3'] }
  })
  const b = midRound({
    players: [
      hand('1', [n(11, 6)]),
      hand('2', [n(20, 7)]),
      hand('3', [n(30, 8), flip3(90), n(5, 3), n(40, 9)])
    ],
    choice: { by: '3', card: freeze(91), targets: ['1', '2', '3'] }
  })
  const d = plain(diff(a, b))
  assert.deepEqual(d.steps, [card('3', flip3(90), 'play'), card('3', n(5, 3)), card('3', n(40, 9))])
  assert.deepEqual(d.pick, freeze(91))
})

test('an action card turned up on a hit is the pick, with no step', () => {
  const b = midRound({ choice: { by: '2', card: flip3(90), targets: ['1', '2', '3'] } })
  const d = plain(diff(midRound(), b))
  assert.deepEqual(d.steps, [])
  assert.deepEqual(d.pick, flip3(90))
  // Still waiting in the next snapshot, it is not picked again.
  assert.equal(plain(diff(b, { ...b, away: ['3'] })).pick, null)
})

test('a first deal that stops for a choice picks it', () => {
  const b = view({
    round: round({
      players: [hand('1', []), hand('2', []), hand('3', [])],
      choice: { by: '2', card: freeze(91), targets: ['1', '2', '3'] }
    }),
    deck: 93
  })
  const d = plain(diff(view({ status: 'waiting', deck: 0 }), b))
  assert.equal(d.fresh, true)
  assert.deepEqual(d.steps, [])
  assert.deepEqual(d.pick, freeze(91))
})

test('the round ending brings each player’s points as gains', () => {
  const a = midRound({
    players: [
      hand('1', [n(11, 6), plus(80, 4)], 'stayed'),
      hand('2', [n(20, 7)]),
      hand('3', [n(30, 8), n(31, 8)], 'busted')
    ]
  })
  const b = view({
    status: 'scoring',
    round: round({
      players: [
        hand('1', [n(11, 6), plus(80, 4)], 'stayed'),
        hand('2', [n(20, 7)], 'stayed'),
        hand('3', [n(30, 8), n(31, 8)], 'busted')
      ]
    }),
    totals: { 1: 10, 2: 7, 3: 0 }
  })
  const d = plain(diff(a, b))
  assert.equal(d.ended, true)
  assert.deepEqual(d.gains, { 1: 10, 2: 7, 3: 0 })
  assert.deepEqual(d.stays, ['2'])
  assert.deepEqual(d.steps, [])

  // A game won in that round ends it the same way.
  const over = plain(diff(a, { ...b, status: { kind: 'over', winner: '1' } }))
  assert.equal(over.ended, true)
  assert.deepEqual(over.gains, { 1: 10, 2: 7, 3: 0 })
})

test('a seven ends the round with its bonus in the gains', () => {
  const six = [0, 1, 2, 3, 4, 5].map((v) => n(v, v))
  const a = midRound({
    players: [hand('1', [n(11, 6)], 'stayed'), hand('2', six), hand('3', [n(30, 8)])]
  })
  const b = view({
    status: 'scoring',
    round: round({
      players: [
        hand('1', [n(11, 6)], 'stayed'),
        hand('2', [...six, n(20, 7)], 'seven'),
        hand('3', [n(30, 8)])
      ]
    }),
    totals: { 1: 6, 2: 37, 3: 8 }
  })
  const d = plain(diff(a, b))
  assert.equal(d.ended, true)
  assert.deepEqual(d.steps, [card('2', n(20, 7))])
  assert.deepEqual(d.gains, { 1: 6, 2: 22 + 15, 3: 8 })
})

test('a new round is fresh and deals from left of its dealer', () => {
  const a = view({
    status: 'scoring',
    round: round({ players: dealt() }),
    totals: { 1: 6, 2: 7, 3: 8 }
  })
  const b = view({
    round: round({
      number: 2,
      dealer: '2',
      players: [hand('1', [n(12, 6)]), hand('2', [n(22, 7)]), hand('3', [n(32, 8)])],
      turn: '3'
    }),
    totals: { 1: 6, 2: 7, 3: 8 }
  })
  const d = plain(diff(a, b))
  assert.equal(d.fresh, true)
  assert.deepEqual(d.steps, [card('3', n(32, 8)), card('1', n(12, 6)), card('2', n(22, 7))])
  assert.deepEqual(d.before['1'].cards, [])
  assert.equal(d.ended, false)
})

test('a new game whose round number equals the last game’s is fresh', () => {
  const a = view({
    status: 'over',
    round: round({ players: dealt() }),
    totals: { 1: 6, 2: 7, 3: 8 }
  })
  const b = view({
    round: round({
      players: [hand('1', [n(12, 6)]), hand('2', [n(22, 7)]), hand('3', [n(32, 8)])],
      turn: '2'
    }),
    deck: 91
  })
  const d = plain(diff(a, b))
  assert.equal(d.fresh, true)
  assert.deepEqual(
    d.steps.map((s) => s.card.id),
    [22, 32, 12]
  )
  assert.equal(d.ended, false)
  assert.equal(d.reshuffled, false)
})

test('a reshuffle is the deck growing as the discard pile shrinks, in a game', () => {
  const a = { ...midRound(), deck: 0, discard: 40 }
  const b = {
    ...midRound({
      players: [hand('1', [n(11, 6)]), hand('2', [n(20, 7), n(10, 5)]), hand('3', [n(30, 8)])],
      turn: '3'
    }),
    deck: 39,
    discard: 0
  }
  assert.equal(diff(a, b).reshuffled, true)
  assert.equal(
    diff({ ...a, deck: 40, discard: 0 }, { ...b, deck: 39, discard: 0 }).reshuffled,
    false
  )
  // A new game's full deck is not a reshuffle.
  const over = view({ status: 'over', round: round({ players: dealt() }), deck: 2, discard: 60 })
  const start = view({ round: round({ players: dealt(), turn: '2' }), deck: 91, discard: 0 })
  assert.equal(diff(over, start).reshuffled, false)
})

test('no round, no snapshot before, or other players in the same round give null', () => {
  const b = midRound()
  assert.equal(diff(null, b), null)
  assert.equal(diff(b, view({ status: 'waiting' })), null)
  const two = midRound({ players: [hand('1', [n(11, 6)]), hand('2', [n(20, 7)])] })
  assert.equal(diff(b, two), null)
})

test('seats changing after the game is over play nothing', () => {
  const last = round({ number: 9, players: dealt() })
  const a = view({ status: 'over', winner: '1', round: last, totals: { 1: 210, 2: 150, 3: 90 } })
  const b = {
    ...a,
    seats: ['1', '2', null, '4', null, null, null, null, null, null]
  }
  const d = plain(diff(a, b))
  assert.equal(d.fresh, false)
  assert.deepEqual(d.steps, [])
  assert.deepEqual(d.stays, [])
  assert.equal(d.pick, null)
  assert.equal(d.ended, false)
  assert.deepEqual(d.gains, {})
})
