// The body of the sidecar's `preview` request (native/media-engine/PROTOCOL.md), from what
// the renderer asked: only the protocol's three fields, each an integer in its range, or
// null when one is not. Kept apart from mediaEngine.js, which imports Electron, so it can be
// tested.
export const PREVIEW_LIMITS = {
  fps: [0, 10],
  max_width: [16, 1280],
  max_height: [16, 720]
}

export function previewRequestBody(request) {
  const body = {}
  for (const [field, [min, max]] of Object.entries(PREVIEW_LIMITS)) {
    const value = request?.[field]
    if (!Number.isInteger(value) || value < min || value > max) return null
    body[field] = value
  }
  return body
}

// PYLON_NATIVE_PREVIEW=<width>x<height>@<fps> (development only, B5 of
// .plans/native-media-engine-preview-cost.md): the size and rate the renderer asks for instead
// of its own, as a `preview` request's { fps, max_width, max_height }, within the limits above
// (a rate of 1 to 10: 0 would be no preview). Anything else is null, and ignored.
export function previewOverride(raw) {
  const match = /^([1-9]\d*)x([1-9]\d*)@([1-9]\d*)$/.exec(typeof raw === 'string' ? raw.trim() : '')
  if (!match) return null
  const [maxWidth, maxHeight, fps] = match.slice(1).map(Number)
  return previewRequestBody({ fps, max_width: maxWidth, max_height: maxHeight })
}
