#!/bin/bash
# FFmpeg 9.0.2 for the engine on Windows (.plans/native-media-engine-m7-4-windows-encoder.md, N2),
# built in a portable MSYS2 (UCRT64, gcc). From the M7 step 7.3b spike's m73b-ffbuild.sh
# (native/encoder-spike/windows/scripts/), with ../nvenc-reconfig-no-idr.patch applied before the
# build and without the spike's Quick Sync patch. How to run it: ffmpeg.md beside this script.
#
# LGPL only (no --enable-gpl, no --enable-nonfree). Shared libraries, h264_qsv (libvpl, linked
# statically), h264_nvenc (ffnvcodec headers), D3D11VA, ffmpeg.exe and ffprobe.exe, and MSVC
# import libraries (.lib, made by dlltool; FFmpeg's mingw rules install them next to the DLLs,
# this script moves them to lib as BtbN's builds have them). The result is the engine's
# FFMPEG_DIR; its bin goes on PATH when the sidecar runs.
#
#   ffmpeg-build.sh <work directory> <install prefix>
#     both as MSYS2 paths, for example /c/pylon/ffbuild-engine /c/pylon/ffmpeg-9.0.2-engine
set -e
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
  --enable-w32threads --enable-d3d11va --enable-dxva2 \
  --enable-libvpl --enable-ffnvcodec --enable-nvenc \
  "--extra-ldflags=-static-libgcc -L$top/deps/lib"
echo "configure took $(( $(date +%s) - t0 )) s"
t1=$(date +%s)
make -j8
t2=$(date +%s); echo "make took $((t2 - t1)) s"
rm -rf "$pfx"
make install
mv "$pfx"/bin/*.lib "$pfx"/lib/
echo "install took $(( $(date +%s) - t2 )) s"

echo "--- installed $pfx"
ls "$pfx" "$pfx/bin" "$pfx/lib"
echo "--- DLLs each file imports"
for f in "$pfx"/bin/*.dll "$pfx"/bin/*.exe; do
  echo "$(basename "$f"): $(objdump -p "$f" | sed -n 's/^\s*DLL Name: //p' | grep -v -i -E '^(api-ms-win-crt-|kernel32|advapi32|user32|gdi32|ole32|oleaut32|shell32|shlwapi|ws2_32|bcrypt|avicap32)' | tr '\n' ' ')"
done
echo "(system DLLs and the UCRT left out of that list)"
echo "--- buildconf"
PATH=$pfx/bin:$PATH ffmpeg -hide_banner -version | head -3
PATH=$pfx/bin:$PATH ffmpeg -hide_banner -encoders 2>/dev/null | grep -E 'h264_(qsv|nvenc)'
PATH=$pfx/bin:$PATH ffmpeg -hide_banner -h encoder=h264_nvenc 2>/dev/null | grep -E 'reconfig_idr'
echo "done $(date -Is)"
