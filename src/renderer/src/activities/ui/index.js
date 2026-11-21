// The activity UIs this client ships, by the server's activity id. Each is plain HTML, JS and CSS
// with no build step, read here as text and inlined into the frame's srcdoc
// (lib/activities/bridge.js) until the server's asset origin exists. A bundle may have
// capabilities: 'player' lets it drive the video surface the shell hosts under its frame.

import { buildSrcdoc } from '../../lib/activities/bridge.js'
import baseCss from './shared/base.css?raw'
import bridgeJs from './shared/bridge.js?raw'
import roomJs from './shared/room.js?raw'
import seatsJs from './shared/seats.js?raw'
import duelJs from './shared/duel.js?raw'
import playerJs from './shared/player.js?raw'
import tttHtml from './tic_tac_toe/index.html?raw'
import tttCss from './tic_tac_toe/style.css?raw'
import tttJs from './tic_tac_toe/main.js?raw'
import c4Html from './connect4/index.html?raw'
import c4Css from './connect4/style.css?raw'
import c4Js from './connect4/main.js?raw'
import unoHtml from './uno/index.html?raw'
import unoCss from './uno/style.css?raw'
import unoJs from './uno/main.js?raw'
import chessHtml from './chess/index.html?raw'
import chessCss from './chess/style.css?raw'
import chessJs from './chess/main.js?raw'
import chessPiecesJs from './chess/pieces.js?raw'
import wtHtml from './watch_together/index.html?raw'
import wtCss from './watch_together/style.css?raw'
import wtJs from './watch_together/main.js?raw'
import wtSyncJs from './watch_together/sync.js?raw'
import wtIconsJs from './watch_together/icons.js?raw'
import wtSceneJs from './watch_together/scene.js?raw'

// Every shared file a bundle may load; each bundle's index.html names the ones it uses.
const SHARED = {
  '../shared/base.css': baseCss,
  '../shared/bridge.js': bridgeJs,
  '../shared/room.js': roomJs,
  '../shared/seats.js': seatsJs,
  '../shared/duel.js': duelJs,
  '../shared/player.js': playerJs
}

const BUNDLES = {
  tic_tac_toe: { html: tttHtml, files: { ...SHARED, 'style.css': tttCss, 'main.js': tttJs } },
  connect4: { html: c4Html, files: { ...SHARED, 'style.css': c4Css, 'main.js': c4Js } },
  uno: { html: unoHtml, files: { ...SHARED, 'style.css': unoCss, 'main.js': unoJs } },
  chess: {
    html: chessHtml,
    files: { ...SHARED, 'style.css': chessCss, 'pieces.js': chessPiecesJs, 'main.js': chessJs }
  },
  watch_together: {
    html: wtHtml,
    files: {
      ...SHARED,
      'style.css': wtCss,
      'sync.js': wtSyncJs,
      'icons.js': wtIconsJs,
      'scene.js': wtSceneJs,
      'main.js': wtJs
    },
    capabilities: ['player']
  }
}

const built = new Map()

// The srcdoc for an activity's UI, or null when this client has none.
export function activitySrcdoc(activityId) {
  if (!Object.hasOwn(BUNDLES, activityId)) return null
  if (!built.has(activityId)) {
    const { html, files } = BUNDLES[activityId]
    built.set(activityId, buildSrcdoc(html, files))
  }
  return built.get(activityId)
}

// What an activity's bundle may do beyond the bridge, [] for none or no bundle.
export function activityCapabilities(activityId) {
  if (!Object.hasOwn(BUNDLES, activityId)) return []
  return BUNDLES[activityId].capabilities ?? []
}
