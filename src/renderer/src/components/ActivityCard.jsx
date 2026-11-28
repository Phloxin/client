/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { IconPlayerPlay, IconTrophy } from '@tabler/icons-react'
import { useAnimationCategory } from '../context/SettingsContext'
import {
  activityCardMeta,
  activityCardModel,
  activityFooterLabel,
  formatScore
} from '../lib/activities/cards'
import { activityType } from '../lib/activities/activityTypes'
import { useElapsed } from '../lib/activities/useElapsed'
import { avatarStack, avatarStackItem } from '../lib/motionPresets'
import './ActivityCard.css'

const STACK_MAX = 3
const SCOREBOARD_ROWS = 4
const FADE = { duration: 0.18, ease: 'easeOut' }

// Its own component so each tick redraws only this text.
function LiveTimer({ startedAt }) {
  return useElapsed(startedAt, true)
}

function AvatarStack({ ids, lookup, anim }) {
  const shown = ids.slice(0, STACK_MAX)
  const hidden = ids.slice(STACK_MAX)
  const item = anim ? { variants: avatarStackItem, exit: 'hidden' } : {}
  return (
    <AnimatePresence initial={false}>
      {ids.length > 0 && (
        <motion.span className="activity-card-stack" {...avatarStack(anim)}>
          <AnimatePresence initial={false}>
            {shown.map((id) => {
              const person = lookup(id)
              return (
                <motion.span
                  key={id}
                  className="activity-card-avatar"
                  role="img"
                  title={person.name}
                  aria-label={person.name}
                  {...item}
                >
                  {person.avatar ? <img src={person.avatar} alt="" /> : person.initial}
                </motion.span>
              )
            })}
            {hidden.length > 0 && (
              <motion.span
                key="more"
                className="activity-card-avatar activity-card-more"
                title={hidden.map((id) => lookup(id).name).join(', ')}
                {...item}
              >
                +{hidden.length}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.span>
      )}
    </AnimatePresence>
  )
}

function Scoreboard({ results, signed, trophy, lookup }) {
  const [expanded, setExpanded] = useState(false)
  const rows = expanded ? results : results.slice(0, SCOREBOARD_ROWS)
  return (
    <div className="activity-card-scores">
      <ol className="activity-card-score-list">
        {rows.map((r, i) => {
          const person = lookup(r.clientId)
          return (
            <li key={r.clientId} className="activity-card-score">
              <span className="activity-card-avatar" aria-hidden="true">
                {person.avatar ? <img src={person.avatar} alt="" /> : person.initial}
              </span>
              <span className="activity-card-score-name">{person.name}</span>
              {i === 0 && trophy && (
                <IconTrophy
                  size={15}
                  stroke={2}
                  className="activity-card-trophy"
                  role="img"
                  aria-label="Winner"
                />
              )}
              <span className="activity-card-score-value">{formatScore(r.score, signed)}</span>
            </li>
          )
        })}
      </ol>
      {results.length > SCOREBOARD_ROWS && (
        <button
          type="button"
          className="activity-card-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `Show all (${results.length})`}
        </button>
      )}
    </div>
  )
}

export default function ActivityCard({
  entry,
  room,
  lookup,
  selfId,
  hasTab,
  access,
  onJoinRoom,
  formatTime
}) {
  const anim = useAnimationCategory('messages')
  const model = activityCardModel(entry, room)
  const { icon: Icon, endedVerb } = activityType(model.activityId)
  const live = model.status === 'live'
  const meta = activityCardMeta(model, {
    creatorName: lookup(entry.authorId).name,
    isOwn: selfId != null && String(entry.authorId) === String(selfId),
    formatTime
  })
  const fade = anim
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: FADE }
    : {}
  const unsupported = access === 'unsupported'

  return (
    <div className={`activity-card${live ? ' is-live' : ''}`}>
      <div className="activity-card-header">
        <span className="activity-card-tile" aria-hidden="true">
          <Icon size={22} stroke={1.8} />
        </span>
        <div className="activity-card-heading">
          <span className="activity-card-name">{model.name}</span>
          <span className="activity-card-meta">{meta}</span>
        </div>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={model.status}
            className={`activity-card-pill${live ? ' is-live' : ''}`}
            {...fade}
          >
            {live ? (
              <>
                <span className="activity-card-dot" aria-hidden="true" />
                <span>
                  Live · <LiveTimer startedAt={model.startedAt} />
                </span>
              </>
            ) : (
              'Ended'
            )}
          </motion.span>
        </AnimatePresence>
      </div>
      {model.detail && (
        <div className="activity-card-detail" title={model.detail}>
          <IconPlayerPlay size={14} stroke={2} aria-hidden="true" />
          <span>{model.detail}</span>
        </div>
      )}
      <AnimatePresence initial={false} mode="popLayout">
        {model.footer && (
          <motion.div key={model.footer} className="activity-card-footer" {...fade}>
            {model.footer === 'scoreboard' ? (
              <Scoreboard
                results={model.results}
                signed={model.signed}
                trophy={model.trophy}
                lookup={lookup}
              />
            ) : (
              <>
                <AvatarStack ids={model.participants} lookup={lookup} anim={anim} />
                <span className="activity-card-label">{activityFooterLabel(model, endedVerb)}</span>
                {model.footer === 'room' && (
                  <button
                    type="button"
                    className="activity-card-join"
                    disabled={unsupported}
                    title={unsupported ? 'This server does not support activities' : undefined}
                    onClick={() => onJoinRoom?.(model.roomId)}
                  >
                    {hasTab ? 'Open' : 'Join'}
                  </button>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
