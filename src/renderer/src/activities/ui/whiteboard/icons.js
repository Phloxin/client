// Icons for the whiteboard: path data copied from @tabler/icons 3.44.0 (node_modules), and
// mirror-4, mirror-off and shapes drawn for this bundle, as inline SVG.
//
// MIT License
//
// Copyright (c) 2020-2026 Paweł Kuna
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
;(() => {
  const NS = 'http://www.w3.org/2000/svg'
  const PATHS = {
    pen: {
      filled: false,
      d: [
        'M14 6l7 7l-4 4',
        'M5.828 18.172a2.828 2.828 0 0 0 4 0l10.586 -10.586a2 2 0 0 0 0 -2.829l-1.171 -1.171a2 2 0 0 0 -2.829 0l-10.586 10.586a2.828 2.828 0 0 0 0 4',
        'M4 20l1.768 -1.768'
      ]
    },
    pencil: {
      filled: false,
      d: ['M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4', 'M13.5 6.5l4 4']
    },
    marker: {
      filled: false,
      d: [
        'M3 19h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4',
        'M12.5 5.5l4 4',
        'M4.5 13.5l4 4',
        'M21 15v4h-8l4 -4l4 0'
      ]
    },
    brush: {
      filled: false,
      d: [
        'M3 21v-4a4 4 0 1 1 4 4h-4',
        'M21 3a16 16 0 0 0 -12.8 10.2',
        'M21 3a16 16 0 0 1 -10.2 12.8',
        'M10.6 9a9 9 0 0 1 4.4 4.4'
      ]
    },
    spray: {
      filled: false,
      d: [
        'M4 12a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2l0 -7',
        'M6 10v-4a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v4',
        'M15 7h.01',
        'M18 9h.01',
        'M18 5h.01',
        'M21 3h.01',
        'M21 7h.01',
        'M21 11h.01',
        'M10 7h1'
      ]
    },
    eraser: {
      filled: false,
      d: [
        'M19 20h-10.5l-4.21 -4.3a1 1 0 0 1 0 -1.41l10 -10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3',
        'M18 13.3l-6.3 -6.3'
      ]
    },
    bucket: {
      filled: false,
      d: [
        'M5 16l1.465 1.638a2 2 0 1 1 -3.015 .099l1.55 -1.737',
        'M13.737 9.737c2.299 -2.3 3.23 -5.095 2.081 -6.245c-1.15 -1.15 -3.945 -.217 -6.244 2.082c-2.3 2.299 -3.231 5.095 -2.082 6.244c1.15 1.15 3.946 .218 6.245 -2.081',
        'M7.492 11.818c.362 .362 .768 .676 1.208 .934l6.895 4.047c1.078 .557 2.255 -.075 3.692 -1.512c1.437 -1.437 2.07 -2.614 1.512 -3.692c-.372 -.718 -1.72 -3.017 -4.047 -6.895a6.015 6.015 0 0 0 -.934 -1.208'
      ]
    },
    line: {
      filled: false,
      d: [
        'M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
        'M16 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
        'M7.5 16.5l9 -9'
      ]
    },
    arrow: { filled: false, d: ['M17 7l-10 10', 'M8 7l9 0l0 9'] },
    rect: {
      filled: false,
      d: ['M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10']
    },
    ellipse: { filled: false, d: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0'] },
    triangle: {
      filled: false,
      d: [
        'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0'
      ]
    },
    star: {
      filled: false,
      d: [
        'M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873l-6.158 -3.245'
      ]
    },
    text: {
      filled: false,
      d: ['M4 20l3 0', 'M14 20l7 0', 'M6.9 15l6.9 0', 'M10.2 6.3l5.8 13.7', 'M5 20l6 -16l2 0l7 16']
    },
    stamp: {
      filled: false,
      d: ['M20 12l-2 .5a6 6 0 0 1 -6.5 -6.5l.5 -2l8 8', 'M20 12a8 8 0 1 1 -8 -8']
    },
    laser: { filled: false, d: ['M12 3l3 6l6 3l-6 3l-3 6l-3 -6l-6 -3l6 -3l3 -6'] },
    eyedropper: {
      filled: false,
      d: ['M11 7l6 6', 'M4 16l11.7 -11.7a1 1 0 0 1 1.4 0l2.6 2.6a1 1 0 0 1 0 1.4l-11.7 11.7h-4v-4']
    },
    hand: {
      filled: false,
      d: [
        'M8 13v-7.5a1.5 1.5 0 0 1 3 0v6.5',
        'M11 5.5v-2a1.5 1.5 0 1 1 3 0v8.5',
        'M14 5.5a1.5 1.5 0 0 1 3 0v6.5',
        'M17 7.5a1.5 1.5 0 0 1 3 0v8.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47'
      ]
    },
    undo: { filled: false, d: ['M9 14l-4 -4l4 -4', 'M5 10h11a4 4 0 1 1 0 8h-1'] },
    redo: { filled: false, d: ['M15 14l4 -4l-4 -4', 'M19 10h-11a4 4 0 1 0 0 8h1'] },
    'mirror-v': {
      filled: false,
      d: ['M3 12l18 0', 'M7 16l10 0l-10 5l0 -5', 'M7 8l10 0l-10 -5l0 5']
    },
    'mirror-h': {
      filled: false,
      d: ['M12 3l0 18', 'M16 7l0 10l5 0l-5 -10', 'M8 7l0 10l-5 0l5 -10']
    },
    save: {
      filled: false,
      d: ['M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2', 'M7 11l5 5l5 -5', 'M12 4l0 12']
    },
    share: {
      filled: false,
      d: [
        'M10 14l11 -11',
        'M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5'
      ]
    },
    timelapse: { filled: false, d: ['M12 8l0 4l2 2', 'M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5'] },
    play: {
      filled: true,
      d: ['M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z']
    },
    pause: {
      filled: true,
      d: [
        'M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z',
        'M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z'
      ]
    },
    trash: {
      filled: false,
      d: [
        'M4 7l16 0',
        'M10 11l0 6',
        'M14 11l0 6',
        'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12',
        'M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3'
      ]
    },
    lock: {
      filled: false,
      d: [
        'M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6',
        'M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0',
        'M8 11v-4a4 4 0 1 1 8 0v4'
      ]
    },
    'lock-open': {
      filled: false,
      d: [
        'M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -6',
        'M11 16a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
        'M8 11v-5a4 4 0 0 1 8 0'
      ]
    },
    'lock-solid': {
      filled: true,
      d: [
        'M12 2a5 5 0 0 1 5 5v3a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3h-10a3 3 0 0 1 -3 -3v-6a3 3 0 0 1 3 -3v-3a5 5 0 0 1 5 -5m0 12a2 2 0 0 0 -1.995 1.85l-.005 .15a2 2 0 1 0 2 -2m0 -10a3 3 0 0 0 -3 3v3h6v-3a3 3 0 0 0 -3 -3'
      ]
    },
    crown: {
      filled: true,
      d: [
        'M19 19h-14c-.5 0 -.9 -.3 -1 -.8l-2 -10c0 -.4 .1 -.8 .5 -1.1c.4 -.2 .8 -.2 1.1 0l4.1 3.3l3.4 -5.1c.4 -.6 1.3 -.6 1.7 0l3.4 5.1l4.1 -3.3c.3 -.3 .8 -.3 1.1 0c.4 .2 .5 .6 .5 1.1l-2 10c0 .5 -.5 .8 -1 .8z'
      ]
    },
    users: {
      filled: false,
      d: [
        'M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
        'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2',
        'M16 3.13a4 4 0 0 1 0 7.75',
        'M21 21v-2a4 4 0 0 0 -3 -3.85'
      ]
    },
    dots: {
      filled: false,
      d: [
        'M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
        'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
        'M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'
      ]
    },
    x: { filled: false, d: ['M18 6l-12 12', 'M6 6l12 12'] },
    check: { filled: false, d: ['M5 12l5 5l10 -10'] },
    plus: { filled: false, d: ['M12 5l0 14', 'M5 12l14 0'] },
    minus: { filled: false, d: ['M5 12l14 0'] },
    fit: {
      filled: false,
      d: [
        'M4 8v-2a2 2 0 0 1 2 -2h2',
        'M4 16v2a2 2 0 0 0 2 2h2',
        'M16 4h2a2 2 0 0 1 2 2v2',
        'M16 20h2a2 2 0 0 0 2 -2v-2'
      ]
    },
    droplet: {
      filled: false,
      d: [
        'M7.502 19.423c2.602 2.105 6.395 2.105 8.996 0c2.602 -2.105 3.262 -5.708 1.566 -8.546l-4.89 -7.26c-.42 -.625 -1.287 -.803 -1.936 -.397a1.376 1.376 0 0 0 -.41 .397l-4.893 7.26c-1.695 2.838 -1.035 6.441 1.567 8.546'
      ]
    },
    prompt: {
      filled: false,
      d: [
        'M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7',
        'M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3',
        'M9.7 17l4.6 0'
      ]
    },
    dice: {
      filled: false,
      d: [
        'M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14',
        'M8 8.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0',
        'M15 8.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0',
        'M15 15.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0',
        'M8 15.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0',
        'M11.5 12a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0'
      ]
    },
    clock: {
      filled: false,
      d: ['M5 13a7 7 0 1 0 14 0a7 7 0 0 0 -14 0', 'M14.5 10.5l-2.5 2.5', 'M17 8l1 -1', 'M14 3h-4']
    },
    alert: {
      filled: false,
      d: [
        'M12 9v4',
        'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0',
        'M12 16h.01'
      ]
    },
    eye: {
      filled: false,
      d: [
        'M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0',
        'M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6'
      ]
    },
    paper: {
      filled: false,
      d: [
        'M6 3l-3 3',
        'M21 18l-3 3',
        'M11 3l-8 8',
        'M16 3l-13 13',
        'M21 3l-18 18',
        'M21 8l-13 13',
        'M21 13l-8 8'
      ]
    },
    offline: {
      filled: false,
      d: [
        'M12 18l.01 0',
        'M9.172 15.172a4 4 0 0 1 5.656 0',
        'M6.343 12.343a7.963 7.963 0 0 1 3.864 -2.14m4.163 .155a7.965 7.965 0 0 1 3.287 2',
        'M3.515 9.515a12 12 0 0 1 3.544 -2.455m3.101 -.92a12 12 0 0 1 10.325 3.374',
        'M3 3l18 18'
      ]
    },
    'chevron-down': { filled: false, d: ['M6 9l6 6l6 -6'] },
    'chevron-right': { filled: false, d: ['M9 6l6 6l-6 6'] },
    sparkles: {
      filled: false,
      d: [
        'M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6'
      ]
    },
    stop: {
      filled: true,
      d: ['M17 4h-10a3 3 0 0 0 -3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3 -3v-10a3 3 0 0 0 -3 -3z']
    },
    wipe: {
      filled: false,
      d: [
        'M19 20h-10.5l-4.21 -4.3a1 1 0 0 1 0 -1.41l10 -10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3',
        'M18 13.3l-6.3 -6.3'
      ]
    },
    photo: {
      filled: false,
      d: [
        'M15 8h.01',
        'M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12',
        'M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5',
        'M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3'
      ]
    },
    keyboard: {
      filled: false,
      d: [
        'M2 8a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2l0 -8',
        'M6 10l0 .01',
        'M10 10l0 .01',
        'M14 10l0 .01',
        'M18 10l0 .01',
        'M6 14l0 .01',
        'M18 14l0 .01',
        'M10 14l4 .01'
      ]
    },
    'mirror-4': {
      filled: false,
      d: [
        'M12 3v18',
        'M3 12h18',
        'M6 6h2v2h-2z',
        'M16 6h2v2h-2z',
        'M6 16h2v2h-2z',
        'M16 16h2v2h-2z'
      ]
    },
    'mirror-off': {
      filled: false,
      d: ['M12 3v2', 'M12 9v2', 'M12 13v2', 'M12 19v2', 'M4 7l4 5l-4 5z', 'M20 7l-4 5l4 5z']
    },
    shapes: {
      filled: false,
      d: [
        'M4 13h7v7h-7z',
        'M17.5 17.5m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0',
        'M12 3l4.5 7h-9z'
      ]
    }
  }

  // An <svg> for the icon, sized by CSS (1em by default). An unknown name is an empty icon.
  function icon(name) {
    const spec = PATHS[name] ?? { filled: false, d: [] }
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.classList.add('icon')
    if (spec.filled) {
      svg.setAttribute('fill', 'currentColor')
    } else {
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '2')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
    }
    for (const d of spec.d) {
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    }
    return svg
  }

  window.wbIcons = { icon }
})()
