# Capture the MicroLend frontend at several viewports.
#
# Chromium's multi-process IPC needs named pipes, which the default DSH sandbox blocks
# (mojo platform_channel.cc: Access denied). This script therefore has to run with wider
# access; it only launches a headless browser, writes PNGs into frontend/screenshots/ and
# touches nothing else.
#
#   pwsh -File scripts/capture-ui.ps1
#   pwsh -File scripts/capture-ui.ps1 -Sizes "1440x900","1920x1080"

param(
    [string]$Sizes   = "1440x900,1280x800,820x1180",
    [string]$Page    = "frontend/index.html",
    [string]$OutDir  = "frontend/screenshots",
    [string]$Browser = "",
    [int]$Tall       = 2400,
    [string]$PageQuery = "",
    [string]$NameSuffix = "",
    [switch]$ViewportOnly
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not $Browser) {
        $Browser = @(
            "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
            "C:\Program Files\Google\Chrome\Application\chrome.exe"
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if (-not $Browser) { throw "no Chromium-family browser found" }

    $pagePath = (Resolve-Path $Page).Path
    $uri = "file:///" + ($pagePath -replace '\\', '/') + $PageQuery
    $out = Join-Path $root $OutDir
    New-Item -ItemType Directory -Force -Path $out | Out-Null

    # a private profile keeps the real browser profile untouched
    $profile = Join-Path $env:TEMP ("ml-shot-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $profile | Out-Null

    Write-Host "browser : $Browser"
    Write-Host "page    : $uri"
    Write-Host "output  : $out"
    Write-Host ""

    $ok = 0
    $list = $Sizes -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+x\d+$' }
    if ($list.Count -eq 0) { throw "no valid sizes in '$Sizes' (expected e.g. 1440x900,1280x800)" }

    foreach ($size in $list) {
        $w = [int]($size -split 'x')[0]
        $h = [int]($size -split 'x')[1]
        # keep the filename free of separators and the -Tall height, so a viewport is
        # identifiable at a glance and cannot collide with another capture
        $name = if ($ViewportOnly) { "ui-${w}x${h}$NameSuffix.png" } else { "ui-${w}$NameSuffix.png" }
        $file = Join-Path $out $name
        Remove-Item $file -ErrorAction SilentlyContinue

        # Capture the whole document: a tall window plus a generous virtual time budget so
        # the JS has settled (demo ledger seeded, gauge animated, fonts swapped in).
        $window = if ($ViewportOnly) { $size } else { "${w}x$Tall" }

        $browserArgs = @(
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--user-data-dir=$profile",
            "--window-size=$window",
            "--virtual-time-budget=8000",
            "--screenshot=$file",
            $uri
        )

        & $Browser @browserArgs 2>&1 |
            Where-Object { $_ -match "written to file|Invalid --window-size|FAILED|Check failed" } |
            Select-Object -First 2 | ForEach-Object { "   $_" }

        if (Test-Path $file) {
            $kb = [math]::Round((Get-Item $file).Length / 1KB, 1)
            Write-Host ("  OK    {0,-16} {1,8} KB  (window {2})" -f $name, $kb, $window) -ForegroundColor Green
            $ok++
        } else {
            Write-Host ("  FAIL  {0,-16} no file produced" -f $name) -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "$ok/$($list.Count) viewport(s) captured"
    if ($ok -gt 0) { Write-Host "open $out to inspect" }
    exit $(if ($ok -eq $list.Count) { 0 } else { 1 })
} finally {
    Pop-Location
}
