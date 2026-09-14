$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$control = Join-Path $workspace 'scripts\codescope-control.ps1'
$managed = Join-Path $workspace 'config\managed'
$profile = Join-Path $managed ("managed-session-selection-{0}-{1}.json" -f $PID, ([Guid]::NewGuid().ToString('N')))
$runtime = Join-Path $managed 'runtime.bridge.json'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("CodeScope managed-session-selection-{0}-{1}" -f $PID, ([Guid]::NewGuid().ToString('N')))
$repoA = Join-Path $scratch 'alpha'
$repoB = Join-Path $scratch 'beta'
$sentinelA = Join-Path $repoA 'must-survive.txt'
$sentinelB = Join-Path $repoB 'must-survive.txt'
$tests = [ordered]@{}
$runtimeOwned = $false

function Assert-CodeScope {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Invoke-Control {
    param([Parameter(Mandatory = $true)][string]$Operation, [string[]]$Extra = @())
    $output = @(& $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $control -Operation $Operation -ProfilePath $profile -Json @Extra 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = [int]$LASTEXITCODE
    Assert-CodeScope ($output.Count -gt 0) "control returned no output for $Operation"
    $json = $output[-1] | ConvertFrom-Json
    return [pscustomobject]@{ exit_code = $exitCode; json = $json }
}

function Canonical-Path {
    param([Parameter(Mandatory = $true)][string]$Path)
    return ([IO.Path]::GetFullPath($Path)).TrimEnd('\', '/')
}

function Assert-BridgeRepositories {
    param(
        [Parameter(Mandatory = $true)]$Bridge,
        [Parameter(Mandatory = $true)][Collections.IDictionary]$Expected
    )
    Assert-CodeScope ($null -ne $Bridge.repositories) 'bridge repositories are present'
    $properties = @($Bridge.repositories.PSObject.Properties)
    Assert-CodeScope ($properties.Count -eq $Expected.Count) 'bridge contains exactly the expected aliases'
    foreach ($expectedEntry in $Expected.GetEnumerator()) {
        $property = $properties | Where-Object { $_.Name -ceq [string]$expectedEntry.Key }
        Assert-CodeScope ($null -ne $property) "bridge contains alias $($expectedEntry.Key)"
        Assert-CodeScope ((Canonical-Path ([string]$property.Value.root)) -ieq (Canonical-Path ([string]$expectedEntry.Value))) "bridge root for $($expectedEntry.Key) is exact"
        Assert-CodeScope ($property.Value.read_only -eq $true) "bridge alias $($expectedEntry.Key) is read-only"
    }
}

function Assert-BridgeBindings {
    param(
        [Parameter(Mandatory = $true)]$Bridge,
        [Parameter(Mandatory = $true)][Collections.IDictionary]$Expected
    )
    Assert-CodeScope ($null -ne $Bridge.optional_backends) 'bridge optional_backends are present'
    Assert-CodeScope ($Bridge.optional_backends.auto_discover -eq $true) 'bridge preserves optional autodiscovery'
    $properties = @($Bridge.optional_backends.bindings.PSObject.Properties)
    Assert-CodeScope ($properties.Count -eq $Expected.Count) 'bridge contains exactly the expected bindings'
    foreach ($expectedEntry in $Expected.GetEnumerator()) {
        $property = $properties | Where-Object { $_.Name -ceq [string]$expectedEntry.Key }
        Assert-CodeScope ($null -ne $property) "bridge contains binding $($expectedEntry.Key)"
        $binding = $property.Value
        Assert-CodeScope ($binding.codebase_memory.read_only -eq $true) "binding $($expectedEntry.Key) is read-only"
        Assert-CodeScope ((Canonical-Path ([string]$binding.codebase_memory.root)) -ieq (Canonical-Path ([string]$expectedEntry.Value))) "binding root for $($expectedEntry.Key) is exact"
        Assert-CodeScope ($binding.context_mode.read_only -eq $true) "Context Mode binding $($expectedEntry.Key) is read-only"
        Assert-CodeScope ((Canonical-Path ([string]$binding.context_mode.project_root)) -ieq (Canonical-Path ([string]$expectedEntry.Value))) "Context Mode root for $($expectedEntry.Key) is exact"
    }
}

function Assert-SessionAccess {
    param([Parameter(Mandatory = $true)]$Bridge)
    Assert-CodeScope ($null -ne $Bridge.session_access) 'bridge session_access is present'
    Assert-CodeScope ($Bridge.session_access.mode -eq 'session_select') 'bridge session access mode is session_select'
    Assert-CodeScope ($Bridge.session_access.require_session -eq $true) 'bridge requires a session'
    $ttlSeconds = 0
    $parsed = [int]::TryParse([string]$Bridge.session_access.ttl_seconds, [ref]$ttlSeconds)
    Assert-CodeScope ($parsed -and $ttlSeconds -gt 0 -and $ttlSeconds -le 86400) 'bridge session TTL is valid'
}

try {
    Assert-CodeScope (-not (Test-Path -LiteralPath $profile -PathType Leaf)) 'test profile path is unused'
    Assert-CodeScope (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) 'managed runtime is absent before the test'
    Assert-CodeScope (-not (Test-Path -LiteralPath $scratch)) 'scratch path is unused'

    New-Item -ItemType Directory -Force -Path $repoA, $repoB | Out-Null
    Set-Content -LiteralPath $sentinelA -Value 'alpha-survives' -Encoding UTF8
    Set-Content -LiteralPath $sentinelB -Value 'beta-survives' -Encoding UTF8
    $expectedBoth = [ordered]@{ alpha = $repoA; beta = $repoB }
    $expectedAlpha = [ordered]@{ alpha = $repoA }
    $expectedBeta = [ordered]@{ beta = $repoB }

    $initial = Invoke-Control -Operation 'list'
    Assert-CodeScope ($initial.exit_code -eq 0 -and $initial.json.status -eq 'PASS') 'empty managed profile listed'
    $tests.initial = 'PASS'

    $addedA = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', 'alpha', '-Root', $repoA)
    Assert-CodeScope ($addedA.exit_code -eq 0 -and $addedA.json.status -eq 'PASS') 'first alias added disabled'
    $addedB = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', 'beta', '-Root', $repoB)
    Assert-CodeScope ($addedB.exit_code -eq 0 -and $addedB.json.status -eq 'PASS') 'second alias added disabled'
    Assert-CodeScope (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) 'disabled aliases do not materialize runtime roots'
    $tests.add_two_aliases = 'PASS'

    $profileData = Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json -AsHashtable
    $profileData.optional_backends.bindings['alpha'] = [ordered]@{
        codebase_memory = [ordered]@{
            enabled = $true
            read_only = $true
            project = 'managed-session-selection'
            root = (Canonical-Path $repoA)
            allowed_paths = @('src/graph_fixture.py')
        }
        context_mode = [ordered]@{
            enabled = $true
            read_only = $true
            scope = 'bound'
            project = 'managed-session-selection-context'
            project_root = (Canonical-Path $repoA)
            storage = (Join-Path (Canonical-Path $repoA) '.context\storage')
            session_id = 'managed-session-selection'
            source = 'managed-session-selection'
            corpus_paths = @('.context/corpus/canary.md')
            storage_files = @('state.db')
        }
    }
    [IO.File]::WriteAllText($profile, ($profileData | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $tests.binding_injected = 'PASS'

    $enabledA = Invoke-Control -Operation 'repository.enable' -Extra @('-Alias', 'alpha')
    Assert-CodeScope ($enabledA.exit_code -eq 0 -and $enabledA.json.status -eq 'PASS') 'first alias enabled'
    Assert-CodeScope (Test-Path -LiteralPath $runtime -PathType Leaf) 'managed runtime materialized for binding alias'
    $runtimeOwned = $true
    $bridge = Get-Content -Raw -LiteralPath $runtime | ConvertFrom-Json
    Assert-BridgeRepositories -Bridge $bridge -Expected $expectedAlpha
    Assert-BridgeBindings -Bridge $bridge -Expected $expectedAlpha
    Assert-SessionAccess -Bridge $bridge
    $tests.binding_enabled_alias_root = 'PASS'

    $enabledB = Invoke-Control -Operation 'repository.enable' -Extra @('-Alias', 'beta')
    Assert-CodeScope ($enabledB.exit_code -eq 0 -and $enabledB.json.status -eq 'PASS') 'second alias enabled'
    Assert-CodeScope (Test-Path -LiteralPath $runtime -PathType Leaf) 'managed runtime materialized for enabled aliases'
    $bridge = Get-Content -Raw -LiteralPath $runtime | ConvertFrom-Json
    Assert-BridgeRepositories -Bridge $bridge -Expected $expectedBoth
    Assert-BridgeBindings -Bridge $bridge -Expected $expectedAlpha
    Assert-SessionAccess -Bridge $bridge
    $tests.both_enabled_exact_roots = 'PASS'
    $tests.session_access = 'PASS'

    $disabledA = Invoke-Control -Operation 'repository.disable' -Extra @('-Alias', 'alpha')
    Assert-CodeScope ($disabledA.exit_code -eq 0 -and $disabledA.json.status -eq 'PASS') 'first alias disabled'
    $bridge = Get-Content -Raw -LiteralPath $runtime | ConvertFrom-Json
    Assert-BridgeRepositories -Bridge $bridge -Expected $expectedBeta
    Assert-BridgeBindings -Bridge $bridge -Expected ([ordered]@{})
    Assert-SessionAccess -Bridge $bridge
    $tests.disable_excludes_alias = 'PASS'

    $removedA = Invoke-Control -Operation 'repository.remove' -Extra @('-Alias', 'alpha')
    Assert-CodeScope ($removedA.exit_code -eq 0 -and $removedA.json.filesystem_deleted -eq $false) 'disabled alias removed from profile only'
    Assert-CodeScope (Test-Path -LiteralPath $sentinelA -PathType Leaf) 'removed alias files are preserved'
    $bridge = Get-Content -Raw -LiteralPath $runtime | ConvertFrom-Json
    Assert-BridgeRepositories -Bridge $bridge -Expected $expectedBeta
    Assert-BridgeBindings -Bridge $bridge -Expected ([ordered]@{})
    $tests.remove_excludes_alias = 'PASS'

    $blocked = Invoke-Control -Operation 'repository.remove' -Extra @('-Alias', 'beta')
    Assert-CodeScope ($blocked.exit_code -ne 0 -and $blocked.json.error_code -eq 'REPOSITORY_ACTIVE') 'active alias removal rejected'
    Assert-CodeScope (Test-Path -LiteralPath $sentinelB -PathType Leaf) 'active alias rejection preserves files'
    $bridge = Get-Content -Raw -LiteralPath $runtime | ConvertFrom-Json
    Assert-BridgeRepositories -Bridge $bridge -Expected $expectedBeta
    $tests.remove_active_blocked = 'PASS'

    $disabledB = Invoke-Control -Operation 'repository.disable' -Extra @('-Alias', 'beta')
    Assert-CodeScope ($disabledB.exit_code -eq 0 -and $disabledB.json.status -eq 'PASS') 'second alias disabled'
    Assert-CodeScope (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) 'runtime removed when no aliases remain enabled'
    $removedB = Invoke-Control -Operation 'repository.remove' -Extra @('-Alias', 'beta')
    Assert-CodeScope ($removedB.exit_code -eq 0 -and $removedB.json.filesystem_deleted -eq $false) 'second alias removed from profile only'
    Assert-CodeScope (Test-Path -LiteralPath $sentinelB -PathType Leaf) 'second alias files are preserved'
    Assert-CodeScope (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) 'runtime stays absent after final removal'
    $tests.final_runtime_empty = 'PASS'
} finally {
    if ($runtimeOwned -and (Test-Path -LiteralPath $runtime -PathType Leaf)) { Remove-Item -LiteralPath $runtime -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $profile -PathType Leaf) { Remove-Item -LiteralPath $profile -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}

Assert-CodeScope (-not (Test-Path -LiteralPath $profile -PathType Leaf)) 'test profile cleaned'
Assert-CodeScope (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) 'managed runtime cleaned'
Assert-CodeScope (-not (Test-Path -LiteralPath $scratch)) 'scratch repositories cleaned'
$tests.cleanup = 'PASS'
[ordered]@{
    status = 'PASS'
    paths = [ordered]@{ profile = $profile; runtime = $runtime; scratch = $scratch }
    tests = $tests
} | ConvertTo-Json -Compress
