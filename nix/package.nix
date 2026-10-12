{
  lib,
  stdenv,
  buildNpmPackage,
  rustPlatform,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  nodejs_22,
  electron_43,
  python3,
  pkg-config,
  libva,
  pipewire,
  libx11,
  libxtst,
  libxrandr,
  libxt,
}:

let
  # Keep in sync with the electron version in package.json
  electron = electron_43;

  packageJson = lib.importJSON ../package.json;

  # Rust addon that captures app audio for screen share
  audioCapture = rustPlatform.buildRustPackage {
    pname = "pylon-audio-capture";
    version = (lib.importTOML ../native/audio-capture/Cargo.toml).package.version;

    src = lib.fileset.toSource {
      root = ../native/audio-capture;
      fileset = lib.fileset.unions [
        ../native/audio-capture/Cargo.toml
        ../native/audio-capture/Cargo.lock
        ../native/audio-capture/build.rs
        ../native/audio-capture/src
      ];
    };

    cargoLock.lockFile = ../native/audio-capture/Cargo.lock;

    nativeBuildInputs = [
      pkg-config
      rustPlatform.bindgenHook # needed by the pipewire crates
    ];
    buildInputs = [ pipewire ];

    # Tests cannot link outside of node or Electron
    doCheck = false;
  };
in
buildNpmPackage {
  pname = "pylon";
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../electron.vite.config.mjs
      ../src
      ../resources
      ../build
      ../native/audio-capture/package.json
      ../native/audio-capture/index.js
      ../native/audio-capture/index.d.ts
    ];
  };

  nodejs = nodejs_22; # matches engines in package.json
  npmDepsHash = "sha256-Z0mmJLmoL3dX6fazKhZfiTbqOcAh1b96H+LV7sqV8qQ=";

  # Skip npm install scripts since the native modules are built below
  npmRebuildFlags = [ "--ignore-scripts" ];
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
    python3 # needed by node-gyp
  ];

  # X11 libraries used by uiohook-napi
  buildInputs = [
    libx11
    libxtst
    libxrandr
    libxt
  ];

  preBuild = ''
    # Build uiohook-napi from source instead of using its prebuilt binary
    npm rebuild uiohook-napi --build-from-source
    # Keep only the built addon so build files stay out of the closure
    pushd node_modules/uiohook-napi
    mv build/Release/uiohook_napi.node .
    rm -rf build prebuilds
    install -Dm755 uiohook_napi.node build/Release/uiohook_napi.node
    rm uiohook_napi.node
    popd

    cp ${audioCapture}/lib/libaudio_capture.so \
      native/audio-capture/audio-capture.linux-${stdenv.hostPlatform.node.arch}-gnu.node
  '';

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save $npmFlags

    # Replace the audio-capture symlink with a real copy
    rm node_modules/audio-capture
    mkdir node_modules/audio-capture
    cp native/audio-capture/{package.json,index.js,index.d.ts,*.node} node_modules/audio-capture/

    appDir=$out/share/pylon
    mkdir -p $appDir
    # The app loads icons from ../../resources relative to out/main
    cp -r package.json out resources node_modules $appDir/

    install -Dm644 resources/icon.png $out/share/icons/hicolor/512x512/apps/pylon.png

    # Add libva for hardware video and mark the app as packaged
    makeWrapper ${lib.getExe electron} $out/bin/pylon \
      --add-flags $appDir \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ libva ]} \
      --set-default ELECTRON_FORCE_IS_PACKAGED 1

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      # Must match APP_ID in src/main/index.js
      name = "app.pylon.client";
      desktopName = "Pylon";
      comment = packageJson.description;
      exec = "pylon";
      icon = "pylon";
      startupWMClass = "pylon";
      categories = [
        "Network"
        "Chat"
        "InstantMessaging"
      ];
    })
  ];

  passthru = { inherit audioCapture electron; };

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    mainProgram = "pylon";
    platforms = lib.platforms.linux;
  };
}
