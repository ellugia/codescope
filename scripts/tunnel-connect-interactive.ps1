[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^tunnel_[a-z0-9]{32}$')]
    [string]$TunnelId,
    [string]$ProfileDir,
    [string]$RunDirectory,
    [string]$NodePath,
    [string]$PowerShellPath,
    [string]$BridgeConfigPath,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'tunnel-runtime.ps1')

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

if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = $env:CODESCOPE_NODE_PATH }
if ([string]::IsNullOrWhiteSpace($PowerShellPath)) { $PowerShellPath = $env:CODESCOPE_PWSH_PATH }
$node = Resolve-CodeScopeExecutablePath -Name 'node.exe' -Candidate $NodePath
if ([string]::IsNullOrWhiteSpace($PowerShellPath)) {
    $currentPowerShell = Join-Path $PSHOME 'pwsh.exe'
    $PowerShellPath = if ($PSVersionTable.PSVersion.Major -ge 7 -and (Test-Path -LiteralPath $currentPowerShell -PathType Leaf)) { $currentPowerShell } else { $null }
}
$pwsh = Resolve-CodeScopeExecutablePath -Name 'pwsh.exe' -Candidate $PowerShellPath
$client = Resolve-CodeScopeTunnelClient -Workspace $workspace
if ([string]::IsNullOrWhiteSpace($BridgeConfigPath)) { $BridgeConfigPath = $env:CODESCOPE_CONFIG }
if ([string]::IsNullOrWhiteSpace($BridgeConfigPath)) { $BridgeConfigPath = Join-Path $workspace 'config.json' }
if (-not [IO.Path]::IsPathFullyQualified($BridgeConfigPath)) { throw "Bridge configuration path must be absolute: $BridgeConfigPath" }
$bridgeConfig = [IO.Path]::GetFullPath($BridgeConfigPath)
$mcpCommand = "$(($node -replace '\\','/')) $(($workspace -replace '\\','/'))/src/server.mjs"
$helperScript = Join-Path $PSScriptRoot 'tunnel-launcher-functions.ps1'
$doctorScript = Join-Path $PSScriptRoot 'tunnel-doctor.ps1'
$startScript = Join-Path $PSScriptRoot 'tunnel-start.ps1'
$stopScript = Join-Path $PSScriptRoot 'tunnel-stop.ps1'

if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    $ProfileDir = Join-Path (Resolve-CodeScopeTunnelRunDirectory -Workspace $workspace -ClientPath $client) 'profiles'
}
if ([string]::IsNullOrWhiteSpace($RunDirectory)) {
    $RunDirectory = Resolve-CodeScopeTunnelRunDirectory -Workspace $workspace -ClientPath $client
}
$ProfileDir = [IO.Path]::GetFullPath($ProfileDir)
$RunDirectory = [IO.Path]::GetFullPath($RunDirectory)
$profileName = 'codescope'
$profilePath = Join-Path $ProfileDir "$profileName.yaml"
$healthFile = Join-Path $RunDirectory 'health.url'
$pidFile = Join-Path $RunDirectory 'tunnel-client.pid'
$runtimeFile = Join-Path $RunDirectory 'tunnel-client.runtime.json'
$connectResultPath = Join-Path $RunDirectory 'connect-result.json'
$attemptStartedUtc = (Get-Date).ToUniversalTime().ToString('o')
$attemptId = '{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ'), $PID
$attemptsDirectory = Join-Path $RunDirectory 'connect-attempts'
$attemptReceiptPath = Join-Path $attemptsDirectory "connect-result-$attemptId.json"
$restartReceiptPath = Join-Path $attemptsDirectory "restart-request-$attemptId.json"
$historicalConnectResult = [ordered]@{
    path = $connectResultPath
    present = Test-Path -LiteralPath $connectResultPath -PathType Leaf
    sha256 = if (Test-Path -LiteralPath $connectResultPath -PathType Leaf) { (Get-FileHash -Algorithm SHA256 -LiteralPath $connectResultPath).Hash.ToLowerInvariant() } else { $null }
    preserved = $true
}

