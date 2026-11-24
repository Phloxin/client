# Our FFmpeg: nixpkgs' ffmpeg-headless with ffmpeg-vaapi-rate-change.patch (a changed bit_rate,
# rc_buffer_size or framerate reaches the open VA-API encoder, and a `filler` option). What the
# media engine's `encode` and `capture` features link. One definition for the engine's dev shell
# (native/media-engine/shell.nix) and the client's package (nix/media-engine.nix).
{ ffmpeg-headless }:
ffmpeg-headless.overrideAttrs (old: {
  pname = "ffmpeg-pylon";
  patches = (old.patches or [ ]) ++ [ ../native/media-engine/ffmpeg-vaapi-rate-change.patch ];
  doCheck = false;
})
