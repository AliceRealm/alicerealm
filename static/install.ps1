# ============================================================
# AliceRealm CLI Installer for Windows
# Usage: irm https://alicerealm.com/install.ps1 | iex
# ============================================================

param(
    [ValidatePattern('^(?-i:EF-[0-9A-Za-z]{8})?$')]
    [string]$Ref = "",
    [string]$Endpoint = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$CdnUrl = if ($env:ALICEREALM_CDN_URL) { $env:ALICEREALM_CDN_URL } else { "https://updates.alicerealm.com" }
$GithubRepo = "GardenVilla/alicerealm"
$Branch = "main"
$ExplicitEigenfluxHome = $env:ALICEREALM_HOME
if (-not $Endpoint) {
    $Endpoint = if ($env:ALICEREALM_API_URL) { $env:ALICEREALM_API_URL } else { "https://alicerealm.com" }
}
$Endpoint = $Endpoint.TrimEnd('/')

function Info($msg)  { Write-Host $msg -ForegroundColor Cyan }
function Ok($msg)    { Write-Host $msg -ForegroundColor Green }
function Err($msg)   { Write-Host $msg -ForegroundColor Red; exit 1 }

function Get-InvokingHost {
    if ($env:INVOKING_HOST) { return $env:INVOKING_HOST }
    if ($env:ALICEREALM_HOST) { return ($env:ALICEREALM_HOST -split '/')[0] }
    if ($env:CLAUDECODE) { return "claude-code" }
    if ($env:CODEX_THREAD_ID -or $env:CODEX_SANDBOX) { return "codex" }
    return ""
}

function Resolve-EigenfluxHome {
    param([string]$ExplicitHome, [string]$InvokingHost)
    if ($ExplicitHome) { return $ExplicitHome }
    switch ($InvokingHost) {
        "codex" { return (Join-Path $env:USERPROFILE ".alicerealm-codex\.alicerealm") }
        "openclaw" { return (Join-Path $env:USERPROFILE ".openclaw\.alicerealm") }
        default { return (Join-Path $env:USERPROFILE ".alicerealm") }
    }
}

# ── Helper: download with retry, temp file, optional SHA256 ──

function Download-WithRetry {
    param(
        [string]$Url,
        [string]$Destination,
        [ValidateRange(1, 10)][int]$MaxRetries = 3,
        [string]$Sha256Url = "",
        [switch]$CliInstallation
    )

    $tmpFile = Join-Path $env:TEMP ("alicerealm-dl-" + [System.IO.Path]::GetRandomFileName() + ".exe")
    $attempt = 0
    $downloaded = $false

    try {
        while ($attempt -lt $MaxRetries -and -not $downloaded) {
            $attempt++
            try {
                if ($attempt -gt 1) { Info "Retry ${attempt}/${MaxRetries}..." }
                Invoke-WebRequest -Uri $Url -OutFile $tmpFile -UseBasicParsing -TimeoutSec 30
                $downloaded = $true
            } catch {
                if ($attempt -ge $MaxRetries) {
                    throw "Download failed after ${MaxRetries} attempts: ${Url}`n$($_.Exception.Message)"
                }
                Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
                Start-Sleep -Seconds (2 * $attempt)
            }
        }

        if ($Sha256Url) {
            # A missing checksum is a failed release, not permission to install
            # unverified bytes. Use text explicitly on both PowerShell 5.1 and 7.
            try {
                $response = Invoke-WebRequest -Uri $Sha256Url -UseBasicParsing -TimeoutSec 30
            } catch {
                throw "Failed to fetch SHA256 checksum from ${Sha256Url}: $($_.Exception.Message)"
            }
            $checksum = $response.Content
            if ($checksum -is [byte[]]) { $checksum = [System.Text.Encoding]::UTF8.GetString($checksum) }
            $expectedHash = ([string]$checksum).Trim()
            if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$') {
                throw "Invalid SHA256 checksum from ${Sha256Url}"
            }
            $actualHash = (Get-FileHash -Path $tmpFile -Algorithm SHA256).Hash
            if ($actualHash -ne $expectedHash) {
                throw "SHA256 mismatch for ${Url}: expected ${expectedHash}, got ${actualHash}"
            }
            Ok "SHA256 verified"
        }

        $destDir = Split-Path -Parent $Destination
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        if ($CliInstallation) {
            $hostName = Get-InvokingHost
            $homeDir = Resolve-EigenfluxHome -ExplicitHome $ExplicitEigenfluxHome -InvokingHost $hostName
            & $tmpFile --homedir $homeDir installation replace "--destination=$Destination" "--host=$hostName" "--skills-target="
            if ($LASTEXITCODE -ne 0) { throw "CLI installation failed; another installation or uninstall may be active." }
        } else {
            Move-Item -Path $tmpFile -Destination $Destination -Force
        }
    } finally {
        Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
    }
}

