# MicroLend developer helpers (Windows / PowerShell)
#
#   . .\dev.ps1            # dot-source to load the helper functions into this shell
#
# `Tool` uses the toolchain bundled with this workspace, so no global install is required.
# It is a convenience only: the shipped project (see README.md) runs with any Node 18+, Python 3.10+
# and a normal `pip install -r backend/requirements.txt`.

$ErrorActionPreference = "Stop"

$script:MicrolendRoot = $PSScriptRoot
$script:BundledNode   = "C:\Users\23774\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$script:BundledPython = "C:\Users\23774\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$script:ToolLibs      = Join-Path $script:MicrolendRoot ".tooling\pylibs"
$script:ToolModules   = Join-Path $script:MicrolendRoot ".tooling\nm\node_modules"

function Get-MicrolendNode {
    if (Test-Path $script:BundledNode) { return $script:BundledNode }
    return (Get-Command node).Source
}

function Get-MicrolendPython {
    if (Test-Path $script:BundledPython) { return $script:BundledPython }
    return (Get-Command python).Source
}

# Compile the Solidity contract into artifacts/MicroLendPool.json
function Test-Contract {
    & (Get-MicrolendNode) (Join-Path $script:MicrolendRoot "scripts\compile.js")
}

# Run the Solidity test suite on an in-process EVM
function Test-Contracts {
    & (Get-MicrolendNode) (Join-Path $script:MicrolendRoot "test\run-tests.js")
}

# Run the backend pytest suite
function Test-Backend {
    $env:PYTHONPATH = $script:ToolLibs
    & (Get-MicrolendPython) -m pytest (Join-Path $script:MicrolendRoot "backend\tests") -q
}

# Start the Flask API on http://127.0.0.1:5000
function Start-Backend {
    $env:PYTHONPATH = $script:ToolLibs
    & (Get-MicrolendPython) (Join-Path $script:MicrolendRoot "backend\app.py")
}

Write-Host "MicroLend helpers loaded: Test-Contract, Test-Contracts, Test-Backend, Start-Backend" -ForegroundColor Cyan
