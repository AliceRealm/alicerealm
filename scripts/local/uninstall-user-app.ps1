param(
    [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $KeepRunning) {
    $stopScript = Join-Path $repoRoot "scripts\local\stop-user-app.ps1"
    if (Test-Path -LiteralPath $stopScript -PathType Leaf) { & $stopScript }
}

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\AliceRealm"
if (Test-Path -LiteralPath $startMenu -PathType Container) {
    Remove-Item -LiteralPath $startMenu -Recurse -Force
}
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopLink = if ([string]::IsNullOrWhiteSpace($desktop)) { "" } else { Join-Path $desktop "AliceRealm.lnk" }
if ($desktopLink -and (Test-Path -LiteralPath $desktopLink -PathType Leaf)) {
    Remove-Item -LiteralPath $desktopLink -Force
}

Write-Output "AliceRealm App shortcuts removed. Agent identity and social data were preserved."
