# PlanCraft installer: checks Python, installs the libraries PlanCraft needs, and adds PlanCraft to the Desktop and the
# Start menu. Run it through "Install PlanCraft.bat". Uninstall with "Uninstall PlanCraft.bat" (your projects stay).
param(
    [switch]$Uninstall,
    [switch]$NoLaunch      # don't offer to start PlanCraft at the end
)
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $MyInvocation.MyCommand.Path
$Name = 'PlanCraft'
$Desktop = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) $Name
$Links = @((Join-Path $Desktop "$Name.lnk"), (Join-Path $StartMenu "$Name.lnk"))

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

if ($Uninstall) {
    foreach ($l in $Links) { if (Test-Path $l) { Remove-Item $l -Force; Say "Removed $l" } }
    if ((Test-Path $StartMenu) -and -not (Get-ChildItem $StartMenu)) { Remove-Item $StartMenu -Force }
    Say "PlanCraft shortcuts removed. Your projects are still in $App\data." 'Green'
    return
}

Say "Installing PlanCraft from $App" 'Cyan'
if ($App -match '\\(Downloads|Temp|AppData\\Local\\Temp)\\') {
    Say "Note: PlanCraft is in a Downloads/Temp folder. The shortcuts will point here, so move the folder somewhere permanent first if you plan to clean that folder up." 'Yellow'
}

# ---- 1. a Python 3.10+ ----------------------------------------------------------------------------------
function Find-Python {
    foreach ($cmd in @(@('python'), @('py', '-3'))) {
        try {
            $exe = & $cmd[0] $cmd[1..9] -c "import sys; print(sys.executable if sys.version_info >= (3, 10) else '')" 2>$null
            if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe) -and $exe -notmatch 'WindowsApps') { return $exe.Trim() }
        } catch { }
    }
    return $null
}
$py = Find-Python
if (-not $py) {
    Say 'Python 3 was not found. PlanCraft needs it (free, from python.org).' 'Yellow'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $ans = Read-Host 'Install Python 3.12 now with winget? (Y/N)'
        if ($ans -match '^[Yy]') {
            winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
            $py = Find-Python
        }
    }
    if (-not $py) {
        Say 'Please install Python 3 from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then run this installer again.' 'Red'
        Start-Process 'https://www.python.org/downloads/'
        exit 1
    }
}
Say "Python: $py"

# ---- 2. the libraries -----------------------------------------------------------------------------------
& $py -c "import pymupdf, PIL, openpyxl, cv2, numpy" 2>$null
if ($LASTEXITCODE -ne 0) {
    Say 'Installing the libraries PlanCraft needs (PyMuPDF, Pillow, openpyxl, OpenCV) - this needs internet, one time only...'
    & $py -m pip install --user --quiet --disable-pip-version-check -r (Join-Path $App 'requirements.txt')
    & $py -c "import pymupdf, PIL, openpyxl, cv2, numpy" 2>$null
    if ($LASTEXITCODE -ne 0) { Say 'Could not install the libraries. Check the internet connection and run the installer again.' 'Red'; exit 1 }
}
Say 'Libraries: OK'

# ---- 3. shortcuts (no console window: pythonw) ------------------------------------------------------------
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'
if (-not (Test-Path $pyw)) { $pyw = $py }
New-Item -ItemType Directory -Force $StartMenu | Out-Null
$shell = New-Object -ComObject WScript.Shell
foreach ($l in $Links) {
    $s = $shell.CreateShortcut($l)
    $s.TargetPath = $pyw
    $s.Arguments = "`"$(Join-Path $App 'server.py')`" --open --app --idle-exit 600"
    $s.WorkingDirectory = $App
    $s.IconLocation = (Join-Path $App 'PlanCraft.ico') + ',0'
    $s.Description = 'PlanCraft - offline takeoff'
    $s.Save()
    Say "Shortcut: $l"
}
Say ''
Say 'PlanCraft is installed. Start it from the PlanCraft icon on your Desktop or in the Start menu.' 'Green'
Say 'It opens in its own window and stops by itself about 10 minutes after you close that window.'
Say "Your projects are saved in $App\data."
if (-not $NoLaunch) {
    $ans = Read-Host 'Start PlanCraft now? (Y/N)'
    if ($ans -match '^[Yy]') { Start-Process $pyw -ArgumentList "`"$(Join-Path $App 'server.py')`" --open --app --idle-exit 600" -WorkingDirectory $App }
}