# Only HTTP 404 permits fallback to the legacy bridge release channel.
function Get-LatestCliVersion {
    try {
        $value = (Invoke-RestMethod -Uri "${CdnUrl}/cli/v2/latest/version.txt" -TimeoutSec 30).Trim()
    } catch {
        if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404) {
            throw
        }
        $value = (Invoke-RestMethod -Uri "${CdnUrl}/cli/latest/version.txt" -TimeoutSec 30).Trim()
    }
    if ($value -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
        throw 'Invalid published CLI version'
    }
    return $value
}

# ── Step 1: Install CLI binary ────────────────────────────────

function Install-Cli {
    $arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
        "X64"   { "amd64" }
        "Arm64" { "arm64" }
        default { Err "Unsupported architecture: $_" }
    }

    $binName = "alicerealm-windows-${arch}.exe"
    Info "Detected: windows/${arch}"

    try {
        $script:latestVersion = Get-LatestCliVersion
    } catch {
        Err "Failed to fetch latest version from ${CdnUrl}"
    }
    Info "Latest version: ${script:latestVersion}"

    $currentVersion = $null
    $alicerealmCmd = Get-Command alicerealm -ErrorAction SilentlyContinue
    if ($alicerealmCmd) {
        try { $currentVersion = (& alicerealm version --short 2>$null).Trim() } catch {}
        if ($currentVersion -eq $script:latestVersion) {
            $script:installedCliPath = $alicerealmCmd.Source
            $script:installDir = Split-Path -Parent $script:installedCliPath
            Ok "alicerealm ${currentVersion} is already up to date."
            return
        }
        Info "Upgrading alicerealm ${currentVersion} -> ${script:latestVersion}"
    } else {
        Info "Installing alicerealm ${script:latestVersion}"
    }

    $downloadUrl = "${CdnUrl}/cli/${script:latestVersion}/${binName}"
    $sha256Url = "${CdnUrl}/cli/${script:latestVersion}/${binName}.sha256"

    # Resolve install directory. Priority:
    #   1. ALICEREALM_INSTALL_DIR env var (explicit user override)
    #   2. D:\alicerealm when a D: drive exists (default)
    #   3. %LOCALAPPDATA%\local\bin (fallback for C-only machines)
    $fallbackDir = Join-Path $env:LOCALAPPDATA "local\bin"
    if ($env:ALICEREALM_INSTALL_DIR) {
        $script:installDir = $env:ALICEREALM_INSTALL_DIR
        Info "Using ALICEREALM_INSTALL_DIR: $($script:installDir)"
    } elseif (Test-Path "D:\") {
        $script:installDir = "D:\alicerealm"
    } else {
        $script:installDir = $fallbackDir
        Info "D: drive not found; installing to ${fallbackDir}"
    }
    $installPath = Join-Path $script:installDir "alicerealm.exe"
    $script:installedCliPath = $installPath

    Info "Downloading ${downloadUrl}..."
    Download-WithRetry -Url $downloadUrl -Destination $installPath -Sha256Url $sha256Url -CliInstallation

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$($script:installDir)*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$($script:installDir)", "User")
        $env:Path = "$env:Path;$($script:installDir)"
        Info "Added $($script:installDir) to user PATH"
    }

    $script:installedCliPath = $installPath
    Ok "alicerealm ${script:latestVersion} installed successfully"
    try { & $installPath version } catch {}
}

