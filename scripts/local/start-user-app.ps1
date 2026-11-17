param(
    [int]$Port = 4181,
    [string]$AgentHome = "",
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$server = Join-Path $repoRoot "app\server.mjs"
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
    throw "AliceRealm App server is missing: $server"
}

if ([string]::IsNullOrWhiteSpace($AgentHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:ALICEREALM_HOME)) {
        $AgentHome = $env:ALICEREALM_HOME
    } else {
        $AgentHome = Join-Path $env:USERPROFILE ".alicerealm"
    }
}
$AgentHome = [System.IO.Path]::GetFullPath($AgentHome)
$appStateDir = Join-Path $AgentHome "app"
New-Item -ItemType Directory -Force -Path $appStateDir | Out-Null

$stateFile = Join-Path $appStateDir "bridge.json"
if (Test-Path -LiteralPath $stateFile) {
    try {
        $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $stateFile | ConvertFrom-Json
        if ($existing.pid -and (Get-Process -Id $existing.pid -ErrorAction SilentlyContinue)) {
            Write-Output "AliceRealm App is already running at $($existing.base_url)"
            if (-not $NoBrowser) { Write-Output "Use the existing App tab, or stop and start the App to open a new approval UI session." }
            exit 0
        }
    } catch {
        Write-Verbose "Ignoring stale bridge state: $($_.Exception.Message)"
    }
}

$env:APP_MODE = "desktop"
$env:APP_HOST = "127.0.0.1"
$env:APP_PORT = [string]$Port
$env:ALICEREALM_HOME = $AgentHome
$tokenBytes = New-Object byte[] 32
$tokenGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$tokenGenerator.GetBytes($tokenBytes)
$tokenGenerator.Dispose()
$uiToken = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$env:ALICEREALM_UI_TOKEN = $uiToken
if ([string]::IsNullOrWhiteSpace($env:ALICEREALM_API_ORIGIN)) {
    $env:ALICEREALM_API_ORIGIN = "https://alicerealm.com"
}

$stdout = Join-Path $appStateDir "server.stdout.log"
$stderr = Join-Path $appStateDir "server.stderr.log"
$process = Start-Process -FilePath "node" -ArgumentList @($server) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

$deadline = (Get-Date).AddSeconds(12)
$state = $null
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
        throw "AliceRealm App exited during startup. Inspect $stderr"
    }
    if (Test-Path -LiteralPath $stateFile) {
        try {
            $candidate = Get-Content -Raw -Encoding UTF8 -LiteralPath $stateFile | ConvertFrom-Json
            if ($candidate.pid -eq $process.Id -and $candidate.base_url) {
                $state = $candidate
                break
            }
        } catch {
            Write-Verbose "Waiting for complete bridge state"
        }
    }
    Start-Sleep -Milliseconds 200
}
if (-not $state) {
    throw "AliceRealm App did not publish bridge state. Inspect $stderr"
}

$uiURL = "$($state.base_url)/local/setup#ui_token=$uiToken"
Write-Output "AliceRealm App is running: $($state.base_url)"
if (-not $NoBrowser) { Start-Process $uiURL }
