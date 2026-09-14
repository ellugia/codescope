$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $workspace 'scripts\codescope-launch.ps1'
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source

function Assert-CodeScope($Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
}

function Get-CodeScopeHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($launcher, [ref]$tokens, [ref]$parseErrors) | Out-Null
Assert-CodeScope ($parseErrors.Count -eq 0) 'launcher PowerShell AST parsed cleanly'

$profile = Join-Path $workspace 'config\managed\profile.json'
$runtime = Join-Path $workspace 'config\managed\runtime.bridge.json'
$profileHash = Get-CodeScopeHash $profile
$runtimeHash = Get-CodeScopeHash $runtime
$beforePids = @(Get-Process -Name 'tunnel-client' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$output = @()
$exitCode = $null
Push-Location $env:TEMP
try {
    $output = @(& $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File $launcher -Once 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = [int]$LASTEXITCODE
} finally {
    Pop-Location
}

Assert-CodeScope ($exitCode -eq 0) 'once mode completed without starting the tunnel'
$jsonLine = @($output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
Assert-CodeScope ($jsonLine.Count -eq 1) 'once mode emitted one JSON result'
$result = $jsonLine[0] | ConvertFrom-Json
Assert-CodeScope ($result.status -eq 'PASS' -and $result.mode -eq 'once' -and $result.action -eq 'NOT_STARTED') 'once mode reported a read-only PASS'
Assert-CodeScope ((Get-CodeScopeHash $profile) -eq $profileHash) 'managed profile remained unchanged'
Assert-CodeScope ((Get-CodeScopeHash $runtime) -eq $runtimeHash) 'managed runtime config remained unchanged'
$afterPids = @(Get-Process -Name 'tunnel-client' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$newPids = @($afterPids | Where-Object { $beforePids -notcontains $_ })
Assert-CodeScope ($newPids.Count -eq 0) 'once mode left no new tunnel-client process'

[ordered]@{ status = 'PASS'; parser = 'PASS'; once = 'PASS'; cwd_independent = 'PASS'; no_new_tunnel_process = 'PASS' } | ConvertTo-Json -Compress
