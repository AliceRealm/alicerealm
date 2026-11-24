param(
    [string]$OutputRoot = "",
    [string]$ReleaseNotes = "AliceRealm desktop improvements and fixes."
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$configPath = Join-Path $repoRoot "desktop\src-tauri\tauri.conf.json"
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$version = [string]$config.version
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "Invalid desktop version: $version"
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot "build\desktop-release"
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "build"))
if (-not $OutputRoot.StartsWith($buildRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Desktop release output must remain under build/: $OutputRoot"
}

$bundleRoot = Join-Path $repoRoot "desktop\src-tauri\target\release\bundle\nsis"
$installerName = "AliceRealm_${version}_x64-setup.exe"
$installer = Join-Path $bundleRoot $installerName
$signature = "$installer.sig"
foreach ($path in @($installer, $signature)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing signed desktop release artifact: $path"
    }
}

$stage = Join-Path $OutputRoot $version
New-Item -ItemType Directory -Force -Path $stage | Out-Null
foreach ($path in @($installer, $signature)) {
    Copy-Item -LiteralPath $path -Destination (Join-Path $stage (Split-Path -Leaf $path)) -Force
}

$publicBase = "https://updates.alicerealm.com/desktop/windows/$version"
$signatureValue = (Get-Content -Raw -LiteralPath $signature).Trim()
if ([string]::IsNullOrWhiteSpace($signatureValue)) { throw "Updater signature is empty" }
$platform = [ordered]@{
    url = "$publicBase/$installerName"
    signature = $signatureValue
}
$manifest = [ordered]@{
    version = $version
    notes = $ReleaseNotes
    pub_date = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64-nsis" = $platform
        "windows-x86_64" = $platform
    }
}
$manifestPath = Join-Path $stage "latest.json"
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 6),
    [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText(
    (Join-Path $stage "version.txt"),
    "$version`n",
    [Text.Encoding]::ASCII
)

[PSCustomObject]@{
    Version = $version
    Stage = $stage
    Installer = $installerName
    InstallerSHA256 = (Get-FileHash -LiteralPath (Join-Path $stage $installerName) -Algorithm SHA256).Hash
    Signature = "$installerName.sig"
}
