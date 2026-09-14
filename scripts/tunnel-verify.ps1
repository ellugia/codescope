[CmdletBinding()]
param(
    [string]$ClientRoot
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'tunnel-runtime.ps1')
if ([string]::IsNullOrWhiteSpace($ClientRoot)) {
    $client = Resolve-CodeScopeTunnelClient -Workspace $workspace
    $ClientRoot = Resolve-CodeScopeTunnelRoot -Workspace $workspace -ClientPath $client
}
$root = [IO.Path]::GetFullPath($ClientRoot)
$metadataPath = Join-Path $root 'release-metadata.json'
$sumsPath = Join-Path $root 'SHA256SUMS.txt'
$urlsPath = Join-Path $root 'PUBLIC_URLS.txt'

foreach ($path in @($metadataPath, $sumsPath, $urlsPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Verification input not found: $path" }
}
$metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
$zip = Join-Path $root $metadata.artifact
$exe = Join-Path $root $metadata.extractedBinary
if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw "Artifact not found: $zip" }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Executable not found: $exe" }

$sums = Get-Content -Raw -LiteralPath $sumsPath
$urls = Get-Content -Raw -LiteralPath $urlsPath
if ($sums -notmatch [regex]::Escape($metadata.artifactSha256)) { throw 'Official SHA256SUMS does not contain the recorded artifact hash.' }
if ($urls -notmatch [regex]::Escape($metadata.artifact)) { throw 'PUBLIC_URLS does not contain the recorded artifact name.' }
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
$exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
if ($zipHash -ne $metadata.artifactSha256) { throw "Artifact hash mismatch: $zipHash" }
if ($exeHash -ne $metadata.extractedBinarySha256) { throw "Executable hash mismatch: $exeHash" }
$version = (& $exe --version | Out-String).Trim()
if ($version -ne $metadata.versionOutput) { throw "Version output mismatch: $version" }

[pscustomobject]@{
    status = 'PASS'
    source = $metadata.source
    release = $metadata.release
    releaseCommit = $metadata.releaseCommit
    artifact = $metadata.artifact
    artifactSha256 = $zipHash
    extractedBinary = $metadata.extractedBinary
    extractedBinarySha256 = $exeHash
    version = $version
} | ConvertTo-Json -Compress
