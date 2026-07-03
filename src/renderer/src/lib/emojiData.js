// Full emoji set, grouped for the chat emoji picker. Sourced from
// unicode-emoji-json so we don't hand-maintain thousands of emojis here.
import groups from 'unicode-emoji-json/data-by-group.json'

// Representative emoji shown on each category tab.
const GROUP_ICONS = {
  smileys_emotion: '😀',
  people_body: '👋',
  animals_nature: '🐵',
  food_drink: '🍔',
  travel_places: '✈️',
  activities: '⚽',
  objects: '💡',
  symbols: '❤️',
  flags: '🏁'
}

// Windows' system emoji font can't render regional-indicator country flags or
// tag-sequence subdivision flags (England/Scotland/Wales) - they show as the
// region's letters instead. Hide those on Windows so users don't pick a broken
// glyph; other platforms render them fine, so they stay there.
const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

function isUnsupportedFlag(emoji) {
  for (const ch of emoji) {
    const cp = ch.codePointAt(0)
    // Regional indicator symbols (country flags) or tag chars (subdivision flags)
    if ((cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0xe0020 && cp <= 0xe007f)) {
      return true
    }
  }
  return false
}

// Normalized groups: { slug, name, icon, emojis: [{ emoji, name, slug }] }
export const EMOJI_GROUPS = groups.map((group) => {
  const emojis =
    isWindows && group.slug === 'flags'
      ? group.emojis.filter((e) => !isUnsupportedFlag(e.emoji))
      : group.emojis
  return {
    slug: group.slug,
    name: group.name,
    icon: GROUP_ICONS[group.slug] || emojis[0]?.emoji,
    emojis: emojis.map((e) => ({ emoji: e.emoji, name: e.name, slug: e.slug }))
  }
})

const ALL_EMOJIS = EMOJI_GROUPS.flatMap((group) => group.emojis)

// Match emoji whose name/slug contains every whitespace-separated token in the
// query, so "red heart" or "grinning big" narrow results as you'd expect.
export function searchEmojis(query) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  return ALL_EMOJIS.filter((e) =>
    tokens.every((token) => e.name.includes(token) || e.slug.includes(token))
  )
}
