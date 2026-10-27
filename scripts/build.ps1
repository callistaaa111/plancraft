<#
.SYNOPSIS
    Build PlanCraft: tests, PyInstaller one-folder app, portable zip and (when Inno Setup is installed) the installer.

.EXAMPLE
    .\scripts\build.ps1
    .\scripts\build.ps1 -Version 1.0.1 -SkipTests
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Python = "python",
    [switch]$SkipTests,
    [switch]$SkipInstaller,
    [switch]$SkipZip
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) {
    $match = Select-String -Path "version.py" -Pattern '__version__\s*=\s*"([^"]+)"'
    if (-not $match) { throw "Could not read __version__ from version.py" }
    $Version = $match.Matches[0].Groups[1].Value
}
Write-Host "PlanCraft $Version" -ForegroundColor Cyan

if (-not $SkipTests) {
    Write-Host "Running tests..." -ForegroundColor Cyan
    & $Python -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
}

Write-Host "Building the app with PyInstaller..." -ForegroundColor Cyan
& $Python -m PyInstaller "packaging/PlanCraft.spec" --noconfirm --clean
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }
if (-not (Test-Path "dist/PlanCraft/PlanCraft.exe")) { throw "dist/PlanCraft/PlanCraft.exe was not created." }

if (-not $SkipZip) {
    Write-Host "Making the portable zip..." -ForegroundColor Cyan
    $zip = "dist/PlanCraft-$Version-portable.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path "dist/PlanCraft" -DestinationPath $zip -CompressionLevel Optimal
}

if (-not $SkipInstaller) {
    $iscc = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($iscc) {
        Write-Host "Building the installer..." -ForegroundColor Cyan
        & $iscc "/DAppVersion=$Version" "packaging/PlanCraft.iss"
        if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed." }
    } else {
        Write-Warning "Inno Setup (ISCC.exe) was not found, so no installer was built. Install it from https://jrsoftware.org/isdl.php and run this script again."
    }
}

Write-Host ""
Write-Host "Done:" -ForegroundColor Green
Get-ChildItem "dist" -File | ForEach-Object { Write-Host "  $($_.FullName)" }
if (Test-Path "dist/installer") {
    Get-ChildItem "dist/installer" -File | ForEach-Object { Write-Host "  $($_.FullName)" }
}