function Save-InstallReferral {
    if (-not $Ref) { return }
    $homeDir = Resolve-EigenfluxHome -ExplicitHome $ExplicitEigenfluxHome -InvokingHost (Get-InvokingHost)
    & $script:installedCliPath --homedir $homeDir agent install-ref --ref $Ref --endpoint $Endpoint | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Referral code could not be saved for this Agent Home and server; resolve the error and retry before onboarding."
    }
}

function Report-InstallAttribution {
    if (-not $Ref) { return }
    $payload = @{ ref = $Ref; metadata = @{ os = 'windows'; via = 'install.ps1' } } | ConvertTo-Json -Compress
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $status = 0
        try {
            $response = Invoke-WebRequest -Uri "${Endpoint}/api/v1/install/report" -Method Post -ContentType 'application/json' -Body $payload -UseBasicParsing -TimeoutSec 15
            $status = [int]$response.StatusCode
            $body = $response.Content
            if ($body -is [byte[]]) { $body = [System.Text.Encoding]::UTF8.GetString($body) }
            $receipt = [string]$body | ConvertFrom-Json
            if ($status -eq 200 -and ($receipt.code -is [int] -or $receipt.code -is [long]) -and $receipt.code -eq 0 -and
                $receipt.data.converted -is [bool] -and $receipt.data.attribution.ref -ceq $Ref) {
                Ok "Install attributed (ref ${Ref})"
                return
            }
        } catch {
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        }
        if ($status -ne 0 -and $status -ne 200 -and $status -ne 408 -and $status -ne 429 -and $status -lt 500) { break }
        if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
    }
    Info "CLI installation succeeded, but attribution reporting is incomplete (HTTP ${status}); installation continues."
}

# ── Step 2: Install skills ────────────────────────────────────

function Install-Skills {
    $hostName = Get-InvokingHost
    $homeDir = Resolve-EigenfluxHome -ExplicitHome $ExplicitEigenfluxHome -InvokingHost $hostName
    $cli = $script:installedCliPath
    $script:installedSkillsTarget = ""
    Info "Installing AliceRealm skills..."
    & $cli --homedir $homeDir skills sync "--host=$hostName"
    if ($LASTEXITCODE -ne 0) { throw "Skills sync failed; retry installation before onboarding." }
    $script:installedSkillsTarget = (& $cli --homedir $homeDir skills path "--host=$hostName" | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $script:installedSkillsTarget) { throw "Could not resolve the managed Skills directory." }
    Ok "AliceRealm skills synced to $($script:installedSkillsTarget)"
}

# ── Step 3: Migrate legacy config ─────────────────────────────

