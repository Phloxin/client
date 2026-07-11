import { useState, useEffect } from 'react'

// Pull dominant colors out of an image (pywal-style, but tiny): downscale to a
// 16×16 canvas and read the pixels. Returns { average, vibrant } CSS rgb()
// strings, or null if the image can't be read (load failure, or a cross-origin
// icon served without CORS headers tainting the canvas).
export function extractImageColors(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const N = 16
        const canvas = document.createElement('canvas')
        canvas.width = N
        canvas.height = N
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, N, N)
        const { data } = ctx.getImageData(0, 0, N, N)
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        let vibrant = null
        let bestScore = -1
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue // skip transparent pixels
          const pr = data[i]
          const pg = data[i + 1]
          const pb = data[i + 2]
          r += pr
          g += pg
          b += pb
          n++
          // ponytail: "vibrant" = most saturated-and-bright pixel, not a real
          // clustering pass; swap in k-means over the samples if this reads flat.
          const score = (Math.max(pr, pg, pb) - Math.min(pr, pg, pb)) * Math.max(pr, pg, pb)
          if (score > bestScore) {
            bestScore = score
            vibrant = `rgb(${pr}, ${pg}, ${pb})`
          }
        }
        if (!n) return resolve(null)
        resolve({
          average: `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`,
          vibrant
        })
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

// Banner gradient inline style for a summary card, from extractImageColors()
// output. Null colors → undefined (plain card, no banner).
export function bannerGradient(colors) {
  if (!colors) return undefined
  return {
    background: `linear-gradient(120deg,
      color-mix(in srgb, ${colors.vibrant} 45%, transparent),
      color-mix(in srgb, ${colors.average} 22%, transparent))`
  }
}

// Hook: colors sampled from an image src, or null while loading / no src /
// unreadable image.
export function useImageColors(src) {
  const [colors, setColors] = useState(null)
  useEffect(() => {
    if (!src) {
      setColors(null)
      return
    }
    let alive = true
    extractImageColors(src).then((c) => {
      if (alive) setColors(c)
    })
    return () => {
      alive = false
    }
  }, [src])
  return colors
}
