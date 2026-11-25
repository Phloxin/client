// Watch Together's sync and link parsing: pure functions, one global, no DOM, so the tests can load
// this file through node:vm. Times are in ms. `now` is server time (Date.now() plus the room's
// clock offset); `local` is Date.now(), used for what the local player did and when.
;(() => {
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
  const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com'
  ])
  const ID_PATHS = new Set(['shorts', 'embed', 'live'])

  // Over this far from the room's position, the player is moved there.
  const DRIFT_PLAYING_MS = 1500
  const DRIFT_PAUSED_MS = 500
  // At most one corrective seek this often.
  const SEEK_GAP_MS = 2000
  // Buffering this long no longer holds a corrective seek back.
  const BUFFER_GRACE_MS = 8000
  // A load or seek must have settled this close to the room's position this soon.
  const SETTLE_MS = 8000
  const SETTLE_WITHIN_MS = 1500
  const MAX_RELOADS = 3
  // The player error taken as a stall: HTML5 player error, seen on videos that play.
  const RETRIED_ERROR = 5
  // Playing this long with no duration: live.
  const LIVE_AFTER_MS = 5000
  // A rate asked for and not reported yet is asked again after this.
  const RATE_RETRY_MS = 2000
  const MAX_POSITION_MS = 86_400_000

  // The video id in a pasted link or a bare id, or null.
  function parseVideoLink(text) {
    const s = String(text ?? '').trim()
    if (VIDEO_ID.test(s)) return s
    let url
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase()
    const parts = url.pathname.split('/')
    let id = null
    if (host === 'youtu.be') id = parts[1]
    else if (YOUTUBE_HOSTS.has(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v')
      else if (ID_PATHS.has(parts[1])) id = parts[2]
    }
    return id && VIDEO_ID.test(id) ? id : null
  }

  const rateOf = (current) => current?.rate ?? 100
  const clampMs = (ms) => Math.min(MAX_POSITION_MS, Math.max(0, Math.round(ms)))

  // Where the current entry is now, as the room has it.
  function targetMs(current, now) {
    if (!current) return 0
    if (!current.playing) return current.position_ms
    return current.position_ms + (Math.max(0, now - current.at_ms) * rateOf(current)) / 100
  }

  const inLeadIn = (current, now) => !!current && current.playing && now < current.at_ms

  // The countdown's number: 3, 2, 1, or 0 outside the lead-in.
  const leadInSeconds = (current, now) =>
    inLeadIn(current, now) ? Math.ceil((current.at_ms - now) / 1000) : 0

  // The local player's position now, extrapolated from its last status while it plays.
  function playerMs(status, statusAt, local) {
    if (!status) return 0
    if (status.state !== 'playing') return status.positionMs
    return status.positionMs + (Math.max(0, local - statusAt) * (status.rate ?? 100)) / 100
  }

  // What reconcile remembers about the loaded entry.
  const initialMemory = () => ({
    loadedEntry: null,
    pending: null,
    lastSeekAt: -Infinity,
    reloads: 0,
    stalled: false,
    error: null,
    endedSent: null,
    unplayableSent: null,
    bufferingSince: null,
    playingSince: null,
    live: false,
    rateSent: null,
    rateSentAt: -Infinity
  })

  // A fresh memory for a newly loaded entry; what was sent once per entry is kept.
  const forEntry = (mem, entryId, local) => ({
    ...initialMemory(),
    endedSent: mem.endedSent,
    unplayableSent: mem.unplayableSent,
    loadedEntry: entryId,
    pending: { since: local }
  })

  const loadCommand = (current, now) => ({
    op: 'load',
    videoId: current.entry.video_id,
    startMs: clampMs(targetMs(current, now)),
    play: current.playing && !inLeadIn(current, now)
  })

  // input: { current (view.current or null), now, local, ready (the player has
  // said ready), status (the last player status or null) and statusAt (local time it came) }.
  // Returns { mem, commands }: player ops ({ op, ... }) and actions the user did not click
  // ({ action }).
  function reconcile(mem, input) {
    const { current, now, local, ready, status, statusAt } = input
    if (!ready) return { mem, commands: [] }
    // 1. Nothing current.
    if (!current) {
      if (mem.loadedEntry == null) return { mem, commands: [] }
      return {
        mem: { ...initialMemory(), endedSent: mem.endedSent, unplayableSent: mem.unplayableSent },
        commands: [{ op: 'unload' }]
      }
    }
    const entryId = current.entry.id
    // 2. A new entry, or a retry.
    if (mem.loadedEntry !== entryId) {
      return { mem: forEntry(mem, entryId, local), commands: [loadCommand(current, now)] }
    }
    // 8. An error waits for the room to move on; a stall for Retry.
    if (mem.error != null || mem.stalled) return { mem, commands: [] }

    const commands = []
    const state = status?.state ?? 'loading'
    const lead = inLeadIn(current, now)
    const roomPlaying = current.playing && !lead
    const target = targetMs(current, now)
    const pos = playerMs(status, statusAt, local)
    let next = { ...mem }
    next.bufferingSince = state === 'buffering' ? (mem.bufferingSince ?? local) : null
    if (state === 'playing' && next.playingSince == null) next.playingSince = local
    if ((status?.durationMs ?? 0) > 0) next.live = false
    else if (next.playingSince != null && local - next.playingSince >= LIVE_AFTER_MS)
      next.live = true

    // 7. The end, reported once.
    if (state === 'ended') {
      if (roomPlaying && next.endedSent !== entryId) {
        next.endedSent = entryId
        commands.push({ action: { type: 'ended', entry_id: entryId } })
      }
      return { mem: next, commands }
    }

    // 6. A load or seek that has not settled.
    if (next.pending) {
      const settled =
        (state === 'playing' || state === 'paused' || state === 'cued') &&
        Math.abs(pos - target) <= SETTLE_WITHIN_MS
      if (settled) next.pending = null
      else if (local - next.pending.since >= SETTLE_MS) {
        if (next.reloads >= MAX_RELOADS) {
          next.stalled = true
          next.pending = null
          return { mem: next, commands }
        }
        next.reloads += 1
        next.pending = { since: local }
        next.lastSeekAt = local
        commands.push(loadCommand(current, now))
        return { mem: next, commands }
      }
    }

    // 3 and 4. Held at 0 through the lead-in, then the room's play or pause.
    if (lead && (state === 'playing' || state === 'buffering')) commands.push({ op: 'pause' })
    else if (roomPlaying && (state === 'paused' || state === 'cued')) commands.push({ op: 'play' })
    else if (!current.playing && state === 'playing') commands.push({ op: 'pause' })

    // 5. Drift.
    const buffering = state === 'buffering' && local - next.bufferingSince < BUFFER_GRACE_MS
    if (
      commands.length === 0 &&
      !next.live &&
      state !== 'loading' &&
      !buffering &&
      local - next.lastSeekAt >= SEEK_GAP_MS
    ) {
      const off = Math.abs(pos - target)
      // Buffering for 8 s or more may be sought out of, as if it played.
      const drifted =
        (roomPlaying && (state === 'playing' || state === 'buffering') && off > DRIFT_PLAYING_MS) ||
        (!roomPlaying && (state === 'paused' || state === 'cued') && off > DRIFT_PAUSED_MS)
      if (drifted) {
        commands.push({ op: 'seek', positionMs: clampMs(target) })
        next.lastSeekAt = local
        // Rule 6 counts from the first load or seek that has not settled.
        next.pending = next.pending ?? { since: local }
      }
    }

    // The room's speed.
    const rate = rateOf(current)
    if (
      status &&
      state !== 'loading' &&
      status.rate !== rate &&
      (next.rateSent !== rate || local - next.rateSentAt >= RATE_RETRY_MS)
    ) {
      commands.push({ op: 'rate', rate })
      next.rateSent = rate
      next.rateSentAt = local
    }
    return { mem: next, commands }
  }

  // A player error for the loaded entry. Error 5 is loaded again while the stall reloads last;
  // it and every other error are then shown with no retry and reported once. input: { current, now, local }, as for reconcile.
  function onPlayerError(mem, code, input) {
    if (mem.loadedEntry == null) return { mem, commands: [] }
    const { current, now, local } = input ?? {}
    if (
      code === RETRIED_ERROR &&
      mem.reloads < MAX_RELOADS &&
      current?.entry.id === mem.loadedEntry
    ) {
      return {
        mem: { ...mem, reloads: mem.reloads + 1, pending: { since: local }, lastSeekAt: local },
        commands: [loadCommand(current, now)]
      }
    }
    const next = { ...mem, error: code, pending: null }
    const commands = []
    if (mem.unplayableSent !== mem.loadedEntry) {
      next.unplayableSent = mem.loadedEntry
      commands.push({ action: { type: 'unplayable', entry_id: mem.loadedEntry } })
    }
    return { mem: next, commands }
  }

  // Retry after "Playback stalled": load the entry again with a fresh count.
  const retry = (mem) => ({ ...mem, loadedEntry: null, reloads: 0, stalled: false })

  window.watchSync = {
    parseVideoLink,
    targetMs,
    inLeadIn,
    leadInSeconds,
    playerMs,
    initialMemory,
    reconcile,
    onPlayerError,
    retry
  }
})()
