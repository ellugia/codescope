[CmdletBinding()]
param(
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'tunnel-runtime.ps1')
$binary = Resolve-CodeScopeTunnelClient -Workspace $workspace
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Resolve-CodeScopeTunnelSampleConfig -Workspace $workspace
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    throw 'ConfigPath is required when the tunnel client is external.'
}
$config = [IO.Path]::GetFullPath($ConfigPath)

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "Portable tunnel-client not found: $binary"
}
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    throw "Config not found: $config"
}

& $binary doctor --config $config --json --explain --health.listen-addr '127.0.0.1:0'
$exitCode = $LASTEXITCODE
Write-Output "doctor exit code: $exitCode"
exit $exitCode
