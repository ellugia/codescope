[CmdletBinding()]
param(
    [switch]$Start,
    [string]$ConfigPath,
    [string]$RunDirectory,
    [string]$NodePath,
    [switch]$AllowManagedBridgeConfig
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Start) {
    Write-Output 'BLOCKED: no se inicia ningún proceso por defecto. Revisa el perfil y repite con -Start cuando exista autorización.'
    exit 2
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    Write-Output 'BLOCKED: especifica -ConfigPath con un perfil privado revisado; el sample no se arranca directamente.'
    exit 2
}
if ([string]::IsNullOrWhiteSpace($env:CODESCOPE_CONFIG)) {
    Write-Output 'BLOCKED: CODESCOPE_CONFIG no está definido; se rechaza para evitar heredar otro perfil.'
    exit 2
}
if ([string]::IsNullOrWhiteSpace($RunDirectory)) {
    $RunDirectory = Join-Path $workspace 'deps\tunnel-client\run'
}

function Resolve-CodeScopeExecutablePath {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$Candidate
    )

    if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
        if (-not [IO.Path]::IsPathFullyQualified($Candidate)) { throw "$Name path must be absolute: $Candidate" }
        $resolved = [IO.Path]::GetFullPath($Candidate)
    } else {
        $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $resolved = if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace([string]$command.Path)) { [string]$command.Path } elseif ($null -ne $command) { [string]$command.Source } else { $null }
    }
    if ([string]::IsNullOrWhiteSpace($resolved) -or -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Required executable not found: $Name"
    }
    return [IO.Path]::GetFullPath($resolved)
}

$binary = Join-Path $workspace 'deps\tunnel-client\v0.0.10-windows-amd64\tunnel-client.exe'
$config = [IO.Path]::GetFullPath($ConfigPath)
$bridgeConfig = [IO.Path]::GetFullPath($env:CODESCOPE_CONFIG)
$run = [IO.Path]::GetFullPath($RunDirectory)
$nodePath = Resolve-CodeScopeExecutablePath -Name 'node.exe' -Candidate $(if ([string]::IsNullOrWhiteSpace($NodePath)) { $env:CODESCOPE_NODE_PATH } else { $NodePath })
$nodeDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $nodePath))
$gitPath = Resolve-CodeScopeExecutablePath -Name 'git.exe'
$gitDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $gitPath))
$pidFile = Join-Path $run 'tunnel-client.pid'
$runtimeFile = Join-Path $run 'tunnel-client.runtime.json'
$healthFile = Join-Path $run 'health.url'
$sampleConfig = [IO.Path]::GetFullPath((Join-Path $workspace 'deps\tunnel-client\tunnel-client.sample.yaml'))

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Portable tunnel-client not found: $binary" }
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "Config not found: $config" }
if ($config -eq $sampleConfig) {
    Write-Output 'BLOCKED: no se arranca el sample; copia el YAML a una ruta privada y usa -ConfigPath.'
    exit 2
}
if (-not (Test-Path -LiteralPath $bridgeConfig -PathType Leaf)) {
    Write-Output "BLOCKED: CODESCOPE_CONFIG no apunta a un archivo de configuración existente: $bridgeConfig"
    exit 2
}
$pathEntries = @([Environment]::SystemDirectory, $nodeDirectory, $gitDirectory) | Select-Object -Unique
foreach ($pathEntry in $pathEntries) {
    if (-not (Test-Path -LiteralPath $pathEntry -PathType Container)) { throw "Required runtime PATH directory not found: $pathEntry" }
}
$pathSafety = @($pathEntries | ForEach-Object {
    $entry = $_
    [pscustomobject]@{
        directory = $entry
        codex_exe = Test-Path -LiteralPath (Join-Path $entry 'codex.exe') -PathType Leaf
        codex_cmd = Test-Path -LiteralPath (Join-Path $entry 'codex.cmd') -PathType Leaf
        codex_ps1 = Test-Path -LiteralPath (Join-Path $entry 'codex.ps1') -PathType Leaf
    }
})
if (@($pathSafety | Where-Object { $_.codex_exe -or $_.codex_cmd -or $_.codex_ps1 }).Count -gt 0) {
    throw 'Refusing start: isolated runtime PATH contains a Codex shim.'
}
$null = & $binary doctor --config $config --json --health.listen-addr '127.0.0.1:0' 2>$null
$doctorExit = $LASTEXITCODE
if ($doctorExit -ne 0) {
    Write-Output "BLOCKED: tunnel-client doctor rechazó el perfil (exit $doctorExit); corrige la configuración antes de arrancar."
    exit 2
}
New-Item -ItemType Directory -Force -Path $run | Out-Null

