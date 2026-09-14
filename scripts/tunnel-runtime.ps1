function Resolve-CodeScopeTunnelClient {
    param([Parameter(Mandatory = $true)][string]$Workspace)

    $candidate = if ([string]::IsNullOrWhiteSpace($env:CODESCOPE_TUNNEL_CLIENT_PATH)) {
        Join-Path $Workspace 'deps\tunnel-client\v0.0.10-windows-amd64\tunnel-client.exe'
    } else {
        $env:CODESCOPE_TUNNEL_CLIENT_PATH
    }
    if (-not [IO.Path]::IsPathFullyQualified($candidate)) { throw 'CODESCOPE_TUNNEL_CLIENT_PATH must be an absolute path.' }
    return [IO.Path]::GetFullPath($candidate)
}

function Resolve-CodeScopeTunnelRunDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [string]$Candidate,
        [string]$ClientPath
    )

    if (-not [string]::IsNullOrWhiteSpace($Candidate)) { return [IO.Path]::GetFullPath($Candidate) }
    if (-not [string]::IsNullOrWhiteSpace($env:CODESCOPE_TUNNEL_RUN_DIR)) {
        if (-not [IO.Path]::IsPathFullyQualified($env:CODESCOPE_TUNNEL_RUN_DIR)) { throw 'CODESCOPE_TUNNEL_RUN_DIR must be an absolute path.' }
        return [IO.Path]::GetFullPath($env:CODESCOPE_TUNNEL_RUN_DIR)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODESCOPE_TUNNEL_CLIENT_PATH)) {
        return [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ClientPath) 'run'))
    }
    return [IO.Path]::GetFullPath((Join-Path $Workspace 'deps\tunnel-client\run'))
}

function Resolve-CodeScopeTunnelRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Workspace,
        [string]$ClientPath
    )

    if (-not [string]::IsNullOrWhiteSpace($env:CODESCOPE_TUNNEL_CLIENT_ROOT)) {
        if (-not [IO.Path]::IsPathFullyQualified($env:CODESCOPE_TUNNEL_CLIENT_ROOT)) { throw 'CODESCOPE_TUNNEL_CLIENT_ROOT must be an absolute path.' }
        return [IO.Path]::GetFullPath($env:CODESCOPE_TUNNEL_CLIENT_ROOT)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODESCOPE_TUNNEL_CLIENT_PATH)) {
        throw 'CODESCOPE_TUNNEL_CLIENT_ROOT is required when the tunnel client is external.'
    }
    return [IO.Path]::GetFullPath((Join-Path $Workspace 'deps\tunnel-client'))
}

function Resolve-CodeScopeTunnelSampleConfig {
    param([Parameter(Mandatory = $true)][string]$Workspace)

    if (-not [string]::IsNullOrWhiteSpace($env:CODESCOPE_TUNNEL_SAMPLE_CONFIG)) {
        if (-not [IO.Path]::IsPathFullyQualified($env:CODESCOPE_TUNNEL_SAMPLE_CONFIG)) { throw 'CODESCOPE_TUNNEL_SAMPLE_CONFIG must be an absolute path.' }
        return [IO.Path]::GetFullPath($env:CODESCOPE_TUNNEL_SAMPLE_CONFIG)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODESCOPE_TUNNEL_CLIENT_PATH)) { return $null }
    return [IO.Path]::GetFullPath((Join-Path $Workspace 'deps\tunnel-client\tunnel-client.sample.yaml'))
}
