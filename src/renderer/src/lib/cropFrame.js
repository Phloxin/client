// Geometry for the avatar/icon crop frame. The frame is a square of `size`
// output pixels; zoom 1 is the cover fit (the old automatic center-crop), and
// the offset is the image centre's displacement from the frame centre, in
// output pixels.

export function coverScale(natW, natH, size) {
  return Math.max(size / natW, size / natH)
}

// Drawn size of the image at a given zoom.
export function scaledSize(natW, natH, size, zoom) {
  const scale = coverScale(natW, natH, size) * zoom
  return { w: natW * scale, h: natH * scale }
}

// How far out the user may zoom. Zoom is measured against the cover fit, so the
// contain fit (whole image visible, no crop at all) is this ratio; the margin
// takes it a little further so an icon with overhangs sits inside the frame
// rather than flush against it. The uncovered area is left transparent.
export function minZoom(natW, natH, margin = 0.8) {
  return (Math.min(natW, natH) / Math.max(natW, natH)) * margin
}

// Keep the image covering the frame — panning can never expose an edge. Below
// the cover fit there is nothing to pan: the axis is centred instead.
export function clampOffset(x, y, natW, natH, size, zoom) {
  const { w, h } = scaledSize(natW, natH, size, zoom)
  const maxX = Math.max(0, (w - size) / 2)
  const maxY = Math.max(0, (h - size) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y))
  }
}
