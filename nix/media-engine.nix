# The native media engine's sidecar, pylon-media-host, with the `capture` feature (the `screen`
# and `pattern` sources and the hardware encoder). Its inputs are what
# native/media-engine/shell.nix lists. The app finds it at media-engine/pylon-media-host beside
# itself (nix/package.nix copies it there).
{
  lib,
  rustPlatform,
  callPackage,
  pkg-config,
  libva,
  libdrm,
  pipewire,
  libglvnd,
  # The flake's pylon-e2ee and str0m inputs, standing in for the two submodules
  pylonE2eeSrc,
  str0mSrc,
}:

let
  ffmpeg = callPackage ./ffmpeg-pylon.nix { };
in
rustPlatform.buildRustPackage {
  pname = "pylon-media-host";
  version = (lib.importTOML ../native/media-engine/pylon-media-host/Cargo.toml).package.version;

  # The workspace sits at native/media-engine and reaches ../../../pylon-e2ee from pylon-media,
  # so the source keeps the repository's layout from its root
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../native/media-engine/Cargo.toml
      ../native/media-engine/Cargo.lock
      ../native/media-engine/pylon-media/Cargo.toml
      ../native/media-engine/pylon-media/src
      ../native/media-engine/pylon-media/examples
      ../native/media-engine/pylon-media/testdata
      ../native/media-engine/pylon-media-host/Cargo.toml
      ../native/media-engine/pylon-media-host/src
    ];
  };
  sourceRoot = "source/native/media-engine";

  # Put the two submodules where the workspace expects them
  postUnpack = ''
    chmod u+w source source/native/media-engine
    mkdir -p source/native/media-engine/vendor
    cp -r ${str0mSrc} source/native/media-engine/vendor/str0m
    cp -r ${pylonE2eeSrc} source/pylon-e2ee
    chmod -R u+w source/native/media-engine/vendor source/pylon-e2ee
  '';

  cargoLock.lockFile = ../native/media-engine/Cargo.lock;

  buildFeatures = [ "pylon-media-host/capture" ];

  nativeBuildInputs = [
    pkg-config
    rustPlatform.bindgenHook # libclang for ffmpeg-sys-next and the pipewire crates
  ];
  buildInputs = [
    ffmpeg
    libva
    libdrm
    pipewire
    libglvnd
  ];

  # The tests open the GPU's encoder
  doCheck = false;

  passthru = { inherit ffmpeg; };

  meta = {
    description = "Pylon's native media engine sidecar";
    mainProgram = "pylon-media-host";
    platforms = lib.platforms.linux;
  };
}
