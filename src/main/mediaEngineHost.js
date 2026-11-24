// Where the main process looks for the media engine's sidecar (pylon-media-host).
// Kept apart from mediaEngine.js, which imports Electron, so it can be tested.
//
//   1. PYLON_MEDIA_HOST, if set: that path and no other, whether or not the file exists.
//   2. Otherwise the places for this kind of app, in order:
//        packaged:     <resources>/media-engine/<name>, then <app path>/media-engine/<name>
//                      (the Nix package sets ELECTRON_FORCE_IS_PACKAGED and puts the sidecar
//                      beside its app directory);
//        not packaged: <app path>/media-engine/<name>, then
//                      <app path>/native/media-engine/target/release/<name> (the workspace build).
//   3. The first place where the file exists; if none does, the first place of the list, so the
//      log line that says no sidecar was found names where one is expected.
// A packaged app never looks in the workspace build, one that is not packaged never in the
// resources. <name> is pylon-media-host.exe on Windows and pylon-media-host elsewhere.
import { join as nativeJoin } from 'node:path'

export function mediaEngineHostName(platform) {
  return platform === 'win32' ? 'pylon-media-host.exe' : 'pylon-media-host'
}

//   env           the value of PYLON_MEDIA_HOST (undefined when unset)
//   platform      process.platform
//   isPackaged    app.isPackaged
//   resourcesPath process.resourcesPath
//   appPath       app.getAppPath()
//   exists(path)  whether a file is there
//   join          the path join to use (node:path's by default)
export function mediaEngineHostPath({
  env,
  platform,
  isPackaged,
  resourcesPath,
  appPath,
  exists,
  join = nativeJoin
}) {
  const override = typeof env === 'string' ? env.trim() : ''
  if (override) return override
  const name = mediaEngineHostName(platform)
  const beside = join(appPath, 'media-engine', name)
  const places = isPackaged
    ? [join(resourcesPath, 'media-engine', name), beside]
    : [beside, join(appPath, 'native/media-engine/target/release', name)]
  return places.find((place) => exists(place)) ?? places[0]
}
