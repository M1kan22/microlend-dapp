# Build the academic report from Markdown:  docs/REPORT.md -> docs/MicroLend-Report.docx -> .pdf
#
#   pwsh -File scripts/build-report.ps1
#   pwsh -File scripts/build-report.ps1 -SkipPdf
#
# Two steps on purpose:
#   1. `docs/make_report.py` builds a styled, paginated DOCX with python-docx (bundled runtime).
#   2. LibreOffice converts that DOCX to PDF.
#
# In the DSH sandbox step 2 cannot run: the sandbox blocks a process from spawning a piped child,
# and the LibreOffice CLI reports `spawn EPERM`. The DOCX is always produced; to get the PDF, run
# this script outside the sandbox, or convert the DOCX with Word / LibreOffice / Google Docs.

param(
    [string]$Markdown = "docs/REPORT.md",
    [string]$OutDir   = "docs",
    [switch]$SkipPdf
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $python = if (Test-Path "C:\Users\23774\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe") {
        "C:\Users\23774\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
    } else { (Get-Command python).Source }

    # python-docx ships with the bundled runtime; a normal environment gets it from requirements.
    & $python (Join-Path $root "docs\make_report.py") --md $Markdown --outdir $OutDir --no-pdf
    if ($LASTEXITCODE -ne 0) { throw "report DOCX generation failed ($LASTEXITCODE)" }

    $docx = Join-Path $OutDir "MicroLend-Report.docx"
    $pdf  = Join-Path $OutDir "MicroLend-Report.pdf"

    if ($SkipPdf) {
        Write-Host "Skipped PDF (-SkipPdf). DOCX is at $docx" -ForegroundColor Yellow
        return
    }

    $cli = Join-Path $env:LOCALAPPDATA "..\..\DeepSeekHarness\libreoffice-kit\lib\cli.js"
    $kitCli = "D:\deepseekharsness\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js"
    $node = if (Test-Path "C:\Users\23774\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe") {
        "C:\Users\23774\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
    } else { (Get-Command node).Source }

    if (Test-Path $kitCli) {
        Write-Host "Converting DOCX -> PDF with the bundled LibreOffice kit ..." -ForegroundColor Cyan
        & $node $kitCli convert --input $docx --output $pdf
        if ($LASTEXITCODE -eq 0 -and (Test-Path $pdf)) {
            Write-Host "PDF written: $pdf" -ForegroundColor Green
            return
        }
        Write-Warning "Bundled LibreOffice conversion failed (sandbox restriction or missing backend)."
    } else {
        Write-Warning "Bundled LibreOffice kit not found."
    }

    Write-Host ""
    Write-Host "The DOCX is complete: $docx" -ForegroundColor Yellow
    Write-Host "To produce the PDF yourself, either:" -ForegroundColor Yellow
    Write-Host "  a) re-run this script outside the DSH sandbox, or"
    Write-Host "  b) open the DOCX in Word / LibreOffice and choose 'Export as PDF', or"
    Write-Host "  c) upload it to Google Docs and download as PDF."
} finally {
    Pop-Location
}