. $helperScript
$runtimeKeyEnvironmentState = Get-CodeScopeEnvironmentState -Name 'CODESCOPE_TUNNEL_RUNTIME_KEY'
$configEnvironmentState = Get-CodeScopeEnvironmentState -Name 'CODESCOPE_CONFIG'

foreach ($path in @($client, $node, $pwsh, $bridgeConfig, $helperScript, $doctorScript, $startScript, $stopScript)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required local input not found: $path"
    }
}

$result = $null
$stage = 'setup'
$restartAdminPreflight = $null
$secret = $null
$keyResolution = $null
$activeProcess = [pscustomobject]@{ status = 'NOT_RUN'; active = $false; reason = 'NOT_RUN'; error_code = $null; pid = $null }
$activeHealth = [pscustomobject]@{ status = 'NOT_RUN'; error_code = 'NOT_RUN' }
$currentProcess = [pscustomobject]@{ status = 'NOT_RUN'; active = $false; reason = 'NOT_RUN'; error_code = $null; pid = $null }
$currentHealth = [pscustomobject]@{ status = 'NOT_RUN'; error_code = 'NOT_RUN' }
$environmentRestored = $false
Set-CodeScopeEnvironmentVariable -Name 'CODESCOPE_CONFIG' -Value $bridgeConfig
try {
    New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    New-Item -ItemType Directory -Force -Path $RunDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path $attemptsDirectory | Out-Null

    $stage = 'verify'
    $null = & $pwsh -NoProfile -ExecutionPolicy Bypass -File $PSScriptRoot\tunnel-verify.ps1 2>$null
    if ($LASTEXITCODE -ne 0) {
        $result = [ordered]@{ status = 'BLOCKED'; phase = 'verify'; stage = 'verify'; daemon = 'NOT_STARTED'; error_code = 'VERIFY_FAILED'; exit_code = [int]$LASTEXITCODE }
    }

    if ($null -eq $result) {
        $stage = 'active_probe'
        $activeProcess = Get-CodeScopeActiveProcessState -PidFile $pidFile -RuntimeFile $runtimeFile -ExpectedBinary $client -ExpectedProfile $profilePath -ExpectedBridgeConfig $bridgeConfig -ProfilePath $profilePath -TunnelId $TunnelId
        if ($activeProcess.active -and -not $Restart -and $activeProcess.status -ne 'PASS') {
            $result = [ordered]@{ status = 'BLOCKED'; phase = 'active_probe'; stage = 'active_probe'; daemon = 'ACTIVE_UNVERIFIED'; pid = $activeProcess.pid; preexisting_process = $activeProcess; key_source = 'NOT_NEEDED'; error_code = 'ACTIVE_PROCESS_UNVERIFIED'; exit_code = $null }
        } elseif ($activeProcess.active -and $activeProcess.status -eq 'PASS') {
            $stage = 'active_health'
            if (Test-Path -LiteralPath $healthFile -PathType Leaf) {
                $activeHealth = Invoke-CodeScopeHealthProbe -ClientPath $client -PidFile $pidFile -HealthFile $healthFile -WorkingDirectory $workspace -TimeoutSeconds 1
            } else {
                $activeHealth = [pscustomobject]@{ status = 'FAIL'; error_code = 'HEALTH_URL_MISSING' }
            }
            if (-not $Restart -and (Test-CodeScopeHealthyInstance -ActiveProcess $activeProcess -Health $activeHealth)) {
                $result = [ordered]@{ status = 'ALREADY_HEALTHY'; daemon = 'ACTIVE_REUSED'; phase = 'active_health'; stage = 'active_health'; pid = $activeProcess.pid; health = $activeHealth.base_url; health_checks = $activeHealth; preexisting_process = $activeProcess; key_source = 'NOT_NEEDED'; error_code = $null; exit_code = 0 }
            } elseif (-not $Restart) {
                $result = [ordered]@{ status = 'BLOCKED'; daemon = 'ACTIVE_UNHEALTHY'; phase = 'active_health'; stage = 'active_health'; pid = $activeProcess.pid; health = if ($activeHealth.base_url) { $activeHealth.base_url } else { 'NOT_READY' }; health_checks = $activeHealth; preexisting_process = $activeProcess; key_source = 'NOT_NEEDED'; error_code = 'ACTIVE_UNHEALTHY'; exit_code = $null }
            }
        }
    }

    if ($null -eq $result) {
        $stage = 'profile_check'
        $reuseProfile = $false
        if (Test-Path -LiteralPath $profilePath -PathType Leaf) {
            $existingProfile = Get-Content -Raw -LiteralPath $profilePath
            $escapedTunnelId = [Regex]::Escape($TunnelId)
            $escapedMcpCommand = [Regex]::Escape($mcpCommand)
            $sameTunnel = $existingProfile -match ('(?m)^\s*tunnel_id:\s*["'']?' + $escapedTunnelId + '["'']?\s*$')
            $sameCommand = $existingProfile -match ('(?m)^\s*command:\s*["'']?' + $escapedMcpCommand + '["'']?\s*$')
            $sameKeyReference = $existingProfile -match '(?m)^\s*api_key:\s*["'']?env:CODESCOPE_TUNNEL_RUNTIME_KEY["'']?\s*$'
            if ($sameTunnel -and $sameCommand -and $sameKeyReference) {
                $reuseProfile = $true
            } else {
                $result = [ordered]@{ status = 'BLOCKED'; phase = 'profile_conflict'; stage = 'profile_check'; daemon = 'NOT_STARTED'; error_code = 'PROFILE_CONFLICT'; exit_code = $null }
            }
        }

        if ($null -eq $result -and -not $reuseProfile) {
            $stage = 'init'
            $null = & $client init --profile-dir $ProfileDir --profile $profileName --sample sample_mcp_stdio_local --tunnel-id $TunnelId --control-plane-api-key-ref 'env:CODESCOPE_TUNNEL_RUNTIME_KEY' --mcp-command $mcpCommand --health-listen-addr '127.0.0.1:0' 2>$null
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
                $result = [ordered]@{ status = 'BLOCKED'; phase = 'init'; stage = 'init'; daemon = 'NOT_STARTED'; error_code = 'INIT_FAILED'; exit_code = [int]$LASTEXITCODE }
            }
        }

        if ($null -eq $result) {
            $stage = 'profile_contract'
            $profileLines = @(Get-Content -LiteralPath $profilePath)
            $apiKeyIndex = -1
            $maxInflightIndex = -1
            for ($index = 0; $index -lt $profileLines.Count; $index += 1) {
                if ($apiKeyIndex -lt 0 -and $profileLines[$index] -match '^\s*api_key:\s*') { $apiKeyIndex = $index }
                if ($maxInflightIndex -lt 0 -and $profileLines[$index] -match '^\s*max_inflight_requests:\s*') { $maxInflightIndex = $index }
            }
            if ($apiKeyIndex -lt 0) {
                $result = [ordered]@{ status = 'BLOCKED'; phase = 'profile_contract'; stage = 'profile_contract'; daemon = 'NOT_STARTED'; error_code = 'PROFILE_CONTRACT'; exit_code = $null }
            } elseif ($maxInflightIndex -ge 0) {
                if ($profileLines[$maxInflightIndex] -notmatch '^\s*max_inflight_requests:\s*1\s*$') {
                    $profileLines[$maxInflightIndex] = '  max_inflight_requests: 1'
                    Set-Content -LiteralPath $profilePath -Value $profileLines -Encoding UTF8
                }
            } else {
                $updatedLines = @()
                $updatedLines += $profileLines[0..$apiKeyIndex]
                $updatedLines += '  max_inflight_requests: 1'
                if ($apiKeyIndex + 1 -lt $profileLines.Count) { $updatedLines += $profileLines[($apiKeyIndex + 1)..($profileLines.Count - 1)] }
                Set-Content -LiteralPath $profilePath -Value $updatedLines -Encoding UTF8
            }
        }
    }

    if ($null -eq $result) {
        $stage = 'credential_prompt'
        if ($Restart) {
            [ordered]@{
                schema_version = 1
                status = 'WAITING_FOR_CREDENTIAL'
                phase = 'credential_prompt'
                stage = 'credential_prompt'
                timestamp_utc = $attemptStartedUtc
                attempt_id = $attemptId
                launcher_pid = $PID
                historical_connect_result = $historicalConnectResult
            } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $restartReceiptPath -Encoding UTF8
        }
        $keyResolution = Resolve-CodeScopeRuntimeKey
        $secret = $keyResolution.Value
        Set-CodeScopeEnvironmentVariable -Name 'CODESCOPE_TUNNEL_RUNTIME_KEY' -Value $secret

        $stage = 'doctor'
        $null = & $pwsh -NoProfile -ExecutionPolicy Bypass -File $doctorScript -ConfigPath $profilePath 2>$null
        if ($LASTEXITCODE -ne 0) {
            $result = [ordered]@{ status = 'BLOCKED'; phase = 'doctor'; stage = 'doctor'; daemon = 'NOT_STARTED'; error_code = 'DOCTOR_REJECTED'; exit_code = [int]$LASTEXITCODE }
        }
    }

    if ($null -eq $result -and $Restart) {
        $stage = 'restart_stop'
        if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
            $result = [ordered]@{ status = 'BLOCKED'; phase = 'restart_stop'; stage = 'restart_stop'; daemon = 'NOT_STARTED'; error_code = 'NO_ACTIVE_INSTANCE'; exit_code = $null }
        } else {
            $restartPid = 0
            if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$restartPid)) {
                $result = [ordered]@{ status = 'BLOCKED'; phase = 'restart_stop'; stage = 'restart_stop'; daemon = 'NOT_STARTED'; error_code = 'INVALID_PID_FILE'; exit_code = $null }
            } elseif (-not (Get-Process -Id $restartPid -ErrorAction SilentlyContinue)) {
                $result = [ordered]@{ status = 'BLOCKED'; phase = 'restart_stop'; stage = 'restart_stop'; daemon = 'NOT_STARTED'; error_code = 'NO_ACTIVE_INSTANCE'; exit_code = $null }
            } else {
                $adminArgs = @('admin', '--json', '--control-plane.base-url', 'https://api.openai.com', 'tunnels', 'get', $TunnelId)
                $adminPsi = [Diagnostics.ProcessStartInfo]::new()
                $adminPsi.FileName = [IO.Path]::GetFullPath($client)
                $adminPsi.WorkingDirectory = $workspace
                $adminPsi.UseShellExecute = $false
                $adminPsi.CreateNoWindow = $true
                $adminPsi.RedirectStandardOutput = $true
                $adminPsi.RedirectStandardError = $true
                $adminPsi.Environment['CONTROL_PLANE_API_KEY'] = [string]$env:CODESCOPE_TUNNEL_RUNTIME_KEY
                [void]$adminPsi.Environment.Remove('OPENAI_ADMIN_KEY')
                [void]$adminPsi.Environment.Remove('OPENAI_API_KEY')
                foreach ($argument in $adminArgs) { [void]$adminPsi.ArgumentList.Add([string]$argument) }
                $adminProcess = [Diagnostics.Process]::new()
                $adminProcess.StartInfo = $adminPsi
                $adminExit = $null
                $adminTimedOut = $false
                $adminJsonValid = $false
                $adminData = $null
                $adminStdout = ''
                try {
                    if (-not $adminProcess.Start()) { throw 'admin lookup process did not start' }
                    $adminStdoutTask = $adminProcess.StandardOutput.ReadToEndAsync()
                    $adminStderrTask = $adminProcess.StandardError.ReadToEndAsync()
                    if (-not $adminProcess.WaitForExit(10000)) {
                        $adminTimedOut = $true
                        try { $adminProcess.Kill() } catch { }
                        try { $adminProcess.WaitForExit(5000) | Out-Null } catch { }
                    }
                    $adminProcess.Refresh()
                    if ($adminProcess.HasExited) { $adminExit = [int]$adminProcess.ExitCode }
                    $adminStdout = $adminStdoutTask.GetAwaiter().GetResult()
                    $null = $adminStderrTask.GetAwaiter().GetResult()
                    if (-not $adminTimedOut -and $adminExit -eq 0) {
                        try { $adminData = $adminStdout | ConvertFrom-Json; $adminJsonValid = $true } catch { }
                    }
                } catch { }
                finally {
                    $adminProcess.Dispose()
                }
                $adminObjectExists = $adminJsonValid -and $null -ne $adminData -and $adminData -isnot [string] -and @($adminData.PSObject.Properties).Count -gt 0
                $adminPreflightPass = $adminExit -eq 0 -and -not $adminTimedOut -and $adminJsonValid -and $adminObjectExists
                $adminErrorCode = if ($adminTimedOut) { 'ADMIN_GET_TIMEOUT' } elseif ($adminExit -ne 0) { 'ADMIN_GET_FAILED' } elseif (-not $adminJsonValid) { 'ADMIN_GET_INVALID_JSON' } elseif (-not $adminObjectExists) { 'ADMIN_GET_EMPTY_JSON' } else { $null }
                $restartAdminPreflight = [ordered]@{ status = if ($adminPreflightPass) { 'PASS' } else { 'FAIL' }; endpoint = 'https://api.openai.com'; tunnel_id = $TunnelId; exit_code = $adminExit; timeout_ms = 10000; json_valid = $adminJsonValid; object_exists = $adminObjectExists; error_code = $adminErrorCode }
                if (-not $adminPreflightPass) {
                    $result = [ordered]@{ status = 'BLOCKED'; phase = 'restart_preflight'; stage = 'restart_preflight'; daemon = 'ACTIVE_UNCHANGED'; error_code = $adminErrorCode; exit_code = $adminExit }
                } else {
                    $null = & $pwsh -NoProfile -ExecutionPolicy Bypass -File $stopScript -PidFile $pidFile 2>$null
                    $stopExit = [int]$LASTEXITCODE
                    if ($stopExit -ne 0) {
                        $result = [ordered]@{ status = 'BLOCKED'; phase = 'restart_stop'; stage = 'restart_stop'; daemon = 'NOT_STARTED_OR_STOPPED'; error_code = 'RESTART_STOP_FAILED'; exit_code = $stopExit }
                    } elseif (Get-Process -Id $restartPid -ErrorAction SilentlyContinue) {
                        $result = [ordered]@{ status = 'BLOCKED'; phase = 'restart_stop'; stage = 'restart_stop'; daemon = 'NOT_STARTED_OR_STOPPED'; error_code = 'RESTART_STOP_INCOMPLETE'; exit_code = $stopExit }
                    } elseif ((Test-Path -LiteralPath $pidFile -PathType Leaf) -or (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) {
                        $result = [ordered]@{ status = 'BLOCKED'; phase = 'restart_stop'; stage = 'restart_stop'; daemon = 'NOT_STARTED_OR_STOPPED'; error_code = 'RESTART_METADATA_REMAINS'; exit_code = $stopExit }
                    }
                }
            }
        }
    }

    if ($null -eq $result) {
        $stage = 'start'
        $startProcess = $null
        $startExited = $false
        try {
            $startProcess = Start-Process -FilePath $pwsh -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -ArgumentList @(
                '-NoProfile'
                '-ExecutionPolicy'
                'Bypass'
                '-File'
                ('"{0}"' -f $startScript)
                '-Start'
                '-ConfigPath'
                ('"{0}"' -f $profilePath)
                '-RunDirectory'
                ('"{0}"' -f $RunDirectory)
                '-NodePath'
                ('"{0}"' -f $node)
            )
            # Wait only for the short-lived start wrapper. The daemon is deliberately
            # not awaited here; it owns its lifecycle and health is checked below.
            $startExited = $startProcess.WaitForExit(15000)
            if (-not $startExited) {
                $result = [ordered]@{ status = 'BLOCKED'; phase = 'start'; stage = 'start'; daemon = 'START_WRAPPER_TIMEOUT'; error_code = 'START_WRAPPER_TIMEOUT'; exit_code = $null }
            } elseif ($startProcess.ExitCode -ne 0) {
                $result = [ordered]@{ status = 'BLOCKED'; phase = 'start'; stage = 'start'; daemon = 'NOT_STARTED_OR_STOPPED'; error_code = 'START_FAILED'; exit_code = [int]$startProcess.ExitCode }
            }
        } catch {
            $result = [ordered]@{ status = 'BLOCKED'; phase = 'start'; stage = 'start'; daemon = 'NOT_STARTED_OR_STOPPED'; error_code = 'START_FAILED'; exit_code = $null }
        } finally {
            if ($null -ne $startProcess) { $startProcess.Dispose() }
        }
    }

    if ($null -eq $result) {
        $stage = 'health'
        $pidValue = $null
        if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
            try { $pidValue = (Get-Content -Raw -LiteralPath $runtimeFile | ConvertFrom-Json).pid } catch { }
        }
        $healthExit = $null
        $healthTimedOut = $false
        $healthJsonValid = $false
        $healthData = $null
        $healthErrorCode = $null
        $healthAttemptCount = 0
        $healthContractPass = $false
        $healthOk = $false
        $processRunning = $false
        $healthzOk = $false
        $healthzStatus = $null
        $readyzOk = $false
        $readyzStatus = $null
        $controlPlanePollOk = $false
        $healthResult = $null
        $healthBaseUrl = $null
        $healthDeadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
        while ([DateTimeOffset]::UtcNow -lt $healthDeadline) {
            $healthAttemptCount += 1
            $healthArgs = @('health', '--pid-file', $pidFile, '--url-file', $healthFile, '--require-control-plane-poll', '--json')
            $healthPsi = [Diagnostics.ProcessStartInfo]::new()
            $healthPsi.FileName = [IO.Path]::GetFullPath($client)
            $healthPsi.WorkingDirectory = $workspace
            $healthPsi.UseShellExecute = $false
            $healthPsi.CreateNoWindow = $true
            $healthPsi.RedirectStandardOutput = $true
            $healthPsi.RedirectStandardError = $true
            foreach ($argument in $healthArgs) { [void]$healthPsi.ArgumentList.Add([string]$argument) }
            $healthProcess = [Diagnostics.Process]::new()
            $healthProcess.StartInfo = $healthPsi
            $probeExit = $null
            $probeTimedOut = $false
            $probeJsonValid = $false
            $probeData = $null
            $probeStdout = ''
            try {
                if (-not $healthProcess.Start()) { throw 'health CLI process did not start' }
                $probeStdoutTask = $healthProcess.StandardOutput.ReadToEndAsync()
                $probeStderrTask = $healthProcess.StandardError.ReadToEndAsync()
                $remainingMilliseconds = [int][Math]::Max(1, [Math]::Floor(([Math]::Max(0, ($healthDeadline - [DateTimeOffset]::UtcNow).TotalMilliseconds))))
                if (-not $healthProcess.WaitForExit($remainingMilliseconds)) {
                    $probeTimedOut = $true
                    try { $healthProcess.Kill() } catch { }
                    try { $healthProcess.WaitForExit(5000) | Out-Null } catch { }
                }
                $healthProcess.Refresh()
                if ($healthProcess.HasExited) { $probeExit = [int]$healthProcess.ExitCode }
                $probeStdout = $probeStdoutTask.GetAwaiter().GetResult()
                $null = $probeStderrTask.GetAwaiter().GetResult()
                if ($probeStdout.Trim()) {
                    try { $probeData = $probeStdout | ConvertFrom-Json; $probeJsonValid = $true } catch { $healthErrorCode = 'HEALTH_INVALID_JSON' }
                }
            } catch {
                if ($null -eq $healthErrorCode) { $healthErrorCode = 'HEALTH_CLI_FAILED' }
            } finally {
                $healthProcess.Dispose()
            }
            $healthExit = $probeExit
            $healthTimedOut = $probeTimedOut
            $healthJsonValid = $probeJsonValid
            $healthData = $probeData
            $healthOk = $false
            $processRunning = $false
            $healthzOk = $false
            $healthzStatus = $null
            $readyzOk = $false
            $readyzStatus = $null
            $controlPlanePollOk = $false
            $healthResult = $null
            $healthBaseUrl = $null
            if ($probeJsonValid) {
                try {
                    $healthResult = [string]$probeData.result
                    $healthBaseUrl = [string]$probeData.base_url
                    $healthOk = $healthResult -eq 'ok'
                    $processRunning = [bool]$probeData.process.running
                    $healthzOk = [bool]$probeData.healthz.ok
                    $healthzStatus = [int]$probeData.healthz.status
                    $readyzOk = [bool]$probeData.readyz.ok
                    $readyzStatus = [int]$probeData.readyz.status
                    $controlPlanePollOk = [bool]$probeData.control_plane_poll.ok
                } catch { $healthErrorCode = 'HEALTH_SCHEMA_UNEXPECTED' }
            }
            $healthContractPass = $probeExit -eq 0 -and -not $probeTimedOut -and $probeJsonValid -and $healthResult -eq 'ok' -and $healthOk -and $processRunning -and $healthzOk -and $healthzStatus -eq 200 -and $readyzOk -and $readyzStatus -eq 200 -and $controlPlanePollOk
            if ($healthContractPass) { $healthErrorCode = $null; break }
            if ($probeTimedOut -or [DateTimeOffset]::UtcNow -ge $healthDeadline) { break }
            Start-Sleep -Milliseconds 250
        }
        $healthSummary = [ordered]@{
            attempts = $healthAttemptCount
            cli_exit_code = $healthExit
            timed_out = $healthTimedOut
            json_valid = $healthJsonValid
            result = $healthResult
            base_url = $healthBaseUrl
            ok = $healthOk
            process_running = $processRunning
            healthz_ok = $healthzOk
            healthz_status = $healthzStatus
            readyz_ok = $readyzOk
            readyz_status = $readyzStatus
            control_plane_poll_ok = $controlPlanePollOk
        }
        if (-not $healthContractPass) {
            $result = [ordered]@{
                status = 'BLOCKED'
                phase = 'health'
                stage = 'health'
                daemon = 'NOT_STARTED_OR_UNVERIFIED'
                pid = $pidValue
                health = if ($healthBaseUrl) { $healthBaseUrl } else { 'NOT_READY' }
                health_checks = $healthSummary
                profile = $profileName
                key_environment = 'RESTORED'
                error_code = if ($healthTimedOut) { 'HEALTH_TIMEOUT' } elseif ($healthErrorCode) { $healthErrorCode } else { 'HEALTH_FAILED' }
                exit_code = $healthExit
            }
        } else {
            $result = [ordered]@{
                status = 'STARTED'
                daemon = 'ACTIVE'
                pid = $pidValue
                health = $healthBaseUrl
                health_checks = $healthSummary
                profile = $profileName
                key_environment = 'RESTORED'
                stage = 'health'
                error_code = $null
                exit_code = 0
            }
        }
    }
} catch {
    $errorCode = 'UNEXPECTED_ERROR'
    if ($_.FullyQualifiedErrorId -eq 'NativeCommandError' -or $_.Exception -is [System.Management.Automation.RemoteException]) {
        $errorCode = 'NATIVE_COMMAND_ERROR'
    } elseif ($_.Exception -is [System.UnauthorizedAccessException]) {
        $errorCode = 'ACCESS_DENIED'
    }
    $exitCode = $null
    if ($null -ne $LASTEXITCODE) {
        try { $exitCode = [int]$LASTEXITCODE } catch { $exitCode = $null }
    }
    $result = [ordered]@{ status = 'BLOCKED'; phase = $stage; stage = $stage; daemon = 'NOT_STARTED_OR_STOPPED'; error_code = $errorCode; exit_code = $exitCode }
} finally {
    try {
        Restore-CodeScopeEnvironmentState -State $runtimeKeyEnvironmentState
        Restore-CodeScopeEnvironmentState -State $configEnvironmentState
        $environmentRestored = $true
    } catch {
        $environmentRestored = $false
    }
    $secret = $null
}

