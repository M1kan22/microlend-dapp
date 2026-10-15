# Build the submission archive for the MicroLend DApp.
#
#   pwsh -File scripts/package.ps1                 # -> dist/microlend-dapp-v1.0.zip
#   pwsh -File scripts/package.ps1 -Version 1.0.1
#
# The archive contains only source, docs and tests. Development scratch state is excluded:
#   .tooling/ (bundled runtimes + offline wheel cache), .tooling-npmcache/, __pycache__/,
#   node_modules/, *.db, .env, dist/, and any downloaded artifacts.
#
# Safety: refuses to build if a file looks like it contains a real private key or a live secret,
# and refuses to ship a database or dependency tree.

param(
    [string]$Version = "1.0",
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # sc6113-dapp/
Push-Location $root
try {
    $distDir = Join-Path $root "dist"
    $stageName = "microlend-dapp"
    $stage = Join-Path $env:TEMP "$stageName-stage"
    $zipPath = Join-Path $distDir "microlend-dapp-v$Version.zip"

    Write-Host "MicroLend packaging" -ForegroundColor Cyan
    Write-Host "  source : $root"
    Write-Host "  target : $zipPath"

    # --- 1. collect the file list -------------------------------------------------------------
    $excludeDirs = @(
        '.tooling', '.tooling-npmcache', '.piptmp', 'piptmp', 'wheels', 'dist',
        'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.git',
        'logs', '.venv', 'venv'
    )
    $excludeFiles = @(
        '.env', '*.db', '*.db-wal', '*.db-shm', '*.sqlite', '*.sqlite3',
        'package-lock.json', 'deployment.local.json', '*.log', 'pipout*.txt', 'probe.py'
    )

    $all = Get-ChildItem -Path $root -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $rel = $_.FullName.Substring($root.Length).TrimStart('\')
            $parts = $rel -split '\\'
            # drop anything inside an excluded directory
            if ($parts | Where-Object { $excludeDirs -contains $_ }) { return $false }
            foreach ($pattern in $excludeFiles) {
                if ($_.Name -like $pattern) { return $false }
            }
            return $true
        }

    # generated build artifacts are optional: ship the ABI JSON, drop raw bytecode dumps
    $all = $all | Where-Object { $_.Name -ne 'MicroLendPool.json' -or $_.Directory.Name -ne 'artifacts' }

    Write-Host "  files  : $($all.Count)"

    # --- 2. secret / junk checks --------------------------------------------------------------
    if (-not $SkipChecks) {
        $problems = @()
        # A bare 0x+64hex can be a curve constant, a hash or a test vector, so require a
        # private-key-shaped string to sit next to a key-ish identifier on the same line.
        $hexPattern = '0x[0-9a-fA-F]{64}'
        $keyWords = 'private[_-]?key|priv[_-]?key|secret[_-]?key|secretkey|mnemonic|seed[_-]?phrase|DEPLOYER_PRIVATE_KEY'
        $safeFiles = '\.example$|deploy-local|dev-chain|\\test\\|_repro|_spike|_timeprobe|README|REPORT|TESTING|CHANGELOG|package\.ps1'
        foreach ($file in $all) {
            if ($file.Length -gt 6MB) { continue }
            if ($file.Extension -in @('.png', '.jpg', '.jpeg', '.woff2', '.woff', '.ttf', '.zip', '.pdf', '.db')) { continue }
            $rel = $file.FullName.Substring($root.Length).TrimStart('\')
            if ($rel -match $safeFiles) { continue }
            if (-not (Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue)) { continue }
            $lineNo = 0
            foreach ($line in (Get-Content -LiteralPath $file.FullName -ErrorAction SilentlyContinue)) {
                $lineNo++
                if ($line -notmatch $hexPattern) { continue }
                if ($line -notmatch $keyWords) { continue }
                # a placeholder/documented value is fine
                if ($line -match 'YOUR_|EXAMPLE|PLACEHOLDER|xxx|\.\.\.|REDACTED|CHANGEME|change-me') { continue }
                $problems += "possible hard-coded key in ${rel}:$lineNo"
            }
        }
        $banned = $all | Where-Object { $_.Name -like '*.db' -or $_.Name -eq '.env' }
        foreach ($b in $banned) { $problems += "forbidden file would ship: $($b.Name)" }

        if ($problems.Count -gt 0) {
            Write-Host "PACKAGING BLOCKED" -ForegroundColor Red
            $problems | Select-Object -Unique | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
            throw "$($problems.Count) packaging problem(s); nothing was written."
        }
        Write-Host "  checks : PASS (no hard-coded keys, no databases, no dependency trees)" -ForegroundColor Green
    }

    # --- 3. stage and zip ---------------------------------------------------------------------
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    New-Item -ItemType Directory -Force -Path (Join-Path $stage $stageName) | Out-Null

    foreach ($file in $all) {
        $rel = $file.FullName.Substring($root.Length).TrimStart('\')
        $dest = Join-Path (Join-Path $stage $stageName) $rel
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
        Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
    }

    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
    Compress-Archive -Path (Join-Path $stage $stageName) -DestinationPath $zipPath -CompressionLevel Optimal

    $size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Host "  result : $zipPath ($size KB)" -ForegroundColor Green

    # --- 4. verify the archive ----------------------------------------------------------------
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entries = $archive.Entries
        Write-Host "  entries: $($entries.Count)"
        $bad = $entries | Where-Object {
            $_.FullName -match '(^|/)(\.tooling|node_modules|__pycache__|\.git)(/|$)' -or
            $_.FullName -match '\.(db|zip|log)$'
        }
        if ($bad) {
            Write-Warning "archive contains excluded paths:"
            $bad | ForEach-Object { Write-Warning "   $($_.FullName)" }
        }
    } finally {
        $archive.Dispose()
    }
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    Write-Host "done." -ForegroundColor Cyan
    Write-Output $zipPath
} finally {
    Pop-Location
}
