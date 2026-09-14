[CmdletBinding()]
param(
    [switch]$Start,
    [Alias('Health')]
    [switch]$Once,
    [ValidateRange(1, 30)]
    [int]$HealthTimeoutSeconds = 5
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$managedRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'config\managed'))
$managedProfile = Join-Path $managedRoot 'profile.json'
$runtimeConfig = Join-Path $managedRoot 'runtime.bridge.json'
$controlScript = Join-Path $PSScriptRoot 'codescope-control.ps1'
$helperScript = Join-Path $PSScriptRoot 'tunnel-launcher-functions.ps1'
$client = Join-Path $workspace 'deps\tunnel-client\v0.0.10-windows-amd64\tunnel-client.exe'
$runDirectory = Join-Path $workspace 'deps\tunnel-client\run'
$profileDirectory = Join-Path $runDirectory 'profiles'
$profileYaml = Join-Path $profileDirectory 'codescope.yaml'
if (-not (Test-Path -LiteralPath $profileYaml -PathType Leaf) -and (Test-Path -LiteralPath $profileDirectory -PathType Container)) {
    $candidate = Get-ChildItem -LiteralPath $profileDirectory -Filter 'codescope*.yaml' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($null -ne $candidate) { $profileYaml = [IO.Path]::GetFullPath($candidate.FullName) }
}
$pidFile = Join-Path $runDirectory 'tunnel-client.pid'
$runtimeFile = Join-Path $runDirectory 'tunnel-client.runtime.json'
$healthFile = Join-Path $runDirectory 'health.url'

function Resolve-CodeScopePowerShell {
    $current = Join-Path $PSHOME 'pwsh.exe'
    if ($PSVersionTable.PSVersion.Major -ge 7 -and (Test-Path -LiteralPath $current -PathType Leaf)) {
        return [IO.Path]::GetFullPath($current)
    }
    $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace([string]$command.Source)) {
        throw 'PowerShell 7 no está disponible; instala pwsh.exe para iniciar CodeScope.'
    }
    return [IO.Path]::GetFullPath([string]$command.Source)
}

function Get-CodeScopeTunnelId {
    $profileText = Get-Content -Raw -LiteralPath $profileYaml
    $pattern = '(?m)^\s*tunnel_id:\s*["'']?(tunnel_[a-z0-9]{32})["'']?\s*$'
    if ($profileText -notmatch $pattern) { throw "El perfil del cliente no contiene un tunnel_id válido: $profileYaml" }
    return [string]$Matches[1]
}

