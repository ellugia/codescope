$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$control = Join-Path $workspace 'scripts\codescope-control.ps1'
$managed = Join-Path $workspace 'config\managed'
$profile = Join-Path $managed "test-context-mode-auto-$PID.json"
$scratch = Join-Path ([IO.Path]::GetTempPath()) "CodeScope context-mode auto test-$PID"
$repo = Join-Path $scratch 'repo'
$repoWithSession = Join-Path $scratch 'repo-with-session'
$repoWithoutDatabase = Join-Path $scratch 'repo-without-database'
$storage = Join-Path $scratch 'context-mode'
$oldContextModeDir = [Environment]::GetEnvironmentVariable('CONTEXT_MODE_DIR', 'Process')

function Assert-CodeScope {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Get-ContextModeHash {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $canonical = ([IO.Path]::GetFullPath($ProjectRoot)).Replace('\', '/').TrimEnd('/').ToLowerInvariant()
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)) } finally { $algorithm.Dispose() }
    return (-join ($bytes | ForEach-Object { $_.ToString('x2') })).Substring(0, 16)
}

function Invoke-Control {
    param([Parameter(Mandatory = $true)][string]$Operation, [string[]]$Extra = @())
    $output = @(& $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $control -Operation $Operation -ProfilePath $profile -Json @Extra 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = [int]$LASTEXITCODE
    Assert-CodeScope ($output.Count -gt 0) "control returned no output for $Operation"
    return [pscustomobject]@{ exit_code = $exitCode; json = ($output[-1] | ConvertFrom-Json) }
}

try {
    New-Item -ItemType Directory -Force -Path $repo, $repoWithSession, $repoWithoutDatabase, (Join-Path $storage 'content'), (Join-Path $storage 'sessions') | Out-Null
    $hash = Get-ContextModeHash -ProjectRoot $repo
    $database = Join-Path $storage "content\$hash.db"
    [IO.File]::WriteAllBytes($database, [Text.Encoding]::UTF8.GetBytes('automatic-binding'))
    [Environment]::SetEnvironmentVariable('CONTEXT_MODE_DIR', $storage, 'Process')

    $bound = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', 'auto', '-Root', $repo)
    Assert-CodeScope ($bound.exit_code -eq 0 -and $bound.json.context_mode.status -eq 'BOUND') 'matching Context Mode database is bound automatically'
    Assert-CodeScope ([string]$bound.json.context_mode.storage -ieq $storage) 'automatic binding uses the configured Context Mode root'
    Assert-CodeScope (@($bound.json.context_mode.storage_files) -contains "content/$hash.db") 'automatic binding contains only the matching project database'

    $sessionCanonical = ([IO.Path]::GetFullPath($repoWithSession)).Replace('\', '/').TrimEnd('/').ToLowerInvariant()
    $sessionSha = [Security.Cryptography.SHA256]::Create()
    try { $sessionDigest = $sessionSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sessionCanonical)) } finally { $sessionSha.Dispose() }
    $sessionHash = (-join ($sessionDigest | ForEach-Object { $_.ToString('x2') })).Substring(0, 16)
    $sessionDatabase = Join-Path $storage "sessions\$sessionHash.db"
    [IO.File]::WriteAllBytes($sessionDatabase, [Text.Encoding]::UTF8.GetBytes('automatic-session-binding'))
    $sessionBound = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', 'session', '-Root', $repoWithSession)
    Assert-CodeScope ($sessionBound.exit_code -eq 0 -and $sessionBound.json.context_mode.status -eq 'BOUND') 'matching Context Mode session database is bound automatically'
    Assert-CodeScope ($sessionBound.json.context_mode.reason -eq 'project_session_database_found') 'session database is classified as timeline data'
    Assert-CodeScope (@($sessionBound.json.context_mode.storage_files) -contains "sessions/$sessionHash.db") 'automatic session binding is restricted to the matching database'

    $unbound = Invoke-Control -Operation 'repository.add' -Extra @('-Alias', 'missing', '-Root', $repoWithoutDatabase)
    Assert-CodeScope ($unbound.exit_code -eq 0 -and $unbound.json.context_mode.status -eq 'UNAVAILABLE') 'repository without matching database remains unbound'
    $profileData = Get-Content -Raw -LiteralPath $profile | ConvertFrom-Json -AsHashtable
    Assert-CodeScope ($profileData.optional_backends.bindings.ContainsKey('auto')) 'matching binding persisted in profile'
    Assert-CodeScope (-not $profileData.optional_backends.bindings.ContainsKey('missing')) 'unmatched repository does not receive an unrelated binding'
    Assert-CodeScope ($profileData.optional_backends.bindings.session.context_mode.query_mode -eq 'timeline') 'session binding persists timeline query mode'
    Assert-CodeScope ([string]$profileData.optional_backends.bindings.auto.context_mode.project_root -ieq $repo) 'binding is pinned to the repository root'
    [ordered]@{ status = 'PASS'; matching_database = 'BOUND'; session_database = 'BOUND'; unmatched_database = 'UNAVAILABLE'; storage_file = "content/$hash.db"; session_storage_file = "sessions/$sessionHash.db" } | ConvertTo-Json -Compress
} finally {
    [Environment]::SetEnvironmentVariable('CONTEXT_MODE_DIR', $oldContextModeDir, 'Process')
    Remove-Item -LiteralPath $profile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $managed 'runtime.bridge.json') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