try {
        $currentProcess = Get-CodeScopeActiveProcessState -PidFile $pidFile -RuntimeFile $runtimeFile -ExpectedBinary $client -ExpectedProfile $profilePath -ExpectedBridgeConfig $bridgeConfig -ProfilePath $profilePath -TunnelId $TunnelId
} catch {
    $currentProcess = [pscustomobject]@{ status = 'FAIL'; active = $false; reason = 'CURRENT_PROCESS_PROBE_FAILED'; error_code = 'CURRENT_PROCESS_PROBE_FAILED'; pid = $null }
}
if ($result.Contains('health_checks') -and $null -ne $result.health_checks) {
    $currentHealth = $result.health_checks
} else {
    $currentHealth = $activeHealth
}
if ($result.status -in @('STARTED', 'ALREADY_HEALTHY') -and $currentProcess.status -ne 'PASS') {
    $result.status = 'BLOCKED'
    $result.daemon = if ($currentProcess.active) { 'ACTIVE_UNVERIFIED' } else { 'NOT_STARTED_OR_UNVERIFIED' }
    $result.error_code = 'CURRENT_PROCESS_UNVERIFIED'
    $result.exit_code = $null
}
if ($result.phase -eq 'health' -and $result.status -eq 'BLOCKED') {
    $result.daemon = if ($currentProcess.status -eq 'PASS') { 'ACTIVE_UNHEALTHY' } elseif ($currentProcess.active) { 'ACTIVE_UNVERIFIED' } else { 'NOT_STARTED_OR_UNVERIFIED' }
}

