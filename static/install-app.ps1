param(
    [string]$InstallRoot = "",
    [switch]$NoDesktopShortcut,
    [switch]$NoShortcuts,
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$updates = "https://updates.alicerealm.com"
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "AliceRealm\App"
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$parent = Split-Path -Parent $InstallRoot
if ([string]::IsNullOrWhiteSpace($parent) -or $InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot)) {
    throw "Refusing unsafe install root: $InstallRoot"
}

$architecture = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()) {
    "x64" { "x64" }
    "arm64" { "arm64" }
    default { throw "AliceRealm App supports Windows x64 and arm64 only." }
}

function Read-Text([string]$Uri) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 30
    if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content).Trim() }
    return ([string]$response.Content).Trim()
}

$version = Read-Text "$updates/app/windows/latest/version.txt"
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "Invalid AliceRealm App version response."
}
$name = "alicerealm-app-windows-$architecture.zip"
$base = "$updates/app/windows/$version"
$checksumText = Read-Text "$base/$name.sha256"
$expectedHash = (($checksumText -split '\s+')[0]).ToLowerInvariant()
if ($expectedHash -notmatch '^[0-9a-f]{64}$') { throw "Invalid AliceRealm App checksum response." }

$temporary = Join-Path $env:TEMP ("alicerealm-app-" + [Guid]::NewGuid().ToString("N"))
$archive = Join-Path $temporary $name
$stage = Join-Path $parent (".alicerealm-app-stage-" + [Guid]::NewGuid().ToString("N"))
$backup = Join-Path $parent (".alicerealm-app-backup-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $temporary, $parent | Out-Null
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $archive -TimeoutSec 180
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "AliceRealm App checksum verification failed." }
    Expand-Archive -LiteralPath $archive -DestinationPath $stage
    foreach ($required in @("app\server.mjs", "runtime\node.exe", "runtime\LICENSE", "scripts\local\install-user-app.ps1")) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) {
            throw "AliceRealm App package is incomplete: $required"
        }
    }

    if (Test-Path -LiteralPath $InstallRoot -PathType Container) {
        $stop = Join-Path $InstallRoot "scripts\local\stop-user-app.ps1"
        if (Test-Path -LiteralPath $stop -PathType Leaf) { & $stop }
        Move-Item -LiteralPath $InstallRoot -Destination $backup
    }
    try {
        Move-Item -LiteralPath $stage -Destination $InstallRoot
        if (-not $NoShortcuts) {
            $shortcutArgs = @{}
            if ($NoDesktopShortcut) { $shortcutArgs.NoDesktopShortcut = $true }
            & (Join-Path $InstallRoot "scripts\local\install-user-app.ps1") @shortcutArgs
        }
    } catch {
        if ((Test-Path -LiteralPath $backup -PathType Container) -and -not (Test-Path -LiteralPath $InstallRoot)) {
            Move-Item -LiteralPath $backup -Destination $InstallRoot
        }
        throw
    }
    if (Test-Path -LiteralPath $backup -PathType Container) { Remove-Item -LiteralPath $backup -Recurse -Force }
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

Write-Output "AliceRealm App $version installed at $InstallRoot"
if (-not $NoLaunch) { & (Join-Path $InstallRoot "scripts\local\start-user-app.ps1") -AppWindow }
