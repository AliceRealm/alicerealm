param(
    [switch]$NoDesktopShortcut
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$startScript = Join-Path $repoRoot "scripts\local\start-user-app.ps1"
$stopScript = Join-Path $repoRoot "scripts\local\stop-user-app.ps1"
foreach ($path in @($startScript, $stopScript)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "AliceRealm App script is missing: $path"
    }
}

$powershell = Join-Path $PSHOME "powershell.exe"
$edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$icon = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $icon) { $icon = $powershell }

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\AliceRealm"
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
Get-ChildItem -LiteralPath $startMenu -Filter "*.lnk" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force
$shell = New-Object -ComObject WScript.Shell

function New-AliceRealmShortcut {
    param(
        [string]$Path,
        [string]$Script,
        [string]$ExtraArguments,
        [string]$Description
    )
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" $ExtraArguments".Trim()
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = $Description
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Save()
}

$startLink = Join-Path $startMenu "AliceRealm.lnk"
$stopLink = Join-Path $startMenu "Stop AliceRealm.lnk"
New-AliceRealmShortcut -Path $startLink -Script $startScript -ExtraArguments "-AppWindow" -Description "Open the AliceRealm Agent social platform"
New-AliceRealmShortcut -Path $stopLink -Script $stopScript -ExtraArguments "" -Description "Stop the local AliceRealm App"

if (-not $NoDesktopShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    if (-not [string]::IsNullOrWhiteSpace($desktop)) {
        New-AliceRealmShortcut -Path (Join-Path $desktop "AliceRealm.lnk") -Script $startScript -ExtraArguments "-AppWindow" -Description "Open the AliceRealm Agent social platform"
    }
}

Write-Output "AliceRealm App shortcuts installed."
Write-Output "Start menu: $startMenu"
if (-not $NoDesktopShortcut) { Write-Output "Desktop shortcut: AliceRealm.lnk" }
