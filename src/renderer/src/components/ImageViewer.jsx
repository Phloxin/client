import { useState, useEffect, useRef, useCallback } from 'react'
import { IconX, IconDownload, IconZoomReset } from '@tabler/icons-react'
import './ImageViewer.css'

const MIN_SCALE = 1
const MAX_SCALE = 8
const ZOOM_STEP = 0.0015

function ImageViewer({ src, name, onClose }) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [downloading, setDownloading] = useState(false)
  const draggingRef = useRef(null)
  const imageRef = useRef(null)

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Zoom toward the cursor on wheel scroll
  const handleWheel = (e) => {
    e.preventDefault()
    const rect = imageRef.current?.getBoundingClientRect()
    if (!rect) return
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale - e.deltaY * ZOOM_STEP * scale))
    if (next === scale) return

    if (next === MIN_SCALE) {
      reset()
      return
    }

    // Keep the point under the cursor stationary as we scale
    const cx = e.clientX - (rect.left + rect.width / 2)
    const cy = e.clientY - (rect.top + rect.height / 2)
    const ratio = next / scale
    setOffset((prev) => ({
      x: prev.x - cx * (ratio - 1),
      y: prev.y - cy * (ratio - 1)
    }))
    setScale(next)
  }

  const handlePointerDown = (e) => {
    if (scale <= 1) return
    e.preventDefault()
    draggingRef.current = { startX: e.clientX, startY: e.clientY, origin: offset }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e) => {
    const drag = draggingRef.current
    if (!drag) return
    setOffset({
      x: drag.origin.x + (e.clientX - drag.startX),
      y: drag.origin.y + (e.clientY - drag.startY)
    })
  }

  const handlePointerUp = () => {
    draggingRef.current = null
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      await window.electron.ipcRenderer.invoke('download-file', { url: src, filename: name })
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="image-viewer-overlay" onClick={onClose}>
      <div className="image-viewer-controls" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="image-viewer-btn"
          title="Download"
          onClick={handleDownload}
          disabled={downloading}
        >
          <IconDownload size={18} />
        </button>
        <button
          type="button"
          className="image-viewer-btn"
          title="Reset zoom"
          onClick={reset}
          disabled={scale === 1 && offset.x === 0 && offset.y === 0}
        >
          <IconZoomReset size={18} />
        </button>
        <button type="button" className="image-viewer-btn" title="Close" onClick={onClose}>
          <IconX size={18} />
        </button>
      </div>

      <div
        className="image-viewer-stage"
        onClick={(e) => e.stopPropagation()}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ cursor: scale > 1 ? (draggingRef.current ? 'grabbing' : 'grab') : 'default' }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={name}
          draggable={false}
          className="image-viewer-img"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`
          }}
        />
      </div>
    </div>
  )
}

export default ImageViewer
