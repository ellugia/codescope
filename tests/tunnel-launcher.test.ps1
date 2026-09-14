$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $workspace 'scripts\tunnel-launcher-functions.ps1')

function Assert-CodeScope($Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Assert-CodeScopeEqual($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) { throw "FAIL: $Message" }
}

function Stop-CodeScopeTestTunnel {
    param([Parameter(Mandatory = $true)][string]$ScratchPath)

    $pidFile = Join-Path $ScratchPath 'run\tunnel-client.pid'
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return }
    $pidValue = 0
    if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$pidValue)) { return }
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($null -eq $process) { return }
    $expectedBinary = [IO.Path]::GetFullPath((Join-Path $workspace 'deps\tunnel-client\v0.0.10-windows-amd64\tunnel-client.exe'))
    if ($process.Path -ine $expectedBinary) { throw 'FAIL: scratch PID was reused by a different executable' }
    Stop-Process -Id $pidValue -ErrorAction Stop
    try { Wait-Process -Id $pidValue -Timeout 5 -ErrorAction SilentlyContinue } catch { }
    if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { throw 'FAIL: scratch tunnel-client remained after cleanup' }
}

$tests = [ordered]@{}
$scratch = Join-Path ([IO.Path]::GetTempPath()) "CodeScope launcher test-$PID"
$syntheticKey = 'codescope-test-secret-never-print'
$pwsh = if (-not [string]::IsNullOrWhiteSpace($env:CODESCOPE_PWSH_PATH)) {
    [IO.Path]::GetFullPath($env:CODESCOPE_PWSH_PATH)
} elseif ($PSVersionTable.PSVersion.Major -ge 7 -and (Test-Path -LiteralPath (Join-Path $PSHOME 'pwsh.exe') -PathType Leaf)) {
    [IO.Path]::GetFullPath((Join-Path $PSHOME 'pwsh.exe'))
} else {
    $command = Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    [IO.Path]::GetFullPath([string]$command.Path)
}
if (-not (Test-Path -LiteralPath $pwsh -PathType Leaf)) { throw "PowerShell 7 executable not found: $pwsh" }
$fixtureConfig = [IO.Path]::GetFullPath((Join-Path $workspace 'config\fixture.json'))
$identityProcess = $null
$wrapperProcess = $null
$grandchildPid = 0
$grandchildPidFile = $null
$wrapperScript = $null
$grandchildScript = $null
$environmentBefore = $null
$environmentChanged = $false
try {
    $values = @{ Process = 'process-value'; User = 'user-value'; Machine = 'machine-value' }
    $reader = { param($Name, $Scope) $values[$Scope] }
    $resolved = Resolve-CodeScopeRuntimeKey -EnvironmentReader $reader -Prompt { throw 'prompt should not run' }
    Assert-CodeScopeEqual 'Process' $resolved.Source 'process has priority'
    $tests.priority_process = 'PASS'

    $values = @{ Process = '  '; User = 'user-value'; Machine = 'machine-value' }
    $resolved = Resolve-CodeScopeRuntimeKey -EnvironmentReader $reader -Prompt { throw 'prompt should not run' }
    Assert-CodeScopeEqual 'User' $resolved.Source 'user is second priority'
    $values = @{ Process = ''; User = ''; Machine = 'machine-value' }
    $resolved = Resolve-CodeScopeRuntimeKey -EnvironmentReader $reader -Prompt { throw 'prompt should not run' }
    Assert-CodeScopeEqual 'Machine' $resolved.Source 'machine is third priority'
    $tests.priority_user_machine = 'PASS'

    $values = @{ Process = ''; User = ''; Machine = '' }
    $resolved = Resolve-CodeScopeRuntimeKey -EnvironmentReader $reader -Prompt { ConvertTo-SecureString 'prompt-value' -AsPlainText -Force }
    Assert-CodeScopeEqual 'Prompt' $resolved.Source 'prompt is last priority'
    Assert-CodeScopeEqual 'prompt-value' $resolved.Value 'prompt value was read'
    $tests.prompt = 'PASS'

    $before = Get-CodeScopeEnvironmentState -Name 'CODESCOPE_TUNNEL_RUNTIME_KEY'
    $environmentBefore = $before
    Set-CodeScopeEnvironmentVariable -Name 'CODESCOPE_TUNNEL_RUNTIME_KEY' -Value $syntheticKey
    $environmentChanged = $true
    $changed = Get-CodeScopeEnvironmentState -Name 'CODESCOPE_TUNNEL_RUNTIME_KEY'
    Assert-CodeScope ($changed.present -and $changed.value -eq $syntheticKey) 'synthetic process value was set'
    Restore-CodeScopeEnvironmentState -State $before
    $environmentChanged = $false
    $after = Get-CodeScopeEnvironmentState -Name 'CODESCOPE_TUNNEL_RUNTIME_KEY'
    Assert-CodeScopeEqual ([bool]$before.present) ([bool]$after.present) 'process presence was restored'
    Assert-CodeScopeEqual $before.value $after.value 'process value was restored'
    $tests.environment_restore = 'PASS'

    $active = [pscustomobject]@{ active = $true; status = 'PASS' }
    $healthy = [pscustomobject]@{ status = 'PASS' }
    $unhealthy = [pscustomobject]@{ status = 'FAIL' }
    Assert-CodeScope (Test-CodeScopeHealthyInstance -ActiveProcess $active -Health $healthy) 'healthy instance is reusable'
    Assert-CodeScope (-not (Test-CodeScopeHealthyInstance -ActiveProcess $active -Health $unhealthy)) 'unhealthy instance is not reusable'
    $tests.healthy_reuse = 'PASS'

    New-Item -ItemType Directory -Force -Path (Join-Path $scratch 'profiles') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $scratch 'run') | Out-Null

    $identityProfile = Join-Path $scratch 'profiles\identity.yaml'
    $identityPidFile = Join-Path $scratch 'run\identity.pid'
    $identityRuntimeFile = Join-Path $scratch 'run\identity.runtime.json'
    $tunnelId = 'tunnel_00000000000000000000000000000000'
    Set-Content -LiteralPath $identityProfile -Value "tunnel_id: $tunnelId`n" -Encoding UTF8
    $identityProcess = Start-Process -FilePath $pwsh -WindowStyle Hidden -PassThru -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30')
    $identityStartUtc = $identityProcess.StartTime.ToUniversalTime().ToString('o')
    Set-Content -LiteralPath $identityPidFile -Value ([string]$identityProcess.Id) -Encoding ASCII
    [ordered]@{
        pid = $identityProcess.Id
        start_time_utc = $identityStartUtc
        binary = [IO.Path]::GetFullPath($pwsh)
        profile = [IO.Path]::GetFullPath($identityProfile)
        config = [IO.Path]::GetFullPath($identityProfile)
        bridge_config = $fixtureConfig
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath $identityRuntimeFile -Encoding UTF8
    $identityState = Get-CodeScopeActiveProcessState -PidFile $identityPidFile -RuntimeFile $identityRuntimeFile -ExpectedBinary $pwsh -ExpectedProfile $identityProfile -ExpectedBridgeConfig $fixtureConfig -ProfilePath $identityProfile -TunnelId $tunnelId
    Assert-CodeScopeEqual 'PASS' $identityState.status 'ISO timestamp with timezone matched the live process'
    Assert-CodeScopeEqual 'ACTIVE_PROCESS_MATCH' $identityState.reason 'live process identity was verified'
    $rawIdentityRuntime = Get-Content -Raw -LiteralPath $identityRuntimeFile | ConvertFrom-Json -AsHashtable -DateKind String
    Assert-CodeScopeEqual 'System.String' $rawIdentityRuntime['start_time_utc'].GetType().FullName 'runtime timestamp stayed a raw ISO string'
    $tests.timestamp_identity = 'PASS'

    $grandchildScript = Join-Path $scratch 'grandchild.ps1'
    $wrapperScript = Join-Path $scratch 'start-wrapper.ps1'
    $grandchildPidFile = Join-Path $scratch 'grandchild.pid'
    $wrapperReceipt = Join-Path $scratch 'wrapper-receipt.json'
    @'
param([string]$Marker)
if ($Marker -ne 'codescope-launcher-grandchild-test=true') { exit 9 }
Start-Sleep -Seconds 20
'@ | Set-Content -LiteralPath $grandchildScript -Encoding UTF8
    @'
param([string]$PwshPath, [string]$GrandchildScript, [string]$ChildPidPath, [string]$ReceiptPath)
    $child = Start-Process -FilePath $PwshPath -WindowStyle Hidden -PassThru -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', ('"{0}"' -f $GrandchildScript), '-Marker', 'codescope-launcher-grandchild-test=true')
Set-Content -LiteralPath $ChildPidPath -Value ([string]$child.Id) -Encoding ASCII
Set-Content -LiteralPath $ReceiptPath -Value '{"status":"PASS"}' -Encoding UTF8
'@ | Set-Content -LiteralPath $wrapperScript -Encoding UTF8
    $wrapperProcess = Start-Process -FilePath $pwsh -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $wrapperScript), ('"{0}"' -f $pwsh), ('"{0}"' -f $grandchildScript), ('"{0}"' -f $grandchildPidFile), ('"{0}"' -f $wrapperReceipt))
    Assert-CodeScope ($wrapperProcess.WaitForExit(5000)) 'short start wrapper exited without waiting for its grandchild'
    Assert-CodeScope (Test-Path -LiteralPath $wrapperReceipt -PathType Leaf) 'wrapper persisted its receipt before grandchild exit'
    Assert-CodeScope (Test-Path -LiteralPath $grandchildPidFile -PathType Leaf) 'wrapper recorded its grandchild PID'
    $grandchildPid = 0
    Assert-CodeScope ([int]::TryParse((Get-Content -Raw -LiteralPath $grandchildPidFile).Trim(), [ref]$grandchildPid)) 'grandchild PID was numeric'
    $grandchild = Get-Process -Id $grandchildPid -ErrorAction SilentlyContinue
    Assert-CodeScope ($null -ne $grandchild -and $grandchild.Path -ieq [IO.Path]::GetFullPath($pwsh)) 'grandchild remained independently alive'
    $grandchildInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $grandchildPid"
    Assert-CodeScope ([string]$grandchildInfo.CommandLine -like '*codescope-launcher-grandchild-test=true*') 'grandchild identity was owned by this test'
    $tests.start_wrapper_detached = 'PASS'

    $historical = Join-Path $scratch 'run\connect-result.json'
    Set-Content -LiteralPath $historical -Value '{"status":"historical"}' -Encoding UTF8
    $historicalHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $historical).Hash
    $launcher = Join-Path $workspace 'scripts\tunnel-connect-interactive.ps1'
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $pwsh
    $psi.WorkingDirectory = $workspace
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher, '-TunnelId', $tunnelId, '-ProfileDir', (Join-Path $scratch 'profiles'), '-RunDirectory', (Join-Path $scratch 'run'), '-BridgeConfigPath', $fixtureConfig, '-Restart')) {
        [void]$psi.ArgumentList.Add($argument)
    }
    $psi.Environment['CODESCOPE_TUNNEL_RUNTIME_KEY'] = $syntheticKey
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $psi
    if (-not $child.Start()) { throw 'FAIL: launcher child did not start' }
    $stdoutTask = $child.StandardOutput.ReadToEndAsync()
    $stderrTask = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(60000)) {
        try { $child.Kill() } catch { }
        throw 'FAIL: launcher child timed out'
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $childExitCode = $child.ExitCode
    $child.Dispose()
    $createdContent = ((Get-ChildItem -LiteralPath $scratch -Recurse -File | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }) -join "`n")
    Assert-CodeScope (-not (($stdout + $stderr + $createdContent).Contains($syntheticKey))) 'secret was absent from output and receipts'
    Assert-CodeScopeEqual $historicalHash (Get-FileHash -Algorithm SHA256 -LiteralPath $historical).Hash 'historical receipt was preserved'
    $attempts = @(Get-ChildItem -LiteralPath (Join-Path $scratch 'run\connect-attempts') -Filter 'connect-result-*.json' -File -ErrorAction SilentlyContinue)
    Assert-CodeScope ($attempts.Count -eq 1) 'new attempt receipt was separated'
    $tests.secret_and_receipts = 'PASS'

    [ordered]@{ status = 'PASS'; tests = $tests; child_exit_code = $childExitCode } | ConvertTo-Json -Compress
} finally {
    $cleanupErrors = @()
    try { Stop-CodeScopeTestTunnel -ScratchPath $scratch } catch { $cleanupErrors += $_.Exception.Message }
    if ($grandchildPid -eq 0 -and $null -ne $grandchildPidFile -and (Test-Path -LiteralPath $grandchildPidFile -PathType Leaf)) {
        [int]::TryParse((Get-Content -Raw -LiteralPath $grandchildPidFile).Trim(), [ref]$grandchildPid) | Out-Null
    }
    if ($grandchildPid -gt 0) {
        try {
            $grandchild = Get-Process -Id $grandchildPid -ErrorAction SilentlyContinue
            if ($null -ne $grandchild) {
                if ($grandchild.Path -ine [IO.Path]::GetFullPath($pwsh)) { throw 'FAIL: cleanup PID was not the test PowerShell executable' }
                $grandchildInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $grandchildPid"
                if ([string]$grandchildInfo.CommandLine -notlike '*codescope-launcher-grandchild-test=true*') { throw 'FAIL: cleanup PID did not carry the test marker' }
                Stop-Process -Id $grandchildPid -Force -ErrorAction Stop
                try { Wait-Process -Id $grandchildPid -Timeout 5 -ErrorAction SilentlyContinue } catch { }
            }
        } catch { $cleanupErrors += $_.Exception.Message }
    }
    if ($null -ne $identityProcess) {
        try {
            $identityLive = Get-Process -Id $identityProcess.Id -ErrorAction SilentlyContinue
            if ($null -ne $identityLive) {
                if ($identityLive.Path -ine [IO.Path]::GetFullPath($pwsh)) { throw 'FAIL: identity cleanup PID was not the test PowerShell executable' }
                Stop-Process -Id $identityProcess.Id -Force -ErrorAction Stop
                try { Wait-Process -Id $identityProcess.Id -Timeout 5 -ErrorAction SilentlyContinue } catch { }
            }
        } catch { $cleanupErrors += $_.Exception.Message }
    }
    if ($null -ne $wrapperProcess) {
        try {
            $wrapperLive = Get-Process -Id $wrapperProcess.Id -ErrorAction SilentlyContinue
            if ($null -ne $wrapperLive) {
                if ($wrapperLive.Path -ine [IO.Path]::GetFullPath($pwsh)) { throw 'FAIL: wrapper cleanup PID was not the test PowerShell executable' }
                Stop-Process -Id $wrapperProcess.Id -Force -ErrorAction Stop
                try { Wait-Process -Id $wrapperProcess.Id -Timeout 5 -ErrorAction SilentlyContinue } catch { }
            }
        } catch { $cleanupErrors += $_.Exception.Message }
    }
    try {
        if ($environmentChanged -and $null -ne $environmentBefore) {
            Restore-CodeScopeEnvironmentState -State $environmentBefore
        }
    } catch { $cleanupErrors += $_.Exception.Message }
    try {
        if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
    } catch { $cleanupErrors += $_.Exception.Message }
    if ($cleanupErrors.Count -gt 0) { throw ('FAIL: cleanup: ' + ($cleanupErrors -join '; ')) }
}
