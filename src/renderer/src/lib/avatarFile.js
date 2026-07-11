// Convert a picked image file into an avatar-sized data URL. Animated GIFs
// can't survive a canvas re-encode (it captures a single frame), so they're
// sent as-is to keep the animation. Other formats (JPG/PNG/WebP) get
// cover-cropped to a small square — avatars render tiny and the data URL is
// broadcast to everyone, so full-res photos would bloat every payload. We
// re-encode to WebP, which keeps PNG transparency (JPEG would flatten it) and
// compresses well; the backend accepts JPG/PNG/GIF/WebP.
export function fileToAvatarDataUrl(file, onDone) {
  if (file.type === 'image/gif') {
    const reader = new FileReader()
    reader.onload = () => onDone(reader.result)
    reader.readAsDataURL(file)
    return
  }
  const img = new Image()
  img.onload = () => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    // Cover-crop: scale so the shorter side fills, center the overflow.
    const scale = Math.max(size / img.width, size / img.height)
    const w = img.width * scale
    const h = img.height * scale
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
    onDone(canvas.toDataURL('image/webp', 0.85))
    URL.revokeObjectURL(img.src)
  }
  img.src = URL.createObjectURL(file)
}
