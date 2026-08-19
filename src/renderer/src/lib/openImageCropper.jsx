import { createRoot } from 'react-dom/client'
import ImageCropper from '../components/ImageCropper'

// Open the crop dialog on its own root, outside the app tree: every upload path
// already funnels through fileToAvatarDataUrl, so mounting here keeps dialog
// state out of the four components that pick files. Resolves with the cropped
// data URL, or null if the user cancelled.
export function openImageCropper(src) {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(
      <ImageCropper
        src={src}
        onDone={(dataUrl) => {
          resolve(dataUrl)
          // Unmounting inside the click handler would tear down the tree still
          // dispatching it; let the event finish first.
          setTimeout(() => {
            root.unmount()
            host.remove()
          })
        }}
      />
    )
  })
}
