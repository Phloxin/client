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
  lld,
  buildPackages,
  # Source of the pylon-e2ee crate (the flake's pylon-e2ee input)
  pylonE2eeSrc,
  preferScreenshareCodec ? null,
  # disableHardwareEncode: true turns VA-API video encoding off entirely
  disableHardwareEncode ? false,
}:

let
  # Keep in sync with the electron version in package.json
  electron = electron_43;

  screenshareCodecs = [
    "H264"
    "AV1"
    "VP9"
  ];
  wrapperEnv =
    lib.optionals (preferScreenshareCodec != null) [
      "--set-default"
      "PREFER_SCREENSHARE_CODEC"
      preferScreenshareCodec
    ]
    ++ lib.optionals disableHardwareEncode [
      "--set-default"
      "VOIP_NO_HW_ENCODE"
      "1"
    ];

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

  # The wasm-bindgen CLI must match the wasm-bindgen crate in Cargo.lock exactly
  e2eeLock = lib.importTOML "${pylonE2eeSrc}/Cargo.lock";
  wasmBindgenVersion =
    (lib.findFirst (p: p.name == "wasm-bindgen")
      (throw "pylon: wasm-bindgen is missing from pylon-e2ee's Cargo.lock")
      e2eeLock.package
    ).version;
  wasmBindgenAttr = "wasm-bindgen-cli_${lib.replaceStrings [ "." ] [ "_" ] wasmBindgenVersion}";
  wasmBindgenCli =
    buildPackages.${wasmBindgenAttr}
      or (throw "pylon: nixpkgs has no ${wasmBindgenAttr}, which pylon-e2ee's Cargo.lock requires");

  # WASM for the E2EE worker (src/renderer/src/lib/e2ee/pkg), the same output
  # as `npm run build:e2ee`
  e2eeWasm = rustPlatform.buildRustPackage {
    pname = "pylon-e2ee-wasm";
    version = (lib.importTOML "${pylonE2eeSrc}/Cargo.toml").package.version;

    src = pylonE2eeSrc;
    cargoLock.lockFile = "${pylonE2eeSrc}/Cargo.lock";

    nativeBuildInputs = [
      wasmBindgenCli
      lld # nixpkgs' rustc links wasm32 with a bare `lld`
    ];

    buildPhase = ''
      runHook preBuild
      cargo build --offline --release --features wasm --target wasm32-unknown-unknown
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      wasm-bindgen --target web --out-dir $out --out-name pylon_e2ee \
        target/wasm32-unknown-unknown/release/pylon_e2ee.wasm
      runHook postInstall
    '';

    doCheck = false;
  };
in
assert lib.assertMsg
  (preferScreenshareCodec == null || builtins.elem preferScreenshareCodec screenshareCodecs)
  "pylon: preferScreenshareCodec must be one of ${lib.concatStringsSep ", " screenshareCodecs} or null, got \"${toString preferScreenshareCodec}\"";
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

    # The E2EE worker imports its WASM from here. It's gitignored, so it isn't in src
    install -Dm644 -t src/renderer/src/lib/e2ee/pkg ${e2eeWasm}/*
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

    # Add libva for hardware video, mark the app as packaged, and bake in the
    # screen-share switches chosen at build time
    makeWrapper ${lib.getExe electron} $out/bin/pylon \
      --add-flags $appDir \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ libva ]} \
      --set-default ELECTRON_FORCE_IS_PACKAGED 1 \
      ${lib.escapeShellArgs wrapperEnv}

    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      # Must match APP_ID in src/main/index.js
      name = "app.pylon.client";
      desktopName = "Pylon";
      comment = packageJson.description;
      exec = "pylon %u";
      icon = "pylon";
      startupWMClass = "pylon";
      # pylon://join invite links (see src/main/index.js).
      mimeTypes = [ "x-scheme-handler/pylon" ];
      categories = [
        "Network"
        "Chat"
        "InstantMessaging"
      ];
    })
  ];

  passthru = { inherit audioCapture e2eeWasm electron; };

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    mainProgram = "pylon";
    platforms = lib.platforms.linux;
  };
}
