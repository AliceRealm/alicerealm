param(
    [string]$AgentHome = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($AgentHome)) {
    if (-not [string]::IsNullOrWhiteSpace($env:ALICEREALM_HOME)) {
        $AgentHome = $env:ALICEREALM_HOME
    } else {
        $AgentHome = Join-Path $env:USERPROFILE ".alicerealm"
    }
}
$AgentHome = [System.IO.Path]::GetFullPath($AgentHome)
$stateFile = Join-Path $AgentHome "app\bridge.json"
if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
    Write-Output "AliceRealm App is not running for $AgentHome"
    exit 0
}

$state = Get-Content -Raw -Encoding UTF8 -LiteralPath $stateFile | ConvertFrom-Json
if (-not $state.pid) {
    throw "AliceRealm App bridge state has no process ID: $stateFile"
}
$process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
if (-not $process) {
    Write-Output "AliceRealm App process is already stopped."
    exit 0
}
if ($process.ProcessName -notin @("node", "nodejs")) {
    throw "Refusing to stop unexpected process $($process.ProcessName) with ID $($process.Id)"
}
Stop-Process -Id $process.Id
Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $stateFile) {
    Remove-Item -LiteralPath $stateFile -Force
}
Write-Output "AliceRealm App stopped."
