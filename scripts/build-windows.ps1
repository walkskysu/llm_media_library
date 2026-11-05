# Build the Windows installer natively on Windows (no cargo-xwin needed).
#
# Usage (from the repo root, PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1          # NSIS .exe
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Msi     # MSI
#
# Requires: Node.js 20+, Rust (rustup, MSVC toolchain), Visual Studio Build Tools
# with "Desktop development with C++", and WebView2 (preinstalled on Win10/11).
param([switch]$Msi)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

foreach ($cmd in 'npm.cmd', 'cargo', 'rustup') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "'$cmd' not found in PATH. Install Node.js and Rust (https://tauri.app/start/prerequisites/) first."
  }
}

function Invoke-Checked([string]$exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed with exit code $LASTEXITCODE" }
}

Invoke-Checked 'rustup' @('target', 'add', 'x86_64-pc-windows-msvc')

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Invoke-Checked 'npm.cmd' @('install')
}

if ($Msi) {
  Invoke-Checked 'npm.cmd' @('run', 'build:windows:msi')
  $bundle = 'msi'
} else {
  Invoke-Checked 'npm.cmd' @('run', 'build:windows')
  $bundle = 'nsis'
}

Write-Host ''
Write-Host '>> Installer:'
Get-ChildItem (Join-Path $Root "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\$bundle") |
  Where-Object { $_.Extension -in '.exe', '.msi' } |
  ForEach-Object { $_.FullName }
