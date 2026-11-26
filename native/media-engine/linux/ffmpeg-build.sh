#!/bin/bash
# FFmpeg 9.0.2 for the engine's sidecar in the Linux AppImage and deb (the Nix package takes
# nixpkgs' FFmpeg instead, nix/ffmpeg-pylon.nix), with ../ffmpeg-vaapi-rate-change.patch applied
# before the build. The Linux twin of windows/ffmpeg-build.sh; the GitHub workflows run it on
# ubuntu-latest and cache the prefix.
#
# Lean: --disable-everything, and only what the engine calls on Linux is enabled again
# (pylon-media/src/video/linux/, jpeg.rs, ffi.rs):
#   - libavcodec, libavutil and libavfilter (ffmpeg-sys-next links all three: pylon-media's
#     Cargo.toml asks for its avcodec and avfilter features);
#   - the encoders h264_vaapi and av1_vaapi (encoder.rs, mod.rs), and mjpeg for the sharer's
#     preview (jpeg.rs);
#   - the filter scale_vaapi, the colour conversion and scaling of both graphs (encoder.rs,
#     preview.rs); buffer and buffersink, the graphs' ends, are always built;
#   - VA-API and libdrm: the VAAPI and DRM hardware contexts and the DRM PRIME frames the
#     captured DMA-BUFs are mapped from (ffi.rs, encoder.rs, va.rs);
#   - pthreads, and the x86 assembly (nasm).
# No programs, no libavformat, libavdevice, libswscale, libswresample, no network. LGPL only (no
# --enable-gpl, no --enable-nonfree). Shared libraries. libva, libdrm and glibc are linked from
# the build machine and come from the user's system at run time; nothing else is linked in.
# The result is the engine's FFMPEG_DIR (stage-sidecar.sh); FFmpeg's licence text goes to
# <prefix>/share/licenses.
#
#   ffmpeg-build.sh <work directory> <install prefix>
#
# Needs a C compiler, make, nasm, pkg-config, curl, xz, and libva's and libdrm's development
# files (on Ubuntu: build-essential nasm pkg-config curl xz-utils libva-dev libdrm-dev).
set -e -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
patch_file=$here/../ffmpeg-vaapi-rate-change.patch
top=${1:?usage: ffmpeg-build.sh <work directory> <install prefix>}
pfx=${2:?usage: ffmpeg-build.sh <work directory> <install prefix>}
mkdir -p "$top" "$(dirname "$pfx")"
top=$(cd "$top" && pwd)
pfx=$(cd "$(dirname "$pfx")" && pwd)/$(basename "$pfx")
cd "$top"
echo "start $(date -Is)"

[ -f ffmpeg-9.0.2.tar.xz ] || curl -sSL -o ffmpeg-9.0.2.tar.xz https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
echo "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e  ffmpeg-9.0.2.tar.xz" | sha256sum -c
rm -rf src build
mkdir src && tar -xJf ffmpeg-9.0.2.tar.xz -C src --strip-components=1
(cd src && patch -p1 < "$patch_file")
mkdir build && cd build
t0=$(date +%s)
../src/configure --prefix="$pfx" \
  --enable-shared --disable-static --disable-doc --disable-autodetect \
  --disable-everything --disable-programs \
  --disable-avformat --disable-avdevice --disable-swscale --disable-swresample --disable-network \
  --enable-pthreads --enable-vaapi --enable-libdrm \
  --enable-encoder=h264_vaapi,av1_vaapi,mjpeg \
  --enable-filter=scale_vaapi | tee configure.out
echo "configure took $(( $(date +%s) - t0 )) s"
# Each piece the engine needs, or the build is not the one it links against.
for want in 'h264_vaapi' 'av1_vaapi' 'mjpeg' 'scale_vaapi' 'vaapi' 'libdrm'; do
  grep -q -w "$want" configure.out || { echo "configure did not enable $want" >&2; exit 1; }
done
t1=$(date +%s)
make -j"$(nproc)"
t2=$(date +%s); echo "make took $((t2 - t1)) s"
rm -rf "$pfx"
make install
lic=$pfx/share/licenses
mkdir -p "$lic"
cp ../src/COPYING.LGPLv2.1 "$lic/"
grep -E '^(Enabled|External|Hardware|License|Libraries)' -A12 configure.out > "$pfx/share/configure-summary.txt" || true
echo "install took $(( $(date +%s) - t2 )) s"

echo "--- installed $pfx"
ls -l "$pfx" "$pfx/lib" "$lic"
echo "--- what each library needs"
for f in "$pfx"/lib/lib*.so.*; do
  [ -L "$f" ] && continue
  echo "$(basename "$f"): $(objdump -p "$f" | sed -n 's/^\s*NEEDED\s*//p' | tr '\n' ' ')"
done
echo "--- buildconf"
grep -A3 -E '^(Enabled encoders|Enabled filters|External libraries providing hardware|License)' configure.out || true
# The patch is in: its option's help text is in libavcodec.
echo "libavcodec has the patch's filler option: $(grep -c -a 'Pad constant-bitrate output with filler data' "$pfx"/lib/libavcodec.so.*.*.* || true)"
echo "done $(date -Is)"
