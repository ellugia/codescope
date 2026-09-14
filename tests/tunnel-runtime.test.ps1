$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $workspace 'scripts\tunnel-runtime.ps1')

$savedClient = [Environment]::GetEnvironmentVariable('CODESCOPE_TUNNEL_CLIENT_PATH', 'Process')
$savedRoot = [Environment]::GetEnvironmentVariable('CODESCOPE_TUNNEL_CLIENT_ROOT', 'Process')
$savedRun = [Environment]::GetEnvironmentVariable('CODESCOPE_TUNNEL_RUN_DIR', 'Process')
try {
    $env:CODESCOPE_TUNNEL_CLIENT_PATH = 'C:\external\tunnel-client.exe'
    $env:CODESCOPE_TUNNEL_CLIENT_ROOT = $null
    $env:CODESCOPE_TUNNEL_RUN_DIR = $null

    $client = Resolve-CodeScopeTunnelClient -Workspace $workspace
    if ($client -ine 'C:\external\tunnel-client.exe') { throw 'external client override was ignored' }
    try {
        Resolve-CodeScopeTunnelRoot -Workspace $workspace -ClientPath $client | Out-Null
        throw 'external client root was accepted without verification metadata'
    } catch {
        if ($_.Exception.Message -notmatch 'CLIENT_ROOT is required') { throw }
    }

    $env:CODESCOPE_TUNNEL_CLIENT_ROOT = 'C:\external\verified'
    $env:CODESCOPE_TUNNEL_RUN_DIR = 'C:\external\state'
    if ((Resolve-CodeScopeTunnelRoot -Workspace $workspace -ClientPath $client) -ine 'C:\external\verified') { throw 'external root override was ignored' }
    if ((Resolve-CodeScopeTunnelRunDirectory -Workspace $workspace -ClientPath $client) -ine 'C:\external\state') { throw 'external run directory override was ignored' }
    [pscustomobject]@{ status = 'PASS'; external_client = 'PASS'; verified_root_required = 'PASS'; run_directory = 'PASS' } | ConvertTo-Json -Compress
} finally {
    [Environment]::SetEnvironmentVariable('CODESCOPE_TUNNEL_CLIENT_PATH', $savedClient, 'Process')
    [Environment]::SetEnvironmentVariable('CODESCOPE_TUNNEL_CLIENT_ROOT', $savedRoot, 'Process')
    [Environment]::SetEnvironmentVariable('CODESCOPE_TUNNEL_RUN_DIR', $savedRun, 'Process')
}
