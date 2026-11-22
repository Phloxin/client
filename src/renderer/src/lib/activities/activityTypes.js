// How each activity looks on its chat card, keyed by the server's activity id. The name shown is
// always the server's, never one from here.

import {
  IconCards,
  IconChess,
  IconCircles,
  IconDeviceGamepad2,
  IconDeviceTv,
  IconTicTac
} from '@tabler/icons-react'

export const ACTIVITY_TYPES = {
  tic_tac_toe: { icon: IconTicTac, endedVerb: 'played' },
  connect4: { icon: IconCircles, endedVerb: 'played' },
  uno: { icon: IconCards, endedVerb: 'played' },
  chess: { icon: IconChess, endedVerb: 'played' },
  watch_together: { icon: IconDeviceTv, endedVerb: 'watched' }
}

export const FALLBACK_ACTIVITY_TYPE = { icon: IconDeviceGamepad2, endedVerb: 'took part' }

export const activityType = (id) =>
  Object.hasOwn(ACTIVITY_TYPES, id) ? ACTIVITY_TYPES[id] : FALLBACK_ACTIVITY_TYPE
