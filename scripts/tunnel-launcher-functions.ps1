function Get-CodeScopeEnvironmentState {
    param([Parameter(Mandatory = $true)][string]$Name)

    $item = Get-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        name = $Name
        present = $null -ne $item
        value = if ($null -ne $item) { [Environment]::GetEnvironmentVariable($Name, 'Process') } else { $null }
    }
}

function Set-CodeScopeEnvironmentVariable {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][string]$Value
    )

    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Restore-CodeScopeEnvironmentState {
    param([Parameter(Mandatory = $true)]$State)

    if ($State.present) {
        Set-CodeScopeEnvironmentVariable -Name $State.Name -Value $State.value
    } else {
        Set-CodeScopeEnvironmentVariable -Name $State.Name -Value $null
    }
}

function Resolve-CodeScopeRuntimeKey {
    param(
        [string]$Name = 'CODESCOPE_TUNNEL_RUNTIME_KEY',
        [scriptblock]$EnvironmentReader = { param($VariableName, $Scope) [Environment]::GetEnvironmentVariable($VariableName, $Scope) },
        [scriptblock]$Prompt = { Read-Host 'Introduce la clave runtime (entrada oculta; no se guarda)' -AsSecureString }
    )

    foreach ($scope in @('Process', 'User', 'Machine')) {
        $candidate = [string](& $EnvironmentReader $Name $scope)
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            return [pscustomobject]@{ Value = $candidate; Source = $scope }
        }
    }

    $secure = & $Prompt
    if ($null -eq $secure) { throw 'Runtime key prompt returned no value' }
    $ptr = [IntPtr]::Zero
    try {
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $candidate = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ([string]::IsNullOrWhiteSpace($candidate)) { throw 'Runtime key prompt returned an empty value' }
        return [pscustomobject]@{ Value = $candidate; Source = 'Prompt' }
    } finally {
        if ($ptr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        }
        $secure = $null
    }
}