$result['restart_requested'] = [bool]$Restart
$result['restart_receipt_path'] = if ($Restart) { $restartReceiptPath } else { $null }
$result['restart_admin_preflight'] = $restartAdminPreflight
$result['attempt_id'] = $attemptId
$result['attempt_started_utc'] = $attemptStartedUtc
$result['attempt_receipt_path'] = $attemptReceiptPath
$result['historical_connect_result'] = $historicalConnectResult
$result['preexisting_process'] = $activeProcess
$result['current_process'] = $currentProcess
$result['preexisting_health'] = $activeHealth
$result['current_health'] = $currentHealth
$result['key_source'] = if ($result.Contains('key_source')) { $result.key_source } elseif ($null -ne $keyResolution) { $keyResolution.Source } else { 'NOT_RUN' }
$result['environment_restored'] = $environmentRestored
$timestamp = (Get-Date).ToUniversalTime().ToString('o')
$persistedResult = [ordered]@{
    schema_version = 2
    attempt_id = $attemptId
    attempt_started_utc = $attemptStartedUtc
    attempt_receipt_path = $attemptReceiptPath
    status = $result.status
    restart_requested = [bool]$Restart
    restart_admin_preflight = $restartAdminPreflight
    phase = if ($result.Contains('phase')) { $result.phase } else { 'complete' }
    stage = if ($result.Contains('stage')) { $result.stage } else { $result.phase }
    pid = if ($result.Contains('pid')) { $result.pid } else { $null }
    health = if ($result.Contains('health')) { $result.health } else { 'NOT_RUN' }
    health_checks = if ($result.Contains('health_checks')) { $result.health_checks } else { $null }
    preexisting_process = $activeProcess
    current_process = $currentProcess
    preexisting_health = $activeHealth
    current_health = $currentHealth
    key_source = $result.key_source
    environment_restored = $environmentRestored
    historical_connect_result = $historicalConnectResult
    error_code = if ($result.Contains('error_code')) { $result.error_code } else { $null }
    exit_code = if ($result.Contains('exit_code')) { $result.exit_code } else { $null }
    timestamp_utc = $timestamp
}
$resultJson = $result | ConvertTo-Json -Compress
$persistedJson = $persistedResult | ConvertTo-Json -Compress
try {
    New-Item -ItemType Directory -Force -Path $attemptsDirectory | Out-Null
    Set-Content -LiteralPath $attemptReceiptPath -Value $persistedJson -Encoding UTF8
} catch {
    # The stdout result remains the sanitized source of truth if persistence is unavailable.
}
$displayError = if ($result.Contains('error_code') -and $null -ne $result.error_code -and [string]$result.error_code) { [string]$result.error_code } else { 'ninguno' }
Write-Host ("Estado del túnel: {0}; error: {1}" -f [string]$result.status, $displayError)
$resultJson
if ($result.status -in @('STARTED', 'ALREADY_HEALTHY')) { exit 0 }
exit 2
