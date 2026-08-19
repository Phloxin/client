import { openImageCropper } from './openImageCropper'

// Convert a picked image file into an avatar-sized data URL. Animated GIFs
// can't survive a canvas re-encode (it captures a single frame), so they're
// sent as-is to keep the animation — which also means no crop step for them.
// Other formats (JPG/PNG/WebP) go through the cropper, where the user frames
// the square that gets drawn; avatars render tiny and the data URL is broadcast
// to everyone, so full-res photos would bloat every payload. The cropper
// re-encodes to WebP, which keeps PNG transparency (JPEG would flatten it) and
// compresses well; the backend accepts JPG/PNG/GIF/WebP.
//
// `onDone` is not called if the user cancels the cropper.
export function fileToAvatarDataUrl(file, onDone) {
  if (file.type === 'image/gif') {
    const reader = new FileReader()
    reader.onload = () => onDone(reader.result)
    reader.readAsDataURL(file)
    return
  }
  const objectUrl = URL.createObjectURL(file)
  openImageCropper(objectUrl).then((dataUrl) => {
    URL.revokeObjectURL(objectUrl)
    if (dataUrl) onDone(dataUrl)
  })
}