if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $oldPid = 0
    if ([int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$oldPid)) {
        $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($old) { throw "A tunnel-client process is already recorded at PID $oldPid" }
    }
    Remove-Item -LiteralPath $pidFile -Force
}
if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
    try { $oldRecord = Get-Content -Raw -LiteralPath $runtimeFile | ConvertFrom-Json } catch { throw "Invalid runtime metadata: $runtimeFile" }
    $recordPid = 0
    if ([int]::TryParse([string]$oldRecord.pid, [ref]$recordPid)) {
        if (Get-Process -Id $recordPid -ErrorAction SilentlyContinue) {
            throw "A tunnel-client process is already recorded at PID $recordPid"
        }
    }
    Remove-Item -LiteralPath $runtimeFile -Force
}
if (Test-Path -LiteralPath $healthFile -PathType Leaf) {
    Remove-Item -LiteralPath $healthFile -Force
}

$arguments = @(
    'run', '--config', $config,
    '--health.listen-addr', '127.0.0.1:0',
    '--health.url-file', $healthFile,
    '--pid.file', $pidFile
)
$binaryPath = [IO.Path]::GetFullPath($binary)
# ponytail: use NUL handles instead of inherited pipes; the tunnel is resident
# and must not keep the one-shot PowerShell launcher open after this script exits.
$argumentString = 'run --config "{0}" --health.listen-addr 127.0.0.1:0 --health.url-file "{1}" --pid.file "{2}"' -f $config, $healthFile, $pidFile
$nullOutput = 'NUL'
$nullError = '\\.\NUL'
$process = Start-Process -FilePath $binaryPath -ArgumentList $argumentString -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $nullOutput -RedirectStandardError $nullError -PassThru
if ($null -eq $process) { throw 'tunnel-client process did not start' }
try {
    $started = Get-Process -Id $process.Id -ErrorAction Stop
    $startTimeUtc = $started.StartTime.ToUniversalTime().ToString('o')
} catch {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Started PID $($process.Id) but could not record its start time; process was stopped."
}
[ordered]@{
    schema_version = 1
    pid = $process.Id
    start_time_utc = $startTimeUtc
    binary = $binaryPath
    profile = $config
    config = $config
    bridge_config = $bridgeConfig
    arguments = $arguments
    path_entries = $pathEntries
    path_isolation = 'inherited environment with PATH and CODESCOPE_CONFIG overrides'
    runtime_key_environment = 'inherited process-only; never persisted'
    pid_file = $pidFile
    health_url_file = $healthFile
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $runtimeFile
[pscustomobject]@{
    status = 'START_REQUESTED'
    pid = $process.Id
    binary = $binary
    profile = $config
    config = $config
    bridgeConfig = $bridgeConfig
    pathEntries = $pathEntries
    healthUrlFile = $healthFile
    runtimeMetadata = $runtimeFile
    lifecycle = 'NOT_RUN: health/readiness and child graceful shutdown are not checked here'
    stop = "powershell -File scripts/tunnel-stop.ps1 -PidFile `"$pidFile`""
} | ConvertTo-Json -Compress
