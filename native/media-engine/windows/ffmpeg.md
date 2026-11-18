# FFmpeg for the engine on Windows

The `encode` feature on Windows links FFmpeg 9.0.2 built by `ffmpeg-build.sh` (this directory)
with `../nvenc-reconfig-no-idr.patch` (h264_nvenc's `reconfig_idr`, which the engine sets to 0 so
a bitrate change brings no key frame). Quick Sync needs no patch. Background: the M7 plan
(`.plans/native-media-engine-m7-windows.md`, sections 8 and 9) and
`native/encoder-spike/REPORT-windows-b.md`, section A.

The build is lean (`.plans/native-media-engine-packaging.md`, W1): `--disable-everything` and
only what the engine calls on Windows: libavcodec, libavutil and an empty libavfilter (the
bindings link all three), the encoders `h264_qsv`, `h264_nvenc` and `mjpeg` (the preview), the
D3D11VA and QSV hardware contexts. No programs, no libavformat, libswscale, libswresample or
libavdevice. LGPL only. The script's header lists why each piece is there. Its prefix holds
`bin` (the three DLLs), `include`, `lib` (MSVC import libraries) and `share/licenses` (FFmpeg's
`COPYING.LGPLv2.1` and the licences of libvpl, winpthreads and nv-codec-headers).

1. A portable MSYS2 with the UCRT64 packages: the spike's
   `native/encoder-spike/windows/scripts/m73b-msys2.ps1` makes one in
   a directory of your choice, `<msys64>` below (gcc, binutils, make, diffutils, patch, tar, xz,
   curl, pkgconf, nasm, libvpl, ffnvcodec-headers). The GitHub workflows use the
   `msys2/setup-msys2` action with the same packages.
2. Copy this directory and the patch to the machine, keeping `windows/` beside the patch.
3. Run the script in UCRT64 (the full build of step 7.3b took about 19 minutes on a 4-core
   laptop; the lean one is much shorter). It takes the work directory
   and the install prefix as arguments, both as MSYS2 paths (`/c/...`). `<work>` and `<prefix>`
   below stand for them, for example `/c/pylon/ffbuild-engine` and
   `/c/pylon/ffmpeg-9.0.2-engine`:
   ```
   set MSYSTEM=UCRT64
   set CHERE_INVOKING=1
   set MSYS2_PATH_TYPE=minimal
   <msys64>\usr\bin\bash.exe -l <path>/windows/ffmpeg-build.sh <work> <prefix>
   ```
   From ssh, start it as a scheduled task (the spike's `m73b-detach.ps1`) so a dropped
   connection does not end it.
4. Build the sidecar against it, from `native/media-engine` in an MSVC developer environment:
   ```
   set FFMPEG_DIR=<the install prefix as a Windows path, for example C:\pylon\ffmpeg-9.0.2-engine>
   set LIBCLANG_PATH=C:\Program Files\LLVM\bin
   cargo build --release --features pylon-media-host/encode
   ```
5. The sidecar needs the prefix's `bin` on `PATH` when it runs, or FFmpeg's DLLs beside it.
   `build-sidecar.ps1` (this directory) builds it with `capture` and copies the DLLs beside
   `pylon-media-host.exe`, so it runs with no `PATH` change (M7.5 C17):
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File windows\build-sidecar.ps1 -FfmpegDir <prefix> -TargetDir <dir>
   ```
6. For the installer, `stage-sidecar.ps1` (this directory, run by `npm run build:media-engine:win`
   from the client's root) runs `build-sidecar.ps1` and stages `pylon-media-host.exe`, the DLLs,
   `licenses\` and `FFMPEG-NOTICE.txt` into `native/media-engine/dist`, then checks that the
   staged sidecar answers `hello` with no FFmpeg on `PATH`. `electron-builder.yml` ships that
   folder as `resources\media-engine`, where a packaged app looks for the sidecar:
   ```
   set FFMPEG_DIR=<prefix>
   npm run build:media-engine:win
   npm run build:win
   ```
   Without it the installer is built without a sidecar, and the setting's row stays hidden.

The build of step 7.3b (`ffmpeg-9.0.2-p` on the test laptop) is the full one, before the lean
recipe: every component, `ffmpeg.exe` and `ffprobe.exe`, this patch and the spike's Quick Sync
patch, whose options are off by default and then change nothing. Steps 7.4 to the load test
used it.
