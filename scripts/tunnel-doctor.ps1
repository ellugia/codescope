[CmdletBinding()]
param(
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$binary = Join-Path $workspace 'deps\tunnel-client\v0.0.10-windows-amd64\tunnel-client.exe'
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $workspace 'deps\tunnel-client\tunnel-client.sample.yaml'
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
