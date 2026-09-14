[CmdletBinding()]
param(
    [switch]$ConfirmRollback,
    [string]$PidFile
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($PidFile)) {
    $PidFile = Join-Path $workspace 'deps\tunnel-client\run\tunnel-client.pid'
}
if (-not $ConfirmRollback) {
    Write-Output 'BLOCKED: rollback es explícito. Revisa el túnel/app y repite con -ConfirmRollback.'
    exit 2
}

$stopScript = Join-Path $PSScriptRoot 'tunnel-stop.ps1'
& $stopScript -PidFile $PidFile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Output 'STOP: transport process termination requested. Child graceful lifecycle remains NOT_RUN; sample/profile and credentials were left untouched.'
Write-Output 'Manual account rollback, if needed: remove or disable the ChatGPT app and tunnel in their respective UIs after review.'
