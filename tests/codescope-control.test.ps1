$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$control = Join-Path $workspace 'scripts\codescope-control.ps1'
$managed = Join-Path $workspace 'config\managed'
$profile = Join-Path $managed "test-$PID.json"
$runtime = Join-Path $managed 'runtime.bridge.json'
$fixture = Join-Path $workspace 'config\fixture.json'
$fixtureHash = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
$scratch = Join-Path ([IO.Path]::GetTempPath()) "CodeScope control test-$PID"
$repo = Join-Path $scratch 'repo'
$sentinel = Join-Path $repo 'must-survive.txt'
$tests = [ordered]@{}

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

try {
    New-Item -ItemType Directory -Force -Path $repo | Out-Null
    Set-Content -LiteralPath $sentinel -Value 'keep' -Encoding UTF8
    $missing = Invoke-Control -Operation 'list'
    Assert-CodeScope ($missing.exit_code -eq 0 -and $missing.json.status -eq 'PASS') 'missing profile listed safely'
    Assert-CodeScope ($missing.json.session_access -eq 'session_select') 'list exposes session access mode'
    Assert-CodeScope ($missing.json.optional_autodiscovery -eq $true) 'list exposes optional autodiscovery default'
    $tests.list_empty = 'PASS'

    $invalid = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', '../escape', '-Root', $repo)
    Assert-CodeScope ($invalid.exit_code -ne 0 -and $invalid.json.error_code -eq 'ALIAS_INVALID') 'invalid alias rejected'
    $tests.invalid_alias = 'PASS'

    $added = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', 'demo', '-Root', $repo)
    Assert-CodeScope ($added.exit_code -eq 0 -and $added.json.status -eq 'PASS') 'repository added disabled'
    $tests.add_disabled = 'PASS'

    $enabled = Invoke-Control -Operation 'repository.enable' -Extra @('-Alias', 'demo')
    Assert-CodeScope ($enabled.exit_code -eq 0 -and $enabled.json.status -eq 'PASS') 'repository enabled'
    Assert-CodeScope (Test-Path -LiteralPath $runtime -PathType Leaf) 'managed bridge config materialized'
    $bridge = Get-Content -Raw -LiteralPath $runtime | ConvertFrom-Json
    Assert-CodeScope ($bridge.session_access.mode -eq 'session_select') 'managed bridge requires session selection'
    Assert-CodeScope ($bridge.session_access.require_session -eq $true) 'managed bridge requires a session'
    Assert-CodeScope ($bridge.optional_backends.auto_discover -eq $true) 'managed bridge enables optional integration autodiscovery'
    $ttlSeconds = 0
    [void][int]::TryParse([string]$bridge.session_access.ttl_seconds, [ref]$ttlSeconds)
    Assert-CodeScope ($ttlSeconds -gt 0) 'managed bridge session TTL is positive'
    $tests.enable = 'PASS'
    $tests.session_access = 'PASS'
    $tests.optional_autodiscovery = 'PASS'

    $profileData = Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json -AsHashtable
    $profileData.optional_backends.bindings['demo'] = [ordered]@{
        context_mode = [ordered]@{
            enabled = $true
            read_only = $true
            scope = 'synthetic'
            project = 'invalid-scope'
            project_root = $repo
            storage = (Join-Path $scratch 'outside-storage')
            session_id = 'invalid-scope'
            source = 'invalid-scope'
            corpus_paths = @('corpus/canary.md')
            storage_files = @('state.db')
        }
    }
    [IO.File]::WriteAllText($profile, ($profileData | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $invalidBinding = Invoke-Control -Operation 'list'
    Assert-CodeScope ($invalidBinding.exit_code -ne 0 -and $invalidBinding.json.error_code -eq 'PROFILE_INVALID') 'Context Mode storage escape rejected by profile control'
    $profileData.optional_backends.bindings.Remove('demo')
    [IO.File]::WriteAllText($profile, ($profileData | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $tests.binding_scope_rejection = 'PASS'

    $profileData = Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json -AsHashtable
    $profileData.optional_backends.bindings['demo'] = [ordered]@{
        codebase_memory = [ordered]@{
            enabled = $true
            read_only = $true
            project = 'CodeScope-control-test'
            root = $repo
            allowed_paths = @('must-survive.txt')
        }
    }
    [IO.File]::WriteAllText($profile, ($profileData | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $toggleOff = Invoke-Control -Operation 'optional_backend.disable' -Extra @('-Backend', 'codebase_memory')
    Assert-CodeScope ($toggleOff.exit_code -eq 0 -and $toggleOff.json.optional_backends.codebase_memory.enabled -eq $false) 'Codebase Memory can be disabled'
    Assert-CodeScope ((Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json).optional_backends.codebase_memory_enabled -eq $false) 'Codebase Memory disabled state is persisted'
    $runtimeAfterDisable = Get-Content -Raw -LiteralPath $runtime | ConvertFrom-Json
    Assert-CodeScope ($null -eq $runtimeAfterDisable.optional_backends.bindings.demo) 'disabled Codebase Memory is absent from runtime bindings'
    $toggleOn = Invoke-Control -Operation 'optional_backend.enable' -Extra @('-Backend', 'codebase_memory')
    Assert-CodeScope ($toggleOn.exit_code -eq 0 -and $toggleOn.json.optional_backends.codebase_memory.enabled -eq $true) 'Codebase Memory can be enabled'
    Assert-CodeScope ((Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json).optional_backends.codebase_memory_enabled -eq $true) 'Codebase Memory enabled state is persisted'
    $runtimeAfterEnable = Get-Content -Raw -LiteralPath $runtime | ConvertFrom-Json
    Assert-CodeScope ($null -ne $runtimeAfterEnable.optional_backends.bindings.demo.codebase_memory) 'enabled Codebase Memory returns to runtime bindings'
    $profileData = Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json -AsHashtable
    $profileData.optional_backends.bindings.Remove('demo')
    [IO.File]::WriteAllText($profile, ($profileData | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $tests.optional_backend_toggles = 'PASS'

    $blockedRemove = Invoke-Control -Operation 'repository.remove' -Extra @('-Alias', 'demo')
    Assert-CodeScope ($blockedRemove.exit_code -ne 0 -and $blockedRemove.json.error_code -eq 'REPOSITORY_ACTIVE') 'enabled repository cannot be removed'
    Assert-CodeScope (Test-Path -LiteralPath $sentinel -PathType Leaf) 'blocked removal preserved files'
    $tests.remove_active_blocked = 'PASS'

    $disabled = Invoke-Control -Operation 'repository.disable' -Extra @('-Alias', 'demo')
    Assert-CodeScope ($disabled.exit_code -eq 0 -and $disabled.json.status -eq 'PASS') 'repository disabled'
    $removed = Invoke-Control -Operation 'repository.remove' -Extra @('-Alias', 'demo')
    Assert-CodeScope ($removed.exit_code -eq 0 -and $removed.json.filesystem_deleted -eq $false) 'repository removed from profile only'
    Assert-CodeScope (Test-Path -LiteralPath $sentinel -PathType Leaf) 'removal never deleted repository files'
    $tests.remove_preserves_files = 'PASS'

    $unknown = Invoke-Control -Operation 'repository.remove' -Extra @('-Alias', 'missing')
    Assert-CodeScope ($unknown.exit_code -ne 0 -and $unknown.json.error_code -eq 'REPOSITORY_UNKNOWN') 'unknown repository rejected'
    $tests.unknown_alias = 'PASS'

    $noStart = Invoke-Control -Operation 'stack.start'
    Assert-CodeScope ($noStart.exit_code -ne 0 -and $noStart.json.error_code -eq 'NO_ENABLED_REPOSITORIES') 'start without enabled repositories rejected'
    $tests.start_requires_enabled = 'PASS'

    $first = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', 'first', '-Root', $repo)
    Assert-CodeScope ($first.exit_code -eq 0) 'first duplicate-root candidate added'
    $duplicate = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', 'second', '-Root', $repo)
    Assert-CodeScope ($duplicate.exit_code -ne 0 -and $duplicate.json.error_code -eq 'DUPLICATE_ROOT') 'duplicate root rejected'
    $cleanupFirst = Invoke-Control -Operation 'repository.remove' -Extra @('-Alias', 'first')
    Assert-CodeScope ($cleanupFirst.exit_code -eq 0) 'duplicate-root candidate cleaned from profile'
    $tests.duplicate_root = 'PASS'

    $fixtureFinalHash = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
    Assert-CodeScope ($fixtureFinalHash -eq $fixtureHash) 'fixture config unchanged'
    $tests.fixture_unchanged = 'PASS'

    [ordered]@{ status = 'PASS'; tests = $tests } | ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $profile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $runtime -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
