$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$control = Join-Path $workspace 'scripts\codescope-control.ps1'
$managed = Join-Path $workspace 'config\managed'
$profile = Join-Path $managed "codex-discovery-$PID.json"
$scratch = Join-Path ([IO.Path]::GetTempPath()) "CodeScope codex discovery-$PID"
$codexHome = Join-Path $scratch '.codex'
$repoA = Join-Path $scratch 'alpha-repo'
$repoB = Join-Path $scratch 'beta-repo'
$oldCodexHome = $env:CODEX_HOME

function Assert-CodeScope {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Invoke-Control {
    $output = @(& $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $control -Operation 'repository.discover-codex' -ProfilePath $profile -Json 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = [int]$LASTEXITCODE
    Assert-CodeScope ($output.Count -gt 0) 'discovery returned no output'
    return [pscustomobject]@{ exit_code = $exitCode; json = ($output[-1] | ConvertFrom-Json) }
}

try {
    New-Item -ItemType Directory -Force -Path $codexHome, $repoA, $repoB | Out-Null
    $pathA = $repoA.Replace('\', '/')
    $pathB = $repoB.Replace('\', '/')
    @"
[projects.'$pathA']
trust_level = "trusted"

[projects."$pathB"]
trust_level = "trusted"

[projects.'$pathA']
trust_level = "trusted"

[unrelated]
value = "ignored"
"@ | Set-Content -LiteralPath (Join-Path $codexHome 'config.toml') -Encoding UTF8

    $env:CODEX_HOME = $codexHome
    $result = Invoke-Control
    Assert-CodeScope ($result.exit_code -eq 0 -and $result.json.status -eq 'PASS') 'discovery passed'
    Assert-CodeScope ($result.json.config_exists -eq $true) 'Codex config is reported as present'
    $candidates = @($result.json.candidates)
    Assert-CodeScope ($candidates.Count -eq 2) 'only unique project sections were returned'
    Assert-CodeScope ((@($candidates | Where-Object { $_.available -eq $true })).Count -eq 2) 'existing folders are available'
    Assert-CodeScope ((@($candidates | Where-Object { $_.suggested_alias -match '^(alpha-repo|beta-repo)$' })).Count -eq 2) 'safe aliases were suggested'
    Assert-CodeScope ((@($candidates | Where-Object { $_.is_git -eq $false })).Count -eq 2) 'Git detection is explicit and does not reject ordinary folders'
    [ordered]@{ status = 'PASS'; candidates = $candidates.Count; deduplicated = $true; config_read_only = $true } | ConvertTo-Json -Compress
} finally {
    if ($null -eq $oldCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $oldCodexHome }
    Remove-Item -LiteralPath $profile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $managed 'runtime.bridge.json') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
