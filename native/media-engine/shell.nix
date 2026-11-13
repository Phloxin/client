# Environment for the engine's `encode` feature (.plans/native-media-engine-m5a-encoder.md, D2):
# FFmpeg with ffmpeg-vaapi-rate-change.patch (a changed bit_rate, rc_buffer_size or framerate
# reaches the open VA-API encoder, and a `filler` option), libva, libdrm, clang for the bindings.
# The `capture` feature (.plans/native-media-engine-m5b-capture.md) also needs PipeWire's
# development files and libEGL (the DMA-BUF modifiers the GPU takes).
# Nothing is installed.
#   nix-shell native/media-engine/shell.nix --run 'cargo build --release --features encode'
#   nix-shell native/media-engine/shell.nix --run 'cargo build --release --features pylon-media-host/capture'
# The patched FFmpeg alone: nix-build native/media-engine/shell.nix -A ffmpeg
{ pkgs ? import (builtins.getFlake "nixpkgs") { } }:
let
  ffmpeg = pkgs.ffmpeg-headless.overrideAttrs (old: {
    pname = "ffmpeg-pylon";
    patches = (old.patches or [ ]) ++ [ ./ffmpeg-vaapi-rate-change.patch ];
    doCheck = false;
  });
in
pkgs.mkShell {
  packages = with pkgs; [ cargo rustc pkg-config clang ffmpeg ffmpeg.dev libva libdrm pipewire.dev libglvnd ];
  LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
  passthru = { inherit ffmpeg; };
}
