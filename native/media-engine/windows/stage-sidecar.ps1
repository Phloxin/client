# Builds the Windows sidecar and stages what the installer ships with it into native/media-engine/dist
# (.plans/native-media-engine-packaging.md, W2 and W4): pylon-media-host.exe, FFmpeg's DLLs beside
# it, and the licence texts. electron-builder.yml copies that folder to <resources>/media-engine,
# where a packaged app looks for the sidecar (src/main/mediaEngineHost.js). Run by
# `npm run build:media-engine:win`; arguments after `--` reach this script:
#
#   npm run build:media-engine:win -- [-FfmpegDir <prefix>] [-TargetDir <dir>] [-LibclangPath <dir>] [-NoBuild]
#
#   -FfmpegDir     the FFmpeg install prefix of ffmpeg.md (ffmpeg-build.sh); default $env:FFMPEG_DIR
#   -TargetDir     cargo's target directory; default $env:CARGO_TARGET_DIR, else native/media-engine/target
#   -LibclangPath  LLVM's bin, for the bindings; default $env:LIBCLANG_PATH, else C:\Program Files\LLVM\bin
#   -NoBuild       stage the sidecar already in <TargetDir>\release, do not run build-sidecar.ps1
#
# The folder is emptied first, except its tracked .gitkeep. After staging, the sidecar must answer
# `hello` from that folder with no FFmpeg on PATH (Windows looks for DLLs beside the program first),
# or the script fails.
param(
    [string]$FfmpegDir = $env:FFMPEG_DIR,
    [string]$TargetDir = $env:CARGO_TARGET_DIR,
    [string]$LibclangPath = $env:LIBCLANG_PATH,
    [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
$engine = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $engine 'dist'
if (-not $FfmpegDir) { throw 'no FFmpeg: pass -FfmpegDir <prefix> or set FFMPEG_DIR (windows\ffmpeg.md)' }
$FfmpegDir = (Resolve-Path $FfmpegDir).Path
if (-not $TargetDir) { $TargetDir = Join-Path $engine 'target' }
if (-not $LibclangPath) { $LibclangPath = 'C:\Program Files\LLVM\bin' }
$release = Join-Path $TargetDir 'release'
$exe = Join-Path $release 'pylon-media-host.exe'

if (-not $NoBuild) {
    # build-sidecar.ps1 throws on a failed build; its own output is cargo's.
    & (Join-Path $PSScriptRoot 'build-sidecar.ps1') -FfmpegDir $FfmpegDir -TargetDir $TargetDir -LibclangPath $LibclangPath
}
if (-not (Test-Path $exe)) { throw "no sidecar at $exe" }
$dlls = @(Get-ChildItem (Join-Path $FfmpegDir 'bin') -Filter *.dll)
if (-not $dlls) { throw "no FFmpeg DLLs in $FfmpegDir\bin" }
$licences = Join-Path $FfmpegDir 'share\licenses'
if (-not (Test-Path (Join-Path $licences 'COPYING.LGPLv2.1'))) {
    throw "no $licences\COPYING.LGPLv2.1 (an FFmpeg prefix from the current ffmpeg-build.sh has it)"
}

New-Item -ItemType Directory -Force $dist | Out-Null
Get-ChildItem $dist -Force | Where-Object { $_.Name -ne '.gitkeep' } | Remove-Item -Recurse -Force
Copy-Item $exe $dist
# The DLLs from the FFmpeg prefix, not from the target directory: what the sidecar was linked against.
foreach ($dll in $dlls) { Copy-Item $dll.FullName $dist }
$licenceDir = Join-Path $dist 'licenses'
New-Item -ItemType Directory -Force $licenceDir | Out-Null
Copy-Item (Join-Path $licences '*') $licenceDir
Copy-Item (Join-Path $PSScriptRoot 'FFMPEG-NOTICE.txt') $dist

# The check: hello from the staged folder, with no FFmpeg directory on PATH.
# Through cmd: the sidecar logs to stderr, which PowerShell 5 turns into errors.
$ErrorActionPreference = 'Continue'
$saved = $env:PATH
try {
    $env:PATH = (($env:PATH -split ';') | Where-Object {
        $_ -and -not (Test-Path -Path (Join-Path $_ 'avcodec-*.dll') -ErrorAction SilentlyContinue)
    }) -join ';'
    $staged = Join-Path $dist 'pylon-media-host.exe'
    $answer = cmd /c "echo {""hello"":{""protocol"":1}}| ""$staged"" 2>nul"
    $code = $LASTEXITCODE
} finally {
    $env:PATH = $saved
}
$hello = @($answer) | Where-Object { $_ -like '{"hello"*' } | Select-Object -First 1
if (-not $hello) { throw "the staged sidecar did not answer hello (exit $code): $answer" }

"staged in ${dist}:"
Get-ChildItem $dist -Recurse -File | Where-Object { $_.Name -ne '.gitkeep' } | ForEach-Object {
    "  $($_.FullName.Substring($dist.Length + 1))  $($_.Length)"
}
"hello: $hello"
