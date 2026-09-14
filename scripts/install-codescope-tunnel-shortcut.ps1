[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Workspace,
    [string]$ShortcutPath,
    [ValidatePattern('^tunnel_[a-z0-9]{32}$')]
    [string]$TunnelId,
    [string]$PwshPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($TunnelId)) {
    throw 'Especifica -TunnelId con el identificador del túnel autorizado.'
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
$Workspace = [IO.Path]::GetFullPath($Workspace)
if ([string]::IsNullOrWhiteSpace($PwshPath)) {
    $current = Join-Path $PSHOME 'pwsh.exe'
    $command = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $PwshPath = if ($PSVersionTable.PSVersion.Major -ge 7 -and (Test-Path -LiteralPath $current -PathType Leaf)) { $current } elseif ($null -ne $command) { [string]$command.Path } else { $null }
}
if ([string]::IsNullOrWhiteSpace($PwshPath)) {
    throw 'PowerShell 7 no está disponible; especifica -PwshPath con una ruta absoluta.'
}
$PwshPath = [IO.Path]::GetFullPath($PwshPath)
if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
    $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodeScope — Iniciar túnel.lnk'
}
$ShortcutPath = [IO.Path]::GetFullPath($ShortcutPath)
$launcher = [IO.Path]::GetFullPath((Join-Path $Workspace 'scripts\tunnel-connect-interactive.ps1'))

foreach ($path in @($Workspace, $PwshPath, $launcher)) {
    if (-not (Test-Path -LiteralPath $path -PathType $(if ($path -eq $Workspace) { 'Container' } else { 'Leaf' }))) {
        throw "Shortcut input not found: $path"
    }
}

$versionOutput = (& $PwshPath -NoProfile -Command '$PSVersionTable.PSVersion.Major' 2>$null | Out-String).Trim()
$versionExit = [int]$LASTEXITCODE
$major = 0
if ($versionExit -ne 0 -or -not [int]::TryParse($versionOutput, [ref]$major) -or $major -lt 7) {
    throw "Validated runtime is not PowerShell 7+: $PwshPath"
}

$targetPath = [IO.Path]::GetFullPath($PwshPath)
$arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "{0}" -TunnelId "{1}"' -f $launcher, $TunnelId
$existing = $null
$existingShell = $null
if (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) {
    $existingShell = New-Object -ComObject WScript.Shell
    $existing = $existingShell.CreateShortcut($ShortcutPath)
    $existingTarget = if ([string]::IsNullOrWhiteSpace($existing.TargetPath)) { $null } else { [IO.Path]::GetFullPath($existing.TargetPath) }
    if ($existingTarget -ine $targetPath -or $existing.Arguments -ne $arguments -or $existing.WorkingDirectory -ine $Workspace) {
        throw "Refusing to overwrite an existing shortcut with a different target: $ShortcutPath"
    }
}
if ($PSCmdlet.ShouldProcess($ShortcutPath, 'create visible CodeScope tunnel shortcut')) {
    $shell = if ($null -ne $existingShell) { $existingShell } else { New-Object -ComObject WScript.Shell }
    try {
        if ($null -eq $existing) {
            $shortcut = $shell.CreateShortcut($ShortcutPath)
            $shortcut.TargetPath = $targetPath
            $shortcut.Arguments = $arguments
            $shortcut.WorkingDirectory = $Workspace
            $shortcut.Description = 'CodeScope — iniciar el túnel manualmente en PowerShell 7'
            $shortcut.IconLocation = "$PwshPath,0"
            $shortcut.Save()
        }
    } finally {
        if ($null -ne $shortcut) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
        if ($null -ne $shell) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
        $existing = $null
        $existingShell = $null
    }
    $status = 'PASS'
} else {
    $status = 'WHATIF'
}

[ordered]@{
    status = $status
    shortcut = $ShortcutPath
    target = $targetPath
    arguments = $arguments
    working_directory = $Workspace
    launcher = $launcher
    tunnel_id = $TunnelId
    powershell_major = $major
    automatic_start = $false
    service = $false
    scheduled_task = $false
} | ConvertTo-Json -Compress
