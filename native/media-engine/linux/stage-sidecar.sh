#!/bin/bash
# Builds the Linux sidecar against our FFmpeg (ffmpeg-build.sh beside this script) and stages what
# the AppImage and deb ship with it into native/media-engine/dist: pylon-media-host, FFmpeg's
# libraries beside it (each under its soname, as a plain file), and the licence texts.
# electron-builder.yml copies that folder to <resources>/media-engine, where a packaged app looks
# for the sidecar (src/main/mediaEngineHost.js). The Linux twin of windows/stage-sidecar.ps1. Run
# by `npm run build:media-engine:linux`; arguments after `--` reach this script:
#
#   npm run build:media-engine:linux -- [--ffmpeg-dir <prefix>] [--target-dir <dir>] [--no-build]
#
#   --ffmpeg-dir  the FFmpeg install prefix of ffmpeg-build.sh; default $FFMPEG_DIR
#   --target-dir  cargo's target directory; default $CARGO_TARGET_DIR, else native/media-engine/target
#   --no-build    stage the sidecar already in <target dir>/release, do not run cargo
#
# The sidecar and the libraries get the run path $ORIGIN (patchelf), so they find each other in
# that folder and nothing else of ours. libva, libdrm, PipeWire, libEGL, glibc and the VA-API
# driver are the user's system's. The folder is emptied first, except its tracked .gitkeep. After
# staging, `ldd` must find every FFmpeg library in that folder and nothing missing, and the
# sidecar must answer `hello` with LD_LIBRARY_PATH unset, or the script fails.
#
# Needs, besides ffmpeg-build.sh's: cargo, clang's libclang (the bindings), PipeWire's and
# libEGL's development files, patchelf (on Ubuntu: libclang-dev libpipewire-0.3-dev libegl-dev
# patchelf).
set -e -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
engine=$(dirname "$here")
dist=$engine/dist
ffmpeg=${FFMPEG_DIR:-}
target=${CARGO_TARGET_DIR:-}
build=1
while [ $# -gt 0 ]; do
  case $1 in
    --ffmpeg-dir) ffmpeg=${2:?--ffmpeg-dir needs a directory}; shift 2 ;;
    --target-dir) target=${2:?--target-dir needs a directory}; shift 2 ;;
    --no-build) build=0; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$ffmpeg" ] || { echo 'no FFmpeg: pass --ffmpeg-dir <prefix> or set FFMPEG_DIR (linux/ffmpeg-build.sh)' >&2; exit 1; }
ffmpeg=$(cd "$ffmpeg" && pwd)
[ -n "$target" ] || target=$engine/target
compgen -G "$ffmpeg/lib/libavcodec.so.*" >/dev/null || { echo "no FFmpeg libraries in $ffmpeg/lib" >&2; exit 1; }
[ -f "$ffmpeg/share/licenses/COPYING.LGPLv2.1" ] || {
  echo "no $ffmpeg/share/licenses/COPYING.LGPLv2.1 (a prefix from the current ffmpeg-build.sh has it)" >&2; exit 1; }

if [ "$build" = 1 ]; then
  # ffmpeg-sys-next takes the headers and libraries from FFMPEG_DIR; the feature is the Nix
  # package's (nix/media-engine.nix).
  (cd "$engine" && FFMPEG_DIR=$ffmpeg CARGO_TARGET_DIR=$target \
    PKG_CONFIG_PATH=$ffmpeg/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH} \
    cargo build --release --locked --features pylon-media-host/capture)
fi
exe=$target/release/pylon-media-host
[ -x "$exe" ] || { echo "no sidecar at $exe" >&2; exit 1; }

install -d -m755 "$dist"
find "$dist" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +
install -m755 "$exe" "$dist/pylon-media-host"
strip "$dist/pylon-media-host"
# The libraries from the FFmpeg prefix (what the sidecar was linked against), one file each, named
# by its soname: the name the sidecar asks for.
for f in "$ffmpeg"/lib/lib*.so.*; do
  [ -L "$f" ] && continue
  soname=$(objdump -p "$f" | awk '$1 == "SONAME" { print $2 }')
  [ -n "$soname" ] || { echo "no soname in $f" >&2; exit 1; }
  install -m755 "$f" "$dist/$soname"
done
for f in "$dist"/pylon-media-host "$dist"/lib*.so.*; do
  # The literal $ORIGIN, which the dynamic loader expands to the file's own folder.
  # shellcheck disable=SC2016
  patchelf --set-rpath '$ORIGIN' "$f"
done
install -d -m755 "$dist/licenses"
install -m644 "$ffmpeg"/share/licenses/* "$dist/licenses/"
install -m644 "$here/FFMPEG-NOTICE.txt" "$dist/"

# The checks, with nothing of ours on the library path.
staged=$dist/pylon-media-host
links=$(env -u LD_LIBRARY_PATH ldd "$staged")
echo "ldd $staged:"
echo "$links"
if grep -q 'not found' <<<"$links"; then echo 'the staged sidecar is missing a library' >&2; exit 1; fi
for lib in libavcodec libavfilter libavutil; do
  grep -q -E "^\s*$lib\.so\.[0-9]+ => $dist/" <<<"$links" || {
    echo "$lib is not taken from $dist" >&2; exit 1; }
done
hello=$(printf '{"hello":{"protocol":1}}\n' | env -u LD_LIBRARY_PATH "$staged" 2>/dev/null | grep -m1 '^{"hello"' || true)
[ -n "$hello" ] || { echo 'the staged sidecar did not answer hello' >&2; exit 1; }

echo "staged in $dist:"
(cd "$dist" && find . -type f ! -name .gitkeep -printf '  %P  %s\n' | sort)
echo "hello: $hello"