function Migrate-Config {
    $installPath = $script:installedCliPath
    $openclawStateDir = Join-Path $env:USERPROFILE ".openclaw"
    $invokingHost = Get-InvokingHost
    $efHome = Resolve-EigenfluxHome -ExplicitHome $ExplicitEigenfluxHome -InvokingHost $invokingHost
    $env:ALICEREALM_HOME = $efHome

    if ($invokingHost -eq "openclaw") {
        if (-not (Test-Path $openclawStateDir)) {
            New-Item -ItemType Directory -Path $openclawStateDir -Force | Out-Null
        }
        $envFile = Join-Path $openclawStateDir ".env"
        $envLine = "ALICEREALM_HOME=`"${efHome}`""

        if (-not (Test-Path $envFile)) {
            New-Item -ItemType File -Path $envFile -Force | Out-Null
        }
        $existing = @(Get-Content $envFile -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch '^ALICEREALM_HOME=' })
        Set-Content -Path $envFile -Value @($existing + $envLine)
        Info "Set ALICEREALM_HOME in ${envFile}"
    }

    try { & $installPath --homedir $efHome migrate 2>$null } catch {}
}

# ── Step 4: Detect and configure AI agents ────────────────────

# Keep these boundaries aligned with the published plugins' minGatewayVersion
# and static/install.sh: current 2026.5.7, pinned 0.0.8 2026.3.1.
function Select-OpenClawPlugin {
    $ocVersion = $null
    if ($env:OPENCLAW_VERSION) {
        $ocVersion = $env:OPENCLAW_VERSION
        Info "Using OPENCLAW_VERSION from environment: ${ocVersion}"
    } else {
        try {
            $ocRaw = & openclaw --version 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0) {
                $versionMatch = [regex]::Match($ocRaw, '(?m)(?<!\S)v?([0-9]+\.[0-9]+\.[0-9]+\S*)')
                if ($versionMatch.Success) { $ocVersion = $versionMatch.Groups[1].Value }
            }
        } catch {
            $ocVersion = $null
        }
    }
    $parsedVersion = $null
    if (-not $ocVersion -or $ocVersion -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or
        -not [version]::TryParse($ocVersion, [ref]$parsedVersion)) {
        Write-Warning "Could not verify a stable OpenClaw version; plugin setup skipped. Check openclaw --version, upgrade to 2026.5.7 or later, then retry."
        Write-Host '{"component":"openclaw-alicerealm","status":"skipped","reason":"unverified_gateway_version"}'
        return $null
    }
    if ($parsedVersion -ge [version]'2026.5.7') {
        $pluginSpec = "@gardenvilla/openclaw-alicerealm"
    } elseif ($parsedVersion -ge [version]'2026.3.1' -and $parsedVersion -lt [version]'2026.5.2') {
        $pluginSpec = "@gardenvilla/openclaw-alicerealm@0.0.8"
    } else {
        Write-Warning "OpenClaw ${ocVersion} has no verified compatible plugin selection; plugin setup skipped. Upgrade OpenClaw to 2026.5.7 or later, then retry."
        Write-Host '{"component":"openclaw-alicerealm","status":"skipped","reason":"unsupported_gateway_version"}'
        return $null
    }
    return [pscustomobject]@{ Version = $ocVersion; Spec = $pluginSpec }
}

function Setup-Agents {
    $openclawCmd = Get-Command openclaw -ErrorAction SilentlyContinue
    if (-not $openclawCmd) { return }

    Info ""
    Info "OpenClaw environment detected."
    $selection = Select-OpenClawPlugin
    if (-not $selection) { return }
    $pluginSpec = $selection.Spec
    Info "OpenClaw version: $($selection.Version) -> plugin: ${pluginSpec}"

    function Install-OpenClawPlugin {
        param(
            [string]$Spec,
            [bool]$AlreadyInstalled
        )

        if ($AlreadyInstalled -and $Spec -ne "@gardenvilla/openclaw-alicerealm") {
            Info "Reinstalling OpenClaw plugin with ${Spec}..."
            try { & openclaw plugins uninstall openclaw-alicerealm --force 2>$null } catch {}
            & openclaw plugins install $Spec
        } elseif ($AlreadyInstalled) {
            Info "Updating OpenClaw plugin to latest..."
            & openclaw plugins update openclaw-alicerealm 2>$null
            if ($LASTEXITCODE -ne 0) {
                & openclaw plugins install $Spec
            }
        } else {
            & openclaw plugins install $Spec
        }
    }

    $pluginInstalled = $false
    try {
        if ((& openclaw plugins list 2>$null) -match "alicerealm") {
            $pluginInstalled = $true
        }
    } catch {}

    $pluginChanged = $false
    if (-not $pluginInstalled) {
        if ([Console]::IsOutputRedirected) {
            Info "Non-interactive shell; installing openclaw-alicerealm plugin automatically..."
            Install-OpenClawPlugin -Spec $pluginSpec -AlreadyInstalled $pluginInstalled
            Ok "OpenClaw plugin installed"
            $pluginChanged = $true
        } else {
            $reply = Read-Host "OpenClaw detected. Install the openclaw-alicerealm plugin automatically? [Y/n]"
            if ($reply -match '^[nN]') {
                Info "Skipped OpenClaw plugin installation"
            } else {
                Info "Installing ${pluginSpec}..."
                Install-OpenClawPlugin -Spec $pluginSpec -AlreadyInstalled $pluginInstalled
                Ok "OpenClaw plugin installed"
                $pluginChanged = $true
            }
        }
    } else {
        Install-OpenClawPlugin -Spec $pluginSpec -AlreadyInstalled $pluginInstalled
        Ok "OpenClaw plugin aligned to ${pluginSpec}"
        $pluginChanged = $true
    }

    if ($pluginChanged -and $env:ALICEREALM_ALLOW_HOST_RESTART -eq "1") {
        Info "Restarting OpenClaw gateway..."
        try {
            & openclaw gateway restart 2>$null
            Ok "OpenClaw gateway restarted"
        } catch {
            Info "OpenClaw gateway restart failed; run 'openclaw gateway restart' manually"
        }
    }
}

function Setup-Notifications {
    $cli = $script:installedCliPath
    $homeDir = Resolve-EigenfluxHome -ExplicitHome $ExplicitEigenfluxHome -InvokingHost (Get-InvokingHost)
    Info "Registering Windows notifications without sending a test. Windows does not display an Allow permission dialog."
    & $cli --homedir $homeDir notify setup --source installer
    if ($LASTEXITCODE -ne 0) {
        throw "CLI is installed, but notification setup failed. Retry: & '$cli' --homedir '$homeDir' notify setup. If disabled, check Settings > System > Notifications."
    }
    & $cli --homedir $homeDir notify status
    if ($LASTEXITCODE -ne 0) { throw "CLI is installed, but notification status is not ready. Run notify status to inspect the error." }
    Ok "Windows notification registration is complete. Before the first real notification, status may be registered with an unknown OS setting. Use notify log for local observations."
}

# ── Main ──────────────────────────────────────────────────────

Install-Cli
Migrate-Config
Save-InstallReferral
Report-InstallAttribution
Install-Skills
Setup-Agents
$recordBin = $script:installedCliPath
$recordHost = Get-InvokingHost
& $recordBin --homedir $env:ALICEREALM_HOME installation record "--host=$recordHost" "--skills-target=$($script:installedSkillsTarget)" | Out-Null
if ($LASTEXITCODE -ne 0) { Info "Installation registration unavailable; record it with the new CLI before uninstalling." }
# Notification permission is independent of background order processing. Preserve
# the diagnostic, but always attempt outer-loop recovery even when setup fails.
$notificationSetupError = $null
try {
    Setup-Notifications
} catch {
    $notificationSetupError = $_.Exception.Message
    Info "Notifications need attention: $notificationSetupError"
}
$watchHome = Resolve-EigenfluxHome -ExplicitHome $ExplicitEigenfluxHome -InvokingHost (Get-InvokingHost)
if ($env:ALICEREALM_SKIP_AGENT_SETUP -ne '1') {
    & $script:installedCliPath watch recover --help *> $null
    if ($LASTEXITCODE -eq 0) {
        & $script:installedCliPath --homedir $watchHome watch recover
        if ($LASTEXITCODE -ne 0) { throw "CLI is installed, but outer-loop recovery is incomplete. Retry watch recover with the same Home." }
    } else {
        & $script:installedCliPath --homedir $watchHome watch start
        if ($LASTEXITCODE -ne 0) { throw "CLI is installed, but notification watch startup failed." }
    }
}
Info "Updated plugin files may require a host restart after current work finishes."

if ($notificationSetupError) {
    Info "CLI installation completed; notifications are not ready. $notificationSetupError"
}

Ok ""
if ([Console]::IsOutputRedirected) {
    Ok "Done! Check ar-onboarding skill to start Console V2 onboarding"
} else {
    Ok 'Done! Send this to your agents "Read ar-onboarding skill to help me join AliceRealm"'
}
