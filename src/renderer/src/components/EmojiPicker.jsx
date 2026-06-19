import { useState, useMemo, useRef, useEffect } from 'react'
import { IconSearch } from '@tabler/icons-react'
import { EMOJI_GROUPS, searchEmojis } from '../lib/emojiData'

// Full emoji picker with category tabs and search. Renders one category (or
// the search results) at a time to stay responsive across ~1900 emoji.
function EmojiPicker({ onSelect }) {
  const [activeGroup, setActiveGroup] = useState(EMOJI_GROUPS[0].slug)
  const [query, setQuery] = useState('')
  const gridRef = useRef(null)
  const searchRef = useRef(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const trimmed = query.trim()
  const searching = trimmed.length > 0

  const emojis = useMemo(() => {
    if (searching) return searchEmojis(trimmed)
    return EMOJI_GROUPS.find((g) => g.slug === activeGroup)?.emojis ?? []
  }, [searching, trimmed, activeGroup])

  const heading = searching
    ? `Results (${emojis.length})`
    : EMOJI_GROUPS.find((g) => g.slug === activeGroup)?.name

  // Jump back to the top whenever the visible set changes
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = 0
  }, [activeGroup, trimmed])

  return (
    <div className="chat-emoji-picker">
      <div className="chat-emoji-search">
        <IconSearch size={16} />
        <input
          ref={searchRef}
          type="text"
          placeholder="Search emoji"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {!searching && (
        <div className="chat-emoji-tabs">
          {EMOJI_GROUPS.map((group) => (
            <button
              key={group.slug}
              type="button"
              className={`chat-emoji-tab${group.slug === activeGroup ? ' active' : ''}`}
              title={group.name}
              onClick={() => setActiveGroup(group.slug)}
            >
              {group.icon}
            </button>
          ))}
        </div>
      )}

      <div className="chat-emoji-grid" ref={gridRef}>
        <div className="chat-emoji-group-label">{heading}</div>
        {emojis.length > 0 ? (
          <div className="chat-emoji-grid-items">
            {emojis.map((e) => (
              <button
                key={e.slug}
                type="button"
                className="chat-emoji-btn"
                title={e.name}
                onClick={() => onSelect(e.emoji)}
              >
                {e.emoji}
              </button>
            ))}
          </div>
        ) : (
          <div className="chat-emoji-empty">No emoji found</div>
        )}
      </div>
    </div>
  )
}

export default EmojiPicker
