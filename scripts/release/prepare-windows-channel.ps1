param(
    [Parameter(Mandatory = $true)][string]$SigningKeyFile,
    [string]$GoPath = "go",
    [string]$ReleaseRoot = "",
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$cliRoot = Join-Path $repoRoot "cli"
$configPath = Join-Path $cliRoot ".cli.config"
$buildRoot = Join-Path $repoRoot "build"
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) { $ReleaseRoot = Join-Path $buildRoot "updates" }
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
if (-not (Test-Path -LiteralPath $SigningKeyFile -PathType Leaf)) { throw "Signing key not found: $SigningKeyFile" }

function Read-ConfigValue([string]$Name) {
    $line = Get-Content -LiteralPath $configPath | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
    if (-not $line) { throw "Missing $Name in $configPath" }
    return ($line -split "=", 2)[1].Trim()
}

function Invoke-Go {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $GoPath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Go command failed: $($Arguments -join ' ')" }
}

function Write-SHA256([string]$Path) {
    $digest = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$Path.sha256", "$digest`n", [Text.Encoding]::ASCII)
}

function Copy-Immutable([string]$Source, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination -PathType Leaf) {
        $sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
        $destinationHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
        if ($sourceHash -ne $destinationHash) { throw "Published immutable file differs: $Destination" }
        return
    }
    Copy-Item -LiteralPath $Source -Destination $Destination
}

function Publish-Mutable([string]$Source, [string]$Destination) {
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $temporary = "$Destination.new"
    Copy-Item -LiteralPath $Source -Destination $temporary -Force
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
}

$version = Read-ConfigValue "CLI_VERSION"
$minimum = Read-ConfigValue "SKILLS_MIN_CLI_VERSION"
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw "Invalid CLI_VERSION" }
if ($minimum -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw "Invalid SKILLS_MIN_CLI_VERSION" }

& git -C $repoRoot diff --quiet -- cli skills
if ($LASTEXITCODE -ne 0) { throw "Commit CLI and Skills changes before preparing a signed release" }
$commit = (& git -C $repoRoot rev-parse --short=8 HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to resolve the release commit" }

$stage = Join-Path $buildRoot "offline-windows-$version"
$expectedStagePrefix = [IO.Path]::GetFullPath($buildRoot).TrimEnd('\') + '\'
if (-not ([IO.Path]::GetFullPath($stage).StartsWith($expectedStagePrefix, [StringComparison]::OrdinalIgnoreCase))) {
    throw "Refusing to clean a stage outside build/: $stage"
}
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
$cliStage = Join-Path $stage "cli"
$skillsStage = Join-Path $stage "skills-stage"
New-Item -ItemType Directory -Force -Path $cliStage, $skillsStage | Out-Null

$previousCache = $env:GOCACHE
$previousTelemetry = $env:GOTELEMETRY
$previousAppData = $env:APPDATA
$previousGOOS = $env:GOOS
$previousGOARCH = $env:GOARCH
$previousCGO = $env:CGO_ENABLED
try {
    $env:GOCACHE = Join-Path $buildRoot "gocache"
    $env:GOTELEMETRY = "off"
    $env:APPDATA = Join-Path $buildRoot "go-appdata"
    New-Item -ItemType Directory -Force -Path $env:APPDATA | Out-Null
    Push-Location $cliRoot
    try {
        $hostGOOS = (& $GoPath env GOOS).Trim()
        $hostGOARCH = (& $GoPath env GOARCH).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $hostGOOS -or -not $hostGOARCH) { throw "Unable to resolve host Go platform" }
        $publicKey = (& $GoPath run ./cmd/manifestgen --print-public-key --signing-key-file $SigningKeyFile).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($publicKey)) { throw "Unable to derive Skills public key" }
        $ldflags = "-X main.Version=$version -X main.Commit=$commit -X github.com/AliceRealm/alicerealm/cli/internal/skills.VerifyPublicKeyBase64=$publicKey"
        foreach ($arch in @("amd64", "arm64")) {
            $env:GOOS = "windows"
            $env:GOARCH = $arch
            $env:CGO_ENABLED = "0"
            $binary = Join-Path $cliStage "alicerealm-windows-$arch.exe"
            Invoke-Go -Arguments @("build", "-trimpath", "-ldflags", $ldflags, "-o", $binary, ".")
            Write-SHA256 $binary
        }

        $env:GOOS = $hostGOOS
        $env:GOARCH = $hostGOARCH
        $env:CGO_ENABLED = "0"
        $allowlist = @(& $GoPath run ./cmd/manifestgen --print-allowlist --skills-dir (Join-Path $repoRoot "skills"))
        if ($LASTEXITCODE -ne 0 -or $allowlist.Count -eq 0) { throw "Skills allowlist is empty" }
        foreach ($name in $allowlist) {
            Copy-Item -LiteralPath (Join-Path $repoRoot "skills\$name") -Destination (Join-Path $skillsStage $name) -Recurse
        }
        $archive = Join-Path $stage "skills.tar.gz"
        & tar -czf $archive -C $skillsStage .
        if ($LASTEXITCODE -ne 0) { throw "Could not create Skills archive" }
        Write-SHA256 $archive

        $currentManifest = Join-Path $ReleaseRoot "skills\latest\manifest.json"
        $sequence = 1
        if (Test-Path -LiteralPath $currentManifest -PathType Leaf) {
            $sequence = ([int64](Get-Content -Raw -LiteralPath $currentManifest | ConvertFrom-Json).sequence) + 1
        }
        $manifest = Join-Path $stage "manifest.json"
        Invoke-Go -Arguments @("run", "./cmd/manifestgen", "--skills-dir", $skillsStage, "--cli-version", $version, "--min-cli-version", $minimum, "--sequence", "$sequence", "--signing-key-file", $SigningKeyFile, "--tarball", $archive, "--out", $manifest)
        $verifyTool = Join-Path $stage "releaseverify.exe"
        Invoke-Go -Arguments @("build", "-trimpath", "-ldflags", "-X github.com/AliceRealm/alicerealm/cli/internal/skills.VerifyPublicKeyBase64=$publicKey", "-o", $verifyTool, "./cmd/releaseverify")
        & $verifyTool --manifest $manifest --bundle $stage
        if ($LASTEXITCODE -ne 0) { throw "Signed Skills release verification failed" }
    } finally {
        Pop-Location
    }
} finally {
    $env:GOCACHE = $previousCache
    $env:GOTELEMETRY = $previousTelemetry
    $env:APPDATA = $previousAppData
    $env:GOOS = $previousGOOS
    $env:GOARCH = $previousGOARCH
    $env:CGO_ENABLED = $previousCGO
}

if ($Publish) {
    $versionDir = Join-Path $ReleaseRoot "cli\$version"
    New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
    foreach ($arch in @("amd64", "arm64")) {
        foreach ($suffix in @("", ".sha256")) {
            $name = "alicerealm-windows-$arch.exe$suffix"
            Copy-Immutable (Join-Path $cliStage $name) (Join-Path $versionDir $name)
        }
    }
    foreach ($prefix in @("skills\latest", "cli\latest")) {
        Publish-Mutable (Join-Path $stage "manifest.json") (Join-Path $ReleaseRoot "$prefix\manifest.json")
        Publish-Mutable (Join-Path $stage "skills.tar.gz") (Join-Path $ReleaseRoot "$prefix\skills.tar.gz")
        Publish-Mutable (Join-Path $stage "skills.tar.gz.sha256") (Join-Path $ReleaseRoot "$prefix\skills.tar.gz.sha256")
    }
    Publish-Mutable (Join-Path $repoRoot "skills\install.md") (Join-Path $ReleaseRoot "skills\latest\install.md")
    $pointerSource = Join-Path $stage "windows-version.txt"
    [IO.File]::WriteAllText($pointerSource, "$version`n", [Text.Encoding]::ASCII)
    Publish-Mutable $pointerSource (Join-Path $ReleaseRoot "cli\windows\latest\version.txt")
}

[PSCustomObject]@{
    Version = $version
    Commit = $commit
    Stage = $stage
    Published = [bool]$Publish
    ReleaseRoot = $ReleaseRoot
}
