// "Watch together" on a YouTube embed in chat: the one place the shell writes an activity's
// action. It attaches to the room's controller, waits for `joined`, sends `add`, and detaches when the reply
// comes.

export const WATCH_TOGETHER = 'watch_together'
export const JOIN_WAIT_MS = 10_000
const MAX_TITLE = 120

const ERRORS = new Map([
  ['adding_locked', 'Only the leader can add videos'],
  ['queue_full', 'The queue is full'],
  ['too_many_queued', 'You have 10 videos queued already']
])
export const NO_ROOM_TEXT = "Couldn't reach the room"

const errorText = (reason) => ERRORS.get(reason) ?? String(reason)

const TIMERS = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer)
}

// Adds the video to the room behind `controller`. Resolves null once the room has taken it, or
// with the text for the toast.
export function addVideo(controller, videoId, title, deps = TIMERS) {
  return new Promise((resolve) => {
    let timer = null
    let unsubscribe = null
    let view = null
    let finished = false
    const done = (error) => {
      if (finished) return
      finished = true
      deps.clearTimer(timer)
      unsubscribe?.()
      view?.detach()
      resolve(error)
    }
    const send = () => {
      deps.clearTimer(timer)
      unsubscribe?.()
      unsubscribe = null
      const action = {
        type: 'add',
        video_id: videoId,
        title: [...(title ?? '')].slice(0, MAX_TITLE).join('')
      }
      const result = controller.sendAction(view.viewId, 1, action)
      if (result !== 'sent') done(errorText(result))
    }
    view = controller.attach({
      onReply: (reply) => done(reply.type === 'ok' ? null : errorText(reply.reason))
    })
    if (controller.state.status === 'joined') {
      send()
      return
    }
    timer = deps.setTimer(() => done(NO_ROOM_TEXT), JOIN_WAIT_MS)
    unsubscribe = controller.subscribe((state) => {
      if (state.status === 'joined' && !finished) send()
    })
  })
}
