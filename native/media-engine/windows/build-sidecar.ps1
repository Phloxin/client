# Builds the Windows sidecar with the `capture` feature (and with it `encode`) and puts FFmpeg's
# DLLs beside pylon-media-host.exe, so the sidecar runs with no FFmpeg on PATH: Windows looks for
# DLLs beside the program first (.plans/native-media-engine-m7-5-windows-capture.md, C17). The
# client starts it with no special environment, and the installer ships that one folder.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File windows\build-sidecar.ps1 `
#     -FfmpegDir <FFmpeg install prefix> -TargetDir <dir> [-LibclangPath <dir>]
#
# Run from anywhere: it builds the workspace this script belongs to (native/media-engine). FFmpeg
# is the build of ffmpeg.md. The sidecar ends up in <TargetDir>\release with the DLLs.
param(
    [Parameter(Mandatory = $true)][string]$FfmpegDir,
    [Parameter(Mandatory = $true)][string]$TargetDir,
    [string]$LibclangPath = 'C:\Program Files\LLVM\bin'
)
# Not 'Stop': cargo writes its progress to stderr, which PowerShell 5 turns into errors when the
# output is redirected.
$ErrorActionPreference = 'Continue'
$engine = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$FfmpegDir\bin\avcodec-*.dll")) { throw "no FFmpeg DLLs in $FfmpegDir\bin" }
$env:FFMPEG_DIR = $FfmpegDir
$env:LIBCLANG_PATH = $LibclangPath
$env:CARGO_TARGET_DIR = $TargetDir
Push-Location $engine
try {
    cmd /c "cargo build --release --locked --features pylon-media-host/capture 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with $LASTEXITCODE" }
} finally {
    Pop-Location
}
$release = Join-Path $TargetDir 'release'
$dlls = Get-ChildItem "$FfmpegDir\bin\*.dll"
foreach ($dll in $dlls) { Copy-Item $dll.FullName $release -Force }
"pylon-media-host.exe and $($dlls.Count) FFmpeg DLLs in $release"
$dlls | ForEach-Object { "  $($_.Name)" }
