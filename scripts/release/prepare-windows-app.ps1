param(
    [string]$ReleaseRoot = "",
    [string]$NodeCacheDir = "",
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$buildRoot = Join-Path $repoRoot "build"
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) { $ReleaseRoot = Join-Path $buildRoot "updates" }
if ([string]::IsNullOrWhiteSpace($NodeCacheDir)) { $NodeCacheDir = Join-Path $buildRoot "node-runtime-cache" }
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$NodeCacheDir = [IO.Path]::GetFullPath($NodeCacheDir)
$version = (Get-Content -Raw -LiteralPath (Join-Path $repoRoot "app\VERSION")).Trim()
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw "Invalid App version" }

$nodeVersion = "24.15.0"
$nodeHashes = @{
    "x64" = "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62"
    "arm64" = "c9eb7402eda26e2ba7e44b6727fc85a8de56c5095b1f71ebd3062892211aa116"
}
$stageRoot = Join-Path $buildRoot "offline-app-windows-$version"
$expectedPrefix = [IO.Path]::GetFullPath($buildRoot).TrimEnd('\') + '\'
if (-not ([IO.Path]::GetFullPath($stageRoot).StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase))) {
    throw "Refusing to clean stage outside build/: $stageRoot"
}
if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stageRoot, $NodeCacheDir | Out-Null

function Write-SHA256([string]$Path) {
    $digest = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$Path.sha256", "$digest`n", [Text.Encoding]::ASCII)
}

function Publish-Mutable([string]$Source, [string]$Destination) {
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $temporary = "$Destination.new"
    Copy-Item -LiteralPath $Source -Destination $temporary -Force
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
}

foreach ($arch in @("x64", "arm64")) {
    $nodeName = "node-v$nodeVersion-win-$arch.zip"
    $nodeArchive = Join-Path $NodeCacheDir $nodeName
    if (-not (Test-Path -LiteralPath $nodeArchive -PathType Leaf)) {
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/$nodeName" -OutFile $nodeArchive -TimeoutSec 300
    }
    $nodeHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($nodeHash -ne $nodeHashes[$arch]) { throw "Node.js $arch archive checksum mismatch" }

    $nodeExtract = Join-Path $stageRoot "node-$arch"
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
    $nodeRoot = Join-Path $nodeExtract "node-v$nodeVersion-win-$arch"
    $package = Join-Path $stageRoot "package-$arch"
    New-Item -ItemType Directory -Force -Path (Join-Path $package "app"), (Join-Path $package "runtime"), (Join-Path $package "scripts\local") | Out-Null
    foreach ($file in @("app.js", "favicon.svg", "index.html", "local-bridge.mjs", "README.md", "server.mjs", "styles.css", "VERSION")) {
        Copy-Item -LiteralPath (Join-Path $repoRoot "app\$file") -Destination (Join-Path $package "app\$file")
    }
    foreach ($file in @("install-user-app.ps1", "start-user-app.ps1", "stop-user-app.ps1", "uninstall-user-app.ps1")) {
        Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\local\$file") -Destination (Join-Path $package "scripts\local\$file")
    }
    Copy-Item -LiteralPath (Join-Path $nodeRoot "node.exe") -Destination (Join-Path $package "runtime\node.exe")
    Copy-Item -LiteralPath (Join-Path $nodeRoot "LICENSE") -Destination (Join-Path $package "runtime\LICENSE")
    $archive = Join-Path $stageRoot "alicerealm-app-windows-$arch.zip"
    Compress-Archive -Path (Join-Path $package "*") -DestinationPath $archive -CompressionLevel Optimal
    Write-SHA256 $archive
}

if ($Publish) {
    $versionDir = Join-Path $ReleaseRoot "app\windows\$version"
    New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
    foreach ($arch in @("x64", "arm64")) {
        foreach ($suffix in @("", ".sha256")) {
            $name = "alicerealm-app-windows-$arch.zip$suffix"
            $destination = Join-Path $versionDir $name
            if (Test-Path -LiteralPath $destination -PathType Leaf) {
                if ((Get-FileHash -LiteralPath (Join-Path $stageRoot $name) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
                    throw "Published immutable App file differs: $destination"
                }
            } else {
                Copy-Item -LiteralPath (Join-Path $stageRoot $name) -Destination $destination
            }
        }
    }
    Publish-Mutable (Join-Path $repoRoot "static\install-app.ps1") (Join-Path $ReleaseRoot "app\windows\install.ps1")
    $pointer = Join-Path $stageRoot "version.txt"
    [IO.File]::WriteAllText($pointer, "$version`n", [Text.Encoding]::ASCII)
    Publish-Mutable $pointer (Join-Path $ReleaseRoot "app\windows\latest\version.txt")
}

[PSCustomObject]@{ Version = $version; NodeVersion = $nodeVersion; Stage = $stageRoot; Published = [bool]$Publish }
