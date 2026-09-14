[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$PidFile,
    [switch]$Force,
    [switch]$AllowManagedBridgeConfig
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binary = [IO.Path]::GetFullPath((Join-Path $workspace 'deps\tunnel-client\v0.0.10-windows-amd64\tunnel-client.exe'))

function Convert-RuntimeStartTimeToUtc($value) {
    if ($null -eq $value) { throw 'Runtime metadata start time is missing' }
    if ($value -is [DateTimeOffset]) { return $value.ToUniversalTime() }
    if ($value -is [DateTime]) {
        $dateTime = [DateTime]$value
        if ($dateTime.Kind -eq [DateTimeKind]::Utc) { return [DateTimeOffset]::new($dateTime, [TimeSpan]::Zero) }
        if ($dateTime.Kind -eq [DateTimeKind]::Local) { return ([DateTimeOffset]$dateTime).ToUniversalTime() }
        return [DateTimeOffset]::new([DateTime]::SpecifyKind($dateTime, [DateTimeKind]::Utc), [TimeSpan]::Zero)
    }
    if ($value -is [string] -and $value) {
        return [DateTimeOffset]::Parse($value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    }
    throw 'Runtime metadata start time has an unsupported type'
}
if ([string]::IsNullOrWhiteSpace($PidFile)) {
    $PidFile = Join-Path $workspace 'deps\tunnel-client\run\tunnel-client.pid'
}
$pidPath = [IO.Path]::GetFullPath($PidFile)
$runtimePath = Join-Path (Split-Path -Parent $pidPath) 'tunnel-client.runtime.json'

if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    Write-Output 'NOT_RUN: no tunnel-client PID file.'
    exit 0
}

$pidValue = 0
if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$pidValue)) {
    throw "Invalid PID file: $pidPath"
}
$process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if (-not $process) {
    Remove-Item -LiteralPath $pidPath -Force
    if (Test-Path -LiteralPath $runtimePath -PathType Leaf) { Remove-Item -LiteralPath $runtimePath -Force }
    Write-Output "NOT_RUN: PID $pidValue was already stopped; no runtime lifecycle was observed."
    exit 0
}

$runtime = $null
if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
    throw "Refusing to stop PID ${pidValue}: runtime identity metadata is missing"
}
try { $runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json } catch { throw "Invalid runtime identity metadata: $runtimePath" }
if ([int]$runtime.pid -ne $pidValue) {
    throw "Refusing to stop PID ${pidValue}: runtime metadata belongs to PID $($runtime.pid)"
}
$recordedBinary = [IO.Path]::GetFullPath([string]$runtime.binary)
if ($recordedBinary -ne $binary) {
    throw "Refusing to stop PID ${pidValue}: runtime metadata executable is $recordedBinary"
}
if ([string]::IsNullOrWhiteSpace([string]$runtime.config)) {
    throw "Refusing to stop PID ${pidValue}: runtime metadata has no profile/config path"
}
$recordedConfig = [IO.Path]::GetFullPath([string]$runtime.config)
if (-not [string]::IsNullOrWhiteSpace([string]$runtime.profile) -and [IO.Path]::GetFullPath([string]$runtime.profile) -ne $recordedConfig) {
    throw "Refusing to stop PID ${pidValue}: runtime metadata profile does not match config"
}
$recordedBridgeConfig = if ([string]::IsNullOrWhiteSpace([string]$runtime.bridge_config)) { $null } else { [IO.Path]::GetFullPath([string]$runtime.bridge_config) }
if ($null -eq $recordedBridgeConfig -or -not [IO.Path]::IsPathFullyQualified($recordedBridgeConfig)) {
    throw "Refusing to stop PID ${pidValue}: bridge config identity is missing or not absolute"
}

$actualPath = $null
try { $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" } catch { throw "Refusing to stop PID ${pidValue}: process identity query failed" }
if (-not $processInfo) { throw "Refusing to stop PID ${pidValue}: process identity query returned no process" }
$actualPath = $processInfo.ExecutablePath
if (-not $actualPath) {
    throw "Refusing to stop PID ${pidValue}: executable path could not be verified"
}
if ($actualPath -and ([IO.Path]::GetFullPath($actualPath) -ne $binary)) {
    throw "Refusing to stop PID ${pidValue}: executable is $actualPath"
}
if ([string]::IsNullOrWhiteSpace([string]$processInfo.CommandLine) -or -not $processInfo.CommandLine.Contains($recordedConfig)) {
    throw "Refusing to stop PID ${pidValue}: command line does not match recorded profile/config"
}
try {
    $recordedStart = Convert-RuntimeStartTimeToUtc $runtime.start_time_utc
    $actualStart = [DateTimeOffset]$process.StartTime.ToUniversalTime()
} catch { throw "Refusing to stop PID ${pidValue}: start time could not be verified" }
if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 3) {
    throw "Refusing to stop PID ${pidValue}: start time does not match runtime metadata"
}

if (-not $PSCmdlet.ShouldProcess("tunnel-client PID $pidValue", 'stop process and remove runtime metadata')) {
    Write-Output "WHATIF: identity checks passed for tunnel-client PID $pidValue; process and metadata were left unchanged."
    exit 0
}
if ($Force) { Stop-Process -Id $pidValue -Force }
else { Stop-Process -Id $pidValue }
Wait-Process -Id $pidValue -Timeout 5 -ErrorAction SilentlyContinue
if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
    throw "PID $pidValue is still running; inspect it manually."
}
Remove-Item -LiteralPath $pidPath -Force
Remove-Item -LiteralPath $runtimePath -Force
Write-Output "STOP: terminated tunnel-client PID $pidValue after identity checks; child graceful lifecycle NOT_RUN."