function Invoke-CodeScopeControl {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string]$PowerShellPath
    )

    $suffix = [Guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) "codescope-control-$PID-$suffix.out"
    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) "codescope-control-$PID-$suffix.err"
    $quote = { param([string]$Value) '"{0}"' -f $Value.Replace('"', '\"') }
    $argumentList = @(
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (& $quote $controlScript),
        '-Operation', $Operation,
        '-ProfilePath', (& $quote $managedProfile),
        '-Json'
    )
    $process = $null
    $timedOut = $false
    try {
        $process = Start-Process -FilePath $PowerShellPath -ArgumentList $argumentList -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        $timedOut = -not $process.WaitForExit(60000)
        if ($timedOut) {
            try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
            try { $process.WaitForExit(5000) | Out-Null } catch { }
        }
        $lines = @()
        foreach ($path in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) { $lines += @(Get-Content -LiteralPath $path | ForEach-Object { [string]$_ }) }
        }
        $exitCode = if ($timedOut) { 124 } elseif ($process.HasExited) { [int]$process.ExitCode } else { 1 }
        $body = $null
        $text = ($lines -join "`n").Trim()
        if ($text) {
            try { $body = $text | ConvertFrom-Json } catch { }
        }
        [pscustomobject]@{
            exit_code = $exitCode
            timed_out = $timedOut
            body = $body
            json = [bool]($null -ne $body)
        }
    } finally {
        if ($null -ne $process) { $process.Dispose() }
        foreach ($path in @($stdoutPath, $stderrPath)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
}

function Get-CodeScopeActiveSummary {
    param([Parameter(Mandatory = $true)]$State)

    [ordered]@{
        status = [string]$State.status
        active = [bool]$State.active
        pid = $State.pid
        reason = [string]$State.reason
        error_code = $State.error_code
        binary = $State.binary
        profile = $State.profile
        config = $State.config
    }
}

function Invoke-CodeScopeLoopbackHealth {
    param([Parameter(Mandatory = $true)][int]$TimeoutSeconds)

    $notReady = [ordered]@{ status = 'NOT_RUN'; local_only = $true; base_url = $null; healthz_status = $null; readyz_status = $null; error_code = 'NO_ACTIVE_INSTANCE' }
    if (-not (Test-Path -LiteralPath $healthFile -PathType Leaf)) { return $notReady }
    $baseText = (Get-Content -Raw -LiteralPath $healthFile).Trim()
    if ([string]::IsNullOrWhiteSpace($baseText)) { return [ordered]@{ status = 'FAIL'; local_only = $true; base_url = $null; error_code = 'HEALTH_URL_EMPTY' } }

    try {
        $baseUri = [Uri]::new($baseText.TrimEnd('/'))
        if (-not $baseUri.IsLoopback -or $baseUri.Scheme -ne 'http') { throw 'health URL is not loopback HTTP' }
    } catch {
        return [ordered]@{ status = 'FAIL'; local_only = $true; base_url = $baseText; error_code = 'HEALTH_URL_NOT_LOOPBACK' }
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $healthzStatus = $null
    $readyzStatus = $null
    $errorCode = 'LOCAL_HEALTH_UNREACHABLE'
    do {
        try {
            $healthz = Invoke-WebRequest -Uri ([Uri]::new($baseUri, '/healthz')) -Method Get -TimeoutSec 1 -UseBasicParsing
            $readyz = Invoke-WebRequest -Uri ([Uri]::new($baseUri, '/readyz')) -Method Get -TimeoutSec 1 -UseBasicParsing
            $healthzStatus = [int]$healthz.StatusCode
            $readyzStatus = [int]$readyz.StatusCode
            if ($healthzStatus -eq 200 -and $readyzStatus -eq 200) {
                return [ordered]@{ status = 'PASS'; local_only = $true; base_url = $baseText; healthz_status = $healthzStatus; readyz_status = $readyzStatus; error_code = $null }
            }
            $errorCode = 'LOCAL_HEALTH_STATUS'
        } catch { }
        if ([DateTimeOffset]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    [ordered]@{ status = 'FAIL'; local_only = $true; base_url = $baseText; healthz_status = $healthzStatus; readyz_status = $readyzStatus; error_code = $errorCode }
}

function Write-CodeScopeResult {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][int]$ExitCode
    )

    $healthStatus = if ($null -ne $Result.health) { [string]$Result.health.status } else { 'NOT_RUN' }
    Write-Host ("CodeScope: {0}; acción={1}; ciclo={2}; salud_local={3}" -f $Result.status, $Result.action, $Result.lifecycle, $healthStatus)
    Write-Output ($Result | ConvertTo-Json -Depth 12 -Compress)
    if ($ExitCode -ne 0) { exit $ExitCode }
}

$result = $null
$exitCode = 2
$environmentState = $null
$secret = $null
try {
    if ($Start -and $Once) { throw 'Usa -Start o -Once, no ambos.' }
    if (-not $Start -and -not $Once) { throw 'Especifica -Start para iniciar o -Once (alias -Health) para una comprobación breve.' }
    foreach ($path in @($managedProfile, $controlScript, $helperScript, $client, $profileYaml)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Entrada local no encontrada: $path" }
    }

    . $helperScript
    $pwsh = Resolve-CodeScopePowerShell
    $list = Invoke-CodeScopeControl -Operation 'list' -PowerShellPath $pwsh
    if ($list.exit_code -ne 0 -or -not $list.json -or [string]$list.body.status -ne 'PASS') {
        throw 'El perfil persistente de CodeScope no pudo validarse.'
    }

    $tunnelId = Get-CodeScopeTunnelId
    $activeState = Get-CodeScopeActiveProcessState -PidFile $pidFile -RuntimeFile $runtimeFile -ExpectedBinary $client -ExpectedProfile $profileYaml -ExpectedBridgeConfig $runtimeConfig -ProfilePath $profileYaml -TunnelId $tunnelId
    $activeSummary = Get-CodeScopeActiveSummary -State $activeState
    $health = if ($activeState.active -and $activeState.status -eq 'PASS') { Invoke-CodeScopeLoopbackHealth -TimeoutSeconds $HealthTimeoutSeconds } else { [ordered]@{ status = 'NOT_RUN'; local_only = $true; base_url = $null; healthz_status = $null; readyz_status = $null; error_code = if ($activeState.active) { 'ACTIVE_PROCESS_UNVERIFIED' } else { 'NO_ACTIVE_INSTANCE' } } }

    if ($Once) {
        if ($activeState.active -and $activeState.status -ne 'PASS') {
            $result = [ordered]@{ status = 'BLOCKED'; mode = 'once'; action = 'NOT_STARTED'; lifecycle = 'UNVERIFIED'; profile = $managedProfile; bridge_config = $runtimeConfig; active = $activeSummary; health = $health; error_code = 'ACTIVE_PROCESS_UNVERIFIED' }
            $exitCode = 2
        } elseif ($activeState.active -and $health.status -ne 'PASS') {
            $result = [ordered]@{ status = 'BLOCKED'; mode = 'once'; action = 'NOT_STARTED'; lifecycle = 'UNHEALTHY'; profile = $managedProfile; bridge_config = $runtimeConfig; active = $activeSummary; health = $health; error_code = 'LOCAL_HEALTH_FAILED' }
            $exitCode = 2
        } else {
            $result = [ordered]@{ status = 'PASS'; mode = 'once'; action = 'NOT_STARTED'; lifecycle = if ($activeState.active) { 'RUNNING' } else { 'STOPPED' }; profile = $managedProfile; bridge_config = $runtimeConfig; active = $activeSummary; health = $health; error_code = $null }
            $exitCode = 0
        }
    } elseif ($activeState.active) {
        if ($activeState.status -ne 'PASS') {
            $result = [ordered]@{ status = 'BLOCKED'; mode = 'start'; action = 'NOT_STARTED'; lifecycle = 'UNVERIFIED'; profile = $managedProfile; bridge_config = $runtimeConfig; active = $activeSummary; health = $health; error_code = 'ACTIVE_PROCESS_UNVERIFIED' }
            $exitCode = 2
        } elseif ($health.status -eq 'PASS') {
            $result = [ordered]@{ status = 'PASS'; mode = 'start'; action = 'ALREADY_HEALTHY'; lifecycle = 'RUNNING'; profile = $managedProfile; bridge_config = $runtimeConfig; active = $activeSummary; health = $health; error_code = $null }
            $exitCode = 0
        } else {
            $result = [ordered]@{ status = 'BLOCKED'; mode = 'start'; action = 'NOT_STARTED'; lifecycle = 'UNHEALTHY'; profile = $managedProfile; bridge_config = $runtimeConfig; active = $activeSummary; health = $health; error_code = 'LOCAL_HEALTH_FAILED' }
            $exitCode = 2
        }
    } else {
        $environmentState = Get-CodeScopeEnvironmentState -Name 'CODESCOPE_TUNNEL_RUNTIME_KEY'
        $keyResolution = Resolve-CodeScopeRuntimeKey
        $secret = $keyResolution.Value
        Set-CodeScopeEnvironmentVariable -Name 'CODESCOPE_TUNNEL_RUNTIME_KEY' -Value $secret
        $started = Invoke-CodeScopeControl -Operation 'stack.start' -PowerShellPath $pwsh
        if ($started.exit_code -ne 0 -or -not $started.json -or [string]$started.body.status -ne 'PASS') {
            $result = [ordered]@{ status = 'BLOCKED'; mode = 'start'; action = 'NOT_STARTED'; lifecycle = 'STOPPED'; profile = $managedProfile; bridge_config = $runtimeConfig; active = $activeSummary; health = $health; error_code = if ($started.body.error_code) { [string]$started.body.error_code } else { 'STACK_START_FAILED' } }
            $exitCode = 2
        } else {
            $activeState = Get-CodeScopeActiveProcessState -PidFile $pidFile -RuntimeFile $runtimeFile -ExpectedBinary $client -ExpectedProfile $profileYaml -ExpectedBridgeConfig $runtimeConfig -ProfilePath $profileYaml -TunnelId $tunnelId
            $activeSummary = Get-CodeScopeActiveSummary -State $activeState
            $health = if ($activeState.active -and $activeState.status -eq 'PASS') { Invoke-CodeScopeLoopbackHealth -TimeoutSeconds $HealthTimeoutSeconds } else { [ordered]@{ status = 'FAIL'; local_only = $true; base_url = $null; healthz_status = $null; readyz_status = $null; error_code = 'LOCAL_PROCESS_NOT_READY' } }
            $healthy = $activeState.active -and $activeState.status -eq 'PASS' -and $health.status -eq 'PASS'
            $result = [ordered]@{ status = if ($healthy) { 'PASS' } else { 'BLOCKED' }; mode = 'start'; action = 'STARTED'; lifecycle = if ($activeState.active) { 'RUNNING' } else { 'STOPPED' }; profile = $managedProfile; bridge_config = $runtimeConfig; active = $activeSummary; health = $health; error_code = if ($healthy) { $null } else { 'LOCAL_HEALTH_FAILED' } }
            $exitCode = if ($healthy) { 0 } else { 2 }
        }
    }
} catch {
    $result = [ordered]@{ status = 'BLOCKED'; mode = if ($Once) { 'once' } else { 'start' }; action = 'NOT_STARTED'; lifecycle = 'UNKNOWN'; profile = $managedProfile; bridge_config = $runtimeConfig; active = $null; health = [ordered]@{ status = 'NOT_RUN'; local_only = $true; error_code = 'NOT_RUN' }; error_code = 'LAUNCHER_FAILED'; message = [string]$_.Exception.Message }
    $exitCode = 2
} finally {
    if ($null -ne $environmentState) { Restore-CodeScopeEnvironmentState -State $environmentState }
    $secret = $null
}

Write-CodeScopeResult -Result $result -ExitCode $exitCode
