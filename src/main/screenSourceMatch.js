// Finds a screen or window capture source again after its id has changed,
// which can happen when the shared window gets rebuilt. Matching falls back
// to the source name since the id can no longer be trusted.
//
// Kept free of desktopCapturer so the matching logic can be unit tested.

// desktopCapturer ids look like 'screen:0:0' or 'window:1234:0'. A window
// should never be matched against a monitor, or the other way around, just
// because the names look similar.
export function screenSourceKind(id) {
  return typeof id === 'string' && id.startsWith('screen:') ? 'screen' : 'window'
}

function normalizeName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : ''
}

// Window titles can change slightly (a tab gains or loses a suffix, an app
// appends a file name), so check containment in both directions.
function namesOverlap(candidate, wanted) {
  if (!candidate || !wanted) return false
  return candidate.includes(wanted) || wanted.includes(candidate)
}

// Returns the source the previous share should resume into, or null if the
// match is unclear. An unclear match is treated as a failure on purpose,
// since capturing the wrong window would expose its contents.
export function matchScreenSource(sources, { id, name } = {}) {
  const kind = screenSourceKind(id)
  const candidates = (sources ?? []).filter(
    (source) => typeof source?.id === 'string' && screenSourceKind(source.id) === kind
  )

  // If the id still exists, nothing was rebuilt and no matching is needed.
  const byId = candidates.find((source) => source.id === id)
  if (byId) return byId

  const wanted = normalizeName(name)
  if (!wanted) return null

  const exact = candidates.filter((source) => normalizeName(source.name) === wanted)
  if (exact.length > 0) return exact.length === 1 ? exact[0] : null

  const overlapping = candidates.filter((source) =>
    namesOverlap(normalizeName(source.name), wanted)
  )
  return overlapping.length === 1 ? overlapping[0] : null
}
