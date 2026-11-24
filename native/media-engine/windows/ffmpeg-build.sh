#!/bin/bash
# FFmpeg 9.0.2 for the engine on Windows,
# built in a portable MSYS2 (UCRT64, gcc), with ../nvenc-reconfig-no-idr.patch applied before the
# build. How to run it: ffmpeg.md beside this script.
#
# Lean: --disable-everything, and only what the
# engine calls on Windows is enabled again (pylon-media/src/video/windows/, jpeg.rs, ffi.rs):
#   - libavcodec, libavutil, and libavfilter with no filter in it (ffmpeg-sys-next links all three:
#     pylon-media's Cargo.toml asks for its avcodec and avfilter features; Windows calls no filter);
#   - the encoders h264_qsv (libvpl, linked statically) and h264_nvenc (ffnvcodec headers, the
#     driver is loaded at run time), and mjpeg for the sharer's preview (jpeg.rs);
#   - the D3D11VA hardware context (device.rs, convert.rs) and the QSV one derived from it
#     (encoder.rs), which libvpl brings; no DXVA2 (the QSV context needs only one of the two);
#   - w32threads.
# No programs (ffmpeg.exe and ffprobe.exe are not shipped), no libavformat, libavdevice,
# libswscale, libswresample, no network. LGPL only (no --enable-gpl, no --enable-nonfree). Shared
# libraries, and MSVC import libraries (.lib, made by dlltool; FFmpeg's mingw rules install them
# next to the DLLs, this script moves them to lib as BtbN's builds have them). The result is the
# engine's FFMPEG_DIR; its bin goes on PATH when the sidecar runs, or its DLLs beside it
# (build-sidecar.ps1). The licence texts of FFmpeg and of what is linked into its DLLs go to
# <prefix>/share/licenses (stage-sidecar.ps1 ships them).
#
#   ffmpeg-build.sh <work directory> <install prefix>
#     both as MSYS2 paths, for example /c/pylon/ffbuild-engine /c/pylon/ffmpeg-9.0.2-engine
set -e -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
patch_file=$here/../nvenc-reconfig-no-idr.patch
top=${1:?usage: ffmpeg-build.sh <work directory> <install prefix>}
pfx=${2:?usage: ffmpeg-build.sh <work directory> <install prefix>}
mkdir -p "$top"
cd "$top"
echo "start $(date -Is)"

deps() {
  # libvpl's dispatcher is C++: link it, libstdc++ and winpthreads statically, from a directory
  # that holds only static archives, so nothing but the FFmpeg DLLs is needed at run time. A
  # static libpthread.a first on the library path keeps avcodec from importing
  # libwinpthread-1.dll (the posix-thread gcc driver adds -lpthread).
  mkdir -p deps/lib/pkgconfig deps/include
  cp /ucrt64/lib/libvpl.a /ucrt64/lib/libstdc++.a /ucrt64/lib/libwinpthread.a /ucrt64/lib/libpthread.a deps/lib/
  # pkgconf on Windows rewrites the prefix to the .pc file's own place, so the headers go there too.
  cp -r /ucrt64/include/vpl deps/include/
  cat > deps/lib/pkgconfig/vpl.pc <<PC
prefix=$top/deps
libdir=$top/deps/lib
includedir=$top/deps/include
Name: vpl
Description: libvpl 2.17 (MSYS2), static
Version: 2.17
Libs: -L\${libdir} -lvpl -lstdc++ -lwinpthread -lole32 -lgdi32 -luuid
Cflags: -I\${includedir} -I\${includedir}/vpl
PC
}

[ -f ffmpeg-9.0.2.tar.xz ] || curl -sSL -o ffmpeg-9.0.2.tar.xz https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
echo "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e  ffmpeg-9.0.2.tar.xz" | sha256sum -c
rm -rf src build deps
mkdir src && tar -xJf ffmpeg-9.0.2.tar.xz -C src --strip-components=1
(cd src && patch -p1 < "$patch_file")
deps
mkdir build && cd build
export PKG_CONFIG_PATH=$top/deps/lib/pkgconfig:/ucrt64/lib/pkgconfig
t0=$(date +%s)
../src/configure --prefix="$pfx" \
  --enable-shared --disable-static --disable-doc --disable-autodetect \
  --disable-everything --disable-programs \
  --disable-avformat --disable-avdevice --disable-swscale --disable-swresample --disable-network \
  --enable-w32threads --enable-d3d11va \
  --enable-libvpl --enable-ffnvcodec --enable-nvenc \
  --enable-encoder=h264_qsv,h264_nvenc,mjpeg \
  "--extra-ldflags=-static-libgcc -L$top/deps/lib" | tee configure.out
echo "configure took $(( $(date +%s) - t0 )) s"
t1=$(date +%s)
make -j8
t2=$(date +%s); echo "make took $((t2 - t1)) s"
rm -rf "$pfx"
make install
mv "$pfx"/bin/*.lib "$pfx"/lib/
# Licence texts: FFmpeg's LGPL, and those of the code linked statically into its DLLs (libvpl's
# dispatcher, MIT; winpthreads, MIT and BSD) and of the NVENC headers compiled in (MIT).
lic=$pfx/share/licenses
mkdir -p "$lic"
cp ../src/COPYING.LGPLv2.1 "$lic/"
for p in libvpl winpthreads ffnvcodec-headers; do
  for f in /ucrt64/share/licenses/$p/*; do [ -f "$f" ] && cp "$f" "$lic/$p-$(basename "$f")"; done
done
grep -E '^(Enabled|External|Hardware)' -A12 configure.out > "$pfx/share/configure-summary.txt" || true
echo "install took $(( $(date +%s) - t2 )) s"

echo "--- installed $pfx"
ls -l "$pfx" "$pfx/bin" "$pfx/lib" "$lic"
echo "--- DLLs each file imports"
for f in "$pfx"/bin/*.dll; do
  echo "$(basename "$f"): $(objdump -p "$f" | sed -n 's/^\s*DLL Name: //p' | grep -v -i -E '^(api-ms-win-crt-|kernel32|advapi32|user32|gdi32|ole32|oleaut32|shell32|shlwapi|ws2_32|bcrypt|avicap32)' | tr '\n' ' ')"
done
echo "(system DLLs and the UCRT left out of that list)"
echo "--- buildconf (no ffmpeg.exe: from configure's output and the DLLs)"
grep -A3 -E '^Enabled encoders' configure.out || true
grep -A3 -E '^Enabled hwaccels|^External libraries providing hardware' configure.out || true
echo "avcodec strings reconfig_idr: $(grep -c -a reconfig_idr "$pfx"/bin/avcodec-*.dll || true)"
echo "done $(date -Is)"
