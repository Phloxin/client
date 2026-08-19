import { useEffect, useRef, useState } from 'react'
import './ImageCropper.css'
import { clampOffset, minZoom, scaledSize } from '../lib/cropFrame'

// Output pixels. The preview frame is the same size on screen, so drag/zoom
// numbers map 1:1 onto what gets drawn — no second coordinate space.
const SIZE = 256
const MAX_ZOOM = 4
const ZOOM_STEP = 0.002

// Drag/zoom the picked image inside the square that avatars and channel icons
// are drawn into, so a portrait photo isn't blindly centre-cropped. Rendered
// outside the app tree (see openImageCropper), so it uses no React context.
function ImageCropper({ src, onDone }) {
  const [nat, setNat] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const imgRef = useRef(null)
  const frameRef = useRef(null)
  const dragRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onDone(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDone])

  // Zoom 1 fills the frame; below it the image shrinks inside the frame (the
  // rest stays transparent) so overhangs aren't cut off.
  const min = nat ? minZoom(nat.w, nat.h) : 1

  // Zooming out can leave the pan outside the new bounds, so re-clamp with it.
  const applyZoom = (next) => {
    const z = Math.min(MAX_ZOOM, Math.max(min, next))
    setZoom(z)
    if (nat) setOffset((prev) => clampOffset(prev.x, prev.y, nat.w, nat.h, SIZE, z))
  }

  // Native (non-passive) so the wheel zooms the frame instead of scrolling
  // whatever sits behind the overlay — React's onWheel is passive.
  useEffect(() => {
    const el = frameRef.current
    if (!el || !nat) return
    const onWheel = (e) => {
      e.preventDefault()
      applyZoom(zoom - e.deltaY * ZOOM_STEP * zoom)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const handlePointerDown = (e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, origin: offset }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e) => {
    const drag = dragRef.current
    if (!drag || !nat) return
    setOffset(
      clampOffset(
        drag.origin.x + (e.clientX - drag.x),
        drag.origin.y + (e.clientY - drag.y),
        nat.w,
        nat.h,
        SIZE,
        zoom
      )
    )
  }

  const endDrag = () => {
    dragRef.current = null
  }

  // Same re-encode as before (WebP keeps PNG transparency, JPEG wouldn't) —
  // only the source rect is now the user's framing instead of the centre.
  const apply = () => {
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx || !nat) return onDone(null)
    const { w, h } = scaledSize(nat.w, nat.h, SIZE, zoom)
    ctx.drawImage(imgRef.current, (SIZE - w) / 2 + offset.x, (SIZE - h) / 2 + offset.y, w, h)
    onDone(canvas.toDataURL('image/webp', 0.85))
  }

  const drawn = nat ? scaledSize(nat.w, nat.h, SIZE, zoom) : null

  return (
    <div className="cropper-overlay">
      <div className="cropper-modal">
        <h3 className="cropper-title">Position your image</h3>
        <div
          className="cropper-frame"
          ref={frameRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => setNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
            style={
              drawn
                ? {
                    width: drawn.w,
                    height: drawn.h,
                    left: (SIZE - drawn.w) / 2 + offset.x,
                    top: (SIZE - drawn.h) / 2 + offset.y
                  }
                : { visibility: 'hidden' }
            }
          />
          {/* Where round frames (member avatars) cut the square down. */}
          <div className="cropper-circle" aria-hidden="true" />
        </div>
        <input
          className="cropper-zoom"
          type="range"
          min={min}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          aria-label="Zoom"
          onChange={(e) => applyZoom(Number(e.target.value))}
        />
        <p className="cropper-hint">
          Drag to reposition, scroll to zoom. The dashed circle shows the round crop.
        </p>
        <div className="cropper-actions">
          <button type="button" className="picker-btn secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="button" className="picker-btn primary" onClick={apply} disabled={!nat}>
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

export default ImageCropper