function Get-CodeScopeActiveProcessState {
    param(
        [Parameter(Mandatory = $true)][string]$PidFile,
        [Parameter(Mandatory = $true)][string]$RuntimeFile,
        [Parameter(Mandatory = $true)][string]$ExpectedBinary,
        [Parameter(Mandatory = $true)][string]$ExpectedProfile,
        [Parameter(Mandatory = $true)][string]$ExpectedBridgeConfig,
        [Parameter(Mandatory = $true)][string]$ProfilePath,
        [Parameter(Mandatory = $true)][string]$TunnelId
    )

    $state = [ordered]@{
        status = 'NOT_ACTIVE'
        active = $false
        pid = $null
        start_time_utc = $null
        binary = $null
        config = $null
        profile = $null
        reason = 'PID_FILE_ABSENT'
        error_code = $null
    }
    $pidFileExists = Test-Path -LiteralPath $PidFile -PathType Leaf
    $runtimeFileExists = Test-Path -LiteralPath $RuntimeFile -PathType Leaf
    $runtime = $null
    if ($runtimeFileExists) {
        try { $runtime = Get-Content -Raw -LiteralPath $RuntimeFile | ConvertFrom-Json -AsHashtable -DateKind String } catch {
            if (-not $pidFileExists) { return [pscustomobject]$state }
        }
    }
    $pidValue = 0
    if ($pidFileExists) {
        if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $PidFile).Trim(), [ref]$pidValue)) {
            $state.status = 'FAIL'
            $state.reason = 'PID_FILE_INVALID'
            $state.error_code = 'INVALID_PID_FILE'
            return [pscustomobject]$state
        }
    } elseif ($null -ne $runtime -and [int]::TryParse([string]$runtime.pid, [ref]$pidValue)) {
        $state.reason = 'PID_FILE_ABSENT_RUNTIME_CANDIDATE'
    } else {
        return [pscustomobject]$state
    }
    $state.pid = $pidValue
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        $state.reason = if ($pidFileExists) { 'PROCESS_NOT_RUNNING' } else { 'RUNTIME_PROCESS_NOT_RUNNING' }
        return [pscustomobject]$state
    }
    $state.active = $true
    $state.status = 'FAIL'
    $state.reason = 'ACTIVE_UNVERIFIED'

    if ($null -eq $runtime) {
        $state.reason = 'RUNTIME_METADATA_MISSING'
        $state.error_code = 'RUNTIME_METADATA_MISSING'
        return [pscustomobject]$state
    }
    if ([int]$runtime.pid -ne $pidValue) {
        $state.reason = 'RUNTIME_PID_MISMATCH'
        $state.error_code = 'RUNTIME_PID_MISMATCH'
        return [pscustomobject]$state
    }
    $recordedBinary = [IO.Path]::GetFullPath([string]$runtime.binary)
    $state.binary = $recordedBinary
    $state.config = [string]$runtime.config
    $state.profile = [string]$runtime.profile
    $state.start_time_utc = [string]$runtime.start_time_utc
    if ($recordedBinary -ine [IO.Path]::GetFullPath($ExpectedBinary)) {
        $state.reason = 'RUNTIME_BINARY_MISMATCH'
        $state.error_code = 'RUNTIME_BINARY_MISMATCH'
        return [pscustomobject]$state
    }
    if ([string]::IsNullOrWhiteSpace([string]$runtime.profile) -or [IO.Path]::GetFullPath([string]$runtime.profile) -ine [IO.Path]::GetFullPath($ProfilePath)) {
        $state.reason = 'RUNTIME_PROFILE_MISMATCH'
        $state.error_code = 'RUNTIME_PROFILE_MISMATCH'
        return [pscustomobject]$state
    }
    if ([string]::IsNullOrWhiteSpace([string]$runtime.config) -or [IO.Path]::GetFullPath([string]$runtime.config) -ine [IO.Path]::GetFullPath($ExpectedProfile)) {
        $state.reason = 'RUNTIME_CONFIG_MISMATCH'
        $state.error_code = 'RUNTIME_CONFIG_MISMATCH'
        return [pscustomobject]$state
    }
    if ([string]::IsNullOrWhiteSpace([string]$runtime.bridge_config) -or [IO.Path]::GetFullPath([string]$runtime.bridge_config) -ine [IO.Path]::GetFullPath($ExpectedBridgeConfig)) {
        $state.reason = 'RUNTIME_BRIDGE_CONFIG_MISMATCH'
        $state.error_code = 'RUNTIME_BRIDGE_CONFIG_MISMATCH'
        return [pscustomobject]$state
    }
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Leaf)) {
        $state.reason = 'PROFILE_MISSING'
        $state.error_code = 'PROFILE_MISSING'
        return [pscustomobject]$state
    }
    $profileText = Get-Content -Raw -LiteralPath $ProfilePath
    $tunnelPattern = '(?m)^\s*tunnel_id:\s*["'']?' + [Regex]::Escape($TunnelId) + '["'']?\s*$'
    if ($profileText -notmatch $tunnelPattern) {
        $state.reason = 'PROFILE_TUNNEL_MISMATCH'
        $state.error_code = 'PROFILE_TUNNEL_MISMATCH'
        return [pscustomobject]$state
    }
    $processInfo = $null
    try { $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" } catch { }
    $actualBinary = if ($null -ne $processInfo) { [string]$processInfo.ExecutablePath } else { $null }
    if ([string]::IsNullOrWhiteSpace($actualBinary)) {
        try { $actualBinary = [string]$process.MainModule.FileName } catch { }
    }
    if ([string]::IsNullOrWhiteSpace($actualBinary)) {
        $state.reason = 'PROCESS_IDENTITY_UNAVAILABLE'
        $state.error_code = 'PROCESS_IDENTITY_UNAVAILABLE'
        return [pscustomobject]$state
    }
    if ([IO.Path]::GetFullPath($actualBinary) -ine [IO.Path]::GetFullPath($ExpectedBinary)) {
        $state.reason = 'PROCESS_BINARY_MISMATCH'
        $state.error_code = 'PROCESS_BINARY_MISMATCH'
        return [pscustomobject]$state
    }
    try {
        $recordedStart = [DateTimeOffset]::Parse([string]$runtime.start_time_utc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        $actualStart = if ($null -ne $processInfo -and $null -ne $processInfo.CreationDate) { ([DateTimeOffset]$processInfo.CreationDate).ToUniversalTime() } else { ([DateTimeOffset]$process.StartTime.ToUniversalTime()) }
    } catch {
        $state.reason = 'PROCESS_START_TIME_UNAVAILABLE'
        $state.error_code = 'PROCESS_START_TIME_UNAVAILABLE'
        return [pscustomobject]$state
    }
    if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 3) {
        $state.reason = 'PROCESS_START_TIME_MISMATCH'
        $state.error_code = 'PROCESS_START_TIME_MISMATCH'
        return [pscustomobject]$state
    }
    if (-not $pidFileExists) {
        $state.reason = 'PID_FILE_MISSING_ACTIVE'
        $state.error_code = 'PID_FILE_MISSING_ACTIVE'
        return [pscustomobject]$state
    }
    $state.status = 'PASS'
    $state.reason = 'ACTIVE_PROCESS_MATCH'
    $state.error_code = $null
    return [pscustomobject]$state
}

function Test-CodeScopeHealthyInstance {
    param(
        [Parameter(Mandatory = $true)]$ActiveProcess,
        [Parameter(Mandatory = $true)]$Health
    )

    return [bool]($ActiveProcess.active -and $ActiveProcess.status -eq 'PASS' -and $Health.status -eq 'PASS')
}

function Invoke-CodeScopeHealthProbe {
    param(
        [Parameter(Mandatory = $true)][string]$ClientPath,
        [Parameter(Mandatory = $true)][string]$PidFile,
        [Parameter(Mandatory = $true)][string]$HealthFile,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [int]$TimeoutSeconds = 45
    )

    $healthExit = $null
    $healthTimedOut = $false
    $healthJsonValid = $false
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
    $healthDeadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $healthDeadline) {
        $healthAttemptCount += 1
        $healthArgs = @('health', '--pid-file', $PidFile, '--url-file', $HealthFile, '--require-control-plane-poll', '--json')
        $healthPsi = [Diagnostics.ProcessStartInfo]::new()
        $healthPsi.FileName = [IO.Path]::GetFullPath($ClientPath)
        $healthPsi.WorkingDirectory = $WorkingDirectory
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
    [pscustomobject]@{
        status = if ($healthContractPass) { 'PASS' } else { 'FAIL' }
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
        error_code = $healthErrorCode
    }
}
