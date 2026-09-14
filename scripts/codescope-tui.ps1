[CmdletBinding()]
param(
    [switch]$Once,
    [string]$ControlPath
)

$ErrorActionPreference = 'Stop'
$script:Workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:ControlPath = if ([string]::IsNullOrWhiteSpace($ControlPath)) {
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'codescope-control.ps1'))
} else {
    [IO.Path]::GetFullPath($ControlPath)
}
$script:ProtocolFailure = $false
$script:OutputLimit = 262144

function Resolve-CodeScopePwsh {
    $candidate = Join-Path $PSHOME 'pwsh.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return [IO.Path]::GetFullPath($candidate)
    }
    $command = Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
        return [IO.Path]::GetFullPath($command.Source)
    }
    throw 'No se encontró PowerShell 7 para ejecutar el control.'
}

function Get-UiProperty {
    param(
        [AllowNull()]$Object,
        [Parameter(Mandatory = $true)][string[]]$Names
    )

    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property) { return $property.Value }
    }
    return $null
}

function Limit-UiText {
    param(
        [AllowNull()][string]$Text,
        [int]$Maximum = 400
    )

    if ($null -eq $Text) { return '' }
    if ($Text.Length -le $Maximum) { return $Text }
    return $Text.Substring(0, $Maximum) + '…'
}

function New-CodeScopeProtocolFailure {
    param(
        [Parameter(Mandatory = $true)][string]$ErrorCode,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $script:ProtocolFailure = $true
    return [pscustomobject]@{
        ProtocolFailure = $true
        ErrorCode = $ErrorCode
        Message = $Message
        Response = $null
    }
}

function Invoke-CodeScopeControl {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('status', 'list', 'repository.discover-codex', 'repository.add', 'repository.remove', 'repository.enable', 'repository.disable', 'optional_backend.enable', 'optional_backend.disable', 'stack.start', 'stack.stop')][string]$Operation,
        [AllowNull()][string]$Alias,
        [AllowNull()][string]$Root,
        [AllowNull()][ValidateSet('codebase_memory', 'context_mode')][string]$Backend,
        [bool]$Enable = $false
    )

    $pwsh = Resolve-CodeScopePwsh
    $quoteArgument = { param([string]$Value) '"{0}"' -f $Value.Replace('"', '\"') }
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        # The workspace path has no spaces; leaving it unquoted keeps Start-Process
        # compatible with both PowerShell 5.1 and PowerShell 7.
        '-File', $script:ControlPath,
        '-Operation', $Operation,
        '-Json'
    )
    if (-not [string]::IsNullOrWhiteSpace($Alias)) { $arguments += @('-Alias', (& $quoteArgument $Alias)) }
    if (-not [string]::IsNullOrWhiteSpace($Root)) { $arguments += @('-Root', (& $quoteArgument $Root)) }
    if (-not [string]::IsNullOrWhiteSpace($Backend)) { $arguments += @('-Backend', $Backend) }
    if ($Enable) { $arguments += '-Enable' }

    $suffix = [Guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) "codescope-tui-control-$PID-$suffix.out"
    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) "codescope-tui-control-$PID-$suffix.err"
    $process = $null
    try {
        $process = Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $script:Workspace -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
        # ponytail: bound the UI call; temp files avoid a descendant keeping a pipe open.
        if (-not $process.WaitForExit(75000)) {
            try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
            try { $process.WaitForExit(5000) | Out-Null } catch { }
            return New-CodeScopeProtocolFailure -ErrorCode 'control_timeout' -Message 'El control no respondió dentro del tiempo permitido.'
        }
        $stdoutLines = if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) {
            @(Get-Content -LiteralPath $stdoutPath | ForEach-Object { [string]$_ })
        } else { @() }
        $stdout = ($stdoutLines -join "`n")
        if ($stdout.Length -gt $script:OutputLimit) {
            return New-CodeScopeProtocolFailure -ErrorCode 'control_output_limit' -Message 'La respuesta del control supera el límite permitido.'
        }
        $json = $stdout.Trim()
        if ([string]::IsNullOrWhiteSpace($json)) {
            return New-CodeScopeProtocolFailure -ErrorCode 'control_empty_response' -Message 'El control no devolvió una respuesta JSON.'
        }
        try {
            # ConvertFrom-Json in Windows PowerShell 5.1 has no -Depth parameter.
            $response = $json | ConvertFrom-Json
        } catch {
            return New-CodeScopeProtocolFailure -ErrorCode 'control_invalid_json' -Message 'El control devolvió JSON inválido.'
        }
        if ($null -eq $response -or $response -is [array]) {
            return New-CodeScopeProtocolFailure -ErrorCode 'control_invalid_response' -Message 'El control no devolvió un objeto JSON.'
        }
        if ($null -eq $response.PSObject.Properties['status']) {
            return New-CodeScopeProtocolFailure -ErrorCode 'control_missing_status' -Message 'La respuesta del control no contiene status.'
        }
        return [pscustomobject]@{
            ProtocolFailure = $false
            ErrorCode = $null
            Message = $null
            Response = $response
        }
    } catch {
        return New-CodeScopeProtocolFailure -ErrorCode 'control_protocol_failure' -Message 'Falló la comunicación con el control.'
    } finally {
        if ($null -ne $process) { $process.Dispose() }
        Remove-Item -LiteralPath $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-CodeScopeCatalogEntries {
    param([Parameter(Mandatory = $true)]$Response)

    $candidate = Get-UiProperty -Object $Response -Names @('catalog', 'repositories', 'entries')
    if ($null -eq $candidate) { return @() }
    $nested = Get-UiProperty -Object $candidate -Names @('repositories', 'entries')
    if ($null -ne $nested) { $candidate = $nested }

    $items = [Collections.Generic.List[object]]::new()
    if ($candidate -is [Collections.IDictionary]) {
        foreach ($key in $candidate.Keys) {
            $items.Add([pscustomobject]@{ alias = [string]$key; value = $candidate[$key] })
        }
    } elseif ($candidate -is [Collections.IEnumerable] -and $candidate -isnot [string]) {
        foreach ($item in $candidate) { $items.Add($item) }
    } else {
        foreach ($property in @($candidate.PSObject.Properties)) {
            $items.Add([pscustomobject]@{ alias = $property.Name; value = $property.Value })
        }
    }
    return @($items)
}

function Format-UiBoolean {
    param([AllowNull()]$Value)

    if ($null -eq $Value) { return 'desconocido' }
    if ($Value -isnot [bool]) { return 'desconocido' }
    if ($Value) { return 'sí' }
    return 'no'
}

function Get-CodeScopeOptionalBackend {
    param(
        [AllowNull()][Parameter(Mandatory = $true)]$Response,
        [Parameter(Mandatory = $true)][string]$Backend
    )

    $optional = Get-UiProperty -Object $Response -Names @('optional_backends', 'optionalBackends')
    $entry = if ($null -ne $optional) { Get-UiProperty -Object $optional -Names @($Backend) } else { $null }
    return [pscustomobject]@{
        backend = $Backend
        available = ($null -ne $entry)
        enabled = if ($null -ne $entry) { Get-UiProperty -Object $entry -Names @('enabled') } else { $null }
        configured = if ($null -ne $entry) { Get-UiProperty -Object $entry -Names @('configured') } else { $null }
    }
}

function Show-CodeScopeOptionalBackends {
    param([Parameter(Mandatory = $true)]$Response)

    $optional = Get-UiProperty -Object $Response -Names @('optional_backends', 'optionalBackends')
    if ($null -eq $optional) {
        Write-Output '  Integraciones opcionales: desconocido (el control no informa optional_backends).'
        return
    }

    Write-Output '  Integraciones opcionales:'
    foreach ($backend in @('codebase_memory', 'context_mode')) {
        $state = Get-CodeScopeOptionalBackend -Response $Response -Backend $backend
        Write-Output ('    {0}: enabled={1} | configured={2}' -f $backend, (Format-UiBoolean $state.enabled), (Format-UiBoolean $state.configured))
    }
}

function Show-CodeScopeCatalog {
    param(
        [Parameter(Mandatory = $true)]$Response,
        [switch]$ShowPaths
    )

    $entries = @(Get-CodeScopeCatalogEntries -Response $Response)
    if ($entries.Count -eq 0) {
        Write-Output 'No hay repositorios en el catálogo.'
        return
    }
    $visibleCount = [Math]::Min($entries.Count, 100)
    for ($index = 0; $index -lt $visibleCount; $index++) {
        $item = $entries[$index]
        $value = Get-UiProperty -Object $item -Names @('value', 'entry')
        $entry = if ($null -ne $value) { $value } else { $item }
        $alias = Get-UiProperty -Object $item -Names @('alias', 'name', 'id')
        if ([string]::IsNullOrWhiteSpace([string]$alias)) { $alias = Get-UiProperty -Object $entry -Names @('alias', 'name', 'id') }
        if ([string]::IsNullOrWhiteSpace([string]$alias)) { $alias = '(sin alias)' }
        $root = Get-UiProperty -Object $entry -Names @('root', 'path', 'directory')
        $enabled = Get-UiProperty -Object $entry -Names @('enabled', 'active')
        $rootText = if ($ShowPaths -and -not [string]::IsNullOrWhiteSpace([string]$root)) { [string]$root } else { '(oculta)' }
        Write-Output ('  {0} | activo: {1} | raíz: {2}' -f $alias, (Format-UiBoolean $enabled), $rootText)
    }
    if ($entries.Count -gt $visibleCount) { Write-Output ('  … {0} repositorios omitidos por límite de salida.' -f ($entries.Count - $visibleCount)) }
}

function Show-CodeScopeSafeFields {
    param(
        [AllowNull()]$Object,
        [int]$Depth = 0
    )

    if ($null -eq $Object -or $Depth -gt 2) { return }
    if ($Object -is [string] -or $Object -is [ValueType]) {
        Write-Output ('  {0}' -f (Limit-UiText ([string]$Object)))
        return
    }
    $propertyCount = 0
    foreach ($property in @($Object.PSObject.Properties)) {
        if ($propertyCount -ge 40) { Write-Output '  … campos omitidos por límite de salida.'; break }
        $name = [string]$property.Name
        if ($name -match '(?i)(path|root|directory|profile|config|secret|token|key|password|credential|commandline|environment)') { continue }
        $propertyCount++
        $value = $property.Value
        if ($null -eq $value) {
            Write-Output ('  {0}: (vacío)' -f $name)
        } elseif ($value -is [string] -or $value -is [ValueType]) {
            Write-Output ('  {0}: {1}' -f $name, (Limit-UiText ([string]$value)))
        } elseif ($value -is [Collections.IEnumerable]) {
            Write-Output ('  {0}: lista ({1} elementos)' -f $name, @($value).Count)
        } elseif ($Depth -lt 2) {
            Write-Output ('  {0}:' -f $name)
            Show-CodeScopeSafeFields -Object $value -Depth ($Depth + 1)
        }
    }
}

function Show-CodeScopeResult {
    param(
        [Parameter(Mandatory = $true)]$Invocation,
        [switch]$ShowRepositories,
        [switch]$ShowLifecycle,
        [switch]$ShowPaths
    )

    if ($Invocation.ProtocolFailure) {
        Write-Output ('ERROR DE CONTROL [{0}]: {1}' -f $Invocation.ErrorCode, $Invocation.Message)
        return
    }
    $response = $Invocation.Response
    $status = Get-UiProperty -Object $response -Names @('status')
    Write-Output ('Estado: {0}' -f (Limit-UiText ([string]$status) 120))
    $errorCode = Get-UiProperty -Object $response -Names @('error_code', 'errorCode')
    $message = Get-UiProperty -Object $response -Names @('message', 'detail')
    if (-not [string]::IsNullOrWhiteSpace([string]$errorCode)) { Write-Output ('Código: {0}' -f (Limit-UiText ([string]$errorCode) 120)) }
    if (-not [string]::IsNullOrWhiteSpace([string]$message)) { Write-Output ('Mensaje: {0}' -f (Limit-UiText ([string]$message))) }
    $restartRequired = Get-UiProperty -Object $response -Names @('restart_required', 'restartRequired')
    if ($null -ne $restartRequired) {
        $restartText = if ([bool]$restartRequired) { 'sí' } else { 'no' }
        Write-Output ('Reinicio del puente necesario: {0}' -f $restartText)
    }
    $contextMode = Get-UiProperty -Object $response -Names @('context_mode')
    if ($null -ne $contextMode) {
        $contextStatus = Get-UiProperty -Object $contextMode -Names @('status')
        $contextReason = Get-UiProperty -Object $contextMode -Names @('reason')
        $contextText = if (-not [string]::IsNullOrWhiteSpace([string]$contextReason)) { '{0} ({1})' -f $contextStatus, $contextReason } else { [string]$contextStatus }
        Write-Output ('Context Mode: {0}' -f (Limit-UiText $contextText 160))
    }
    Show-CodeScopeOptionalBackends -Response $response
    if ($ShowRepositories) {
        Show-CodeScopeCatalog -Response $response -ShowPaths:$ShowPaths
    }
    if ($ShowLifecycle) {
        $lifecycle = Get-UiProperty -Object $response -Names @('lifecycle', 'lifecycle_info', 'lifecycle_result')
        if ($null -eq $lifecycle) { $lifecycle = Get-UiProperty -Object $response -Names @('data') }
        Write-Output 'Resultado del ciclo de vida:'
        Show-CodeScopeSafeFields -Object $lifecycle
    }
    if ([string]::IsNullOrWhiteSpace([string]$message) -and [string]::IsNullOrWhiteSpace([string]$errorCode) -and $null -eq $restartRequired -and -not $ShowRepositories -and -not $ShowLifecycle) {
        Write-Output 'La operación terminó sin mensaje adicional.'
    }
}

function Read-CodeScopeAlias {
    $value = Read-Host 'Alias (Enter cancela)'
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { return '' }
    return ([string]$value).Trim()
}

function Invoke-CodeScopeAdd {
    $alias = Read-Host 'Alias nuevo (Enter cancela)'
    if ($null -eq $alias -or [string]::IsNullOrWhiteSpace([string]$alias)) { Write-Output 'Operación cancelada.'; return }
    $root = Read-Host 'Raíz absoluta (Enter cancela)'
    if ($null -eq $root -or [string]::IsNullOrWhiteSpace([string]$root)) { Write-Output 'Operación cancelada.'; return }
    $root = ([string]$root).Trim()
    if (-not [IO.Path]::IsPathFullyQualified($root)) { Write-Output 'La raíz debe ser una ruta absoluta. Operación cancelada.'; return }
    $enableAnswer = Read-Host '¿Activar ahora? [s/N]'
    $enable = ([string]$enableAnswer).Trim() -match '^(s|si|sí|y|yes)$'
    Show-CodeScopeResult -Invocation (Invoke-CodeScopeControl -Operation 'repository.add' -Alias ([string]$alias).Trim() -Root $root -Enable $enable)
}

function Invoke-CodeScopeCodexImport {
    $discovery = Invoke-CodeScopeControl -Operation 'repository.discover-codex'
    if ($discovery.ProtocolFailure) {
        Show-CodeScopeResult -Invocation $discovery
        return
    }
    $response = $discovery.Response
    $candidates = @((Get-UiProperty -Object $response -Names @('candidates')))
    $eligible = @($candidates | Where-Object { $_.available -eq $true -and $_.already_registered -ne $true })
    if ($eligible.Count -eq 0) {
        Write-Output 'No hay proyectos de Codex disponibles para añadir.'
        if ($response.config_exists -ne $true) { Write-Output ('No se encontró config.toml en {0}.' -f $response.config_path) }
        return
    }

    $selected = [Collections.Generic.HashSet[int]]::new()
    while ($true) {
        Write-Output ''
        Write-Output ('Proyectos encontrados en {0}:' -f $response.config_path)
        for ($index = 0; $index -lt $eligible.Count; $index++) {
            $mark = if ($selected.Contains($index)) { 'x' } else { ' ' }
            $candidate = $eligible[$index]
            $kind = if ($candidate.is_git) { 'Git' } else { 'carpeta' }
            Write-Output ('  [{0}] {1}. {2} | {3} | {4}' -f $mark, ($index + 1), $candidate.suggested_alias, $kind, $candidate.path)
        }
        $answer = Read-Host 'Escribe números para marcar/desmarcar; A acepta; Enter cancela'
        if ([string]::IsNullOrWhiteSpace([string]$answer)) { Write-Output 'Operación cancelada.'; return }
        if ([string]$answer -match '^(?i:a|aceptar|listo)$') {
            if ($selected.Count -eq 0) { Write-Output 'No se seleccionó ningún proyecto.'; return }
            break
        }
        $tokens = @([string]$answer -split '[,;\s]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $valid = $true
        foreach ($token in $tokens) {
            $number = 0
            if (-not [int]::TryParse($token, [ref]$number) -or $number -lt 1 -or $number -gt $eligible.Count) {
                Write-Output ('Índice no válido: {0}' -f $token)
                $valid = $false
                continue
            }
            $zeroBased = $number - 1
            if ($selected.Contains($zeroBased)) { [void]$selected.Remove($zeroBased) } else { [void]$selected.Add($zeroBased) }
        }
        if (-not $valid) { Write-Output 'Corrige los índices y vuelve a intentarlo.' }
    }

    foreach ($index in @($selected | Sort-Object)) {
        $candidate = $eligible[$index]
        $alias = Read-Host ('Alias para {0} (Enter = {1})' -f $candidate.path, $candidate.suggested_alias)
        if ([string]::IsNullOrWhiteSpace([string]$alias)) { $alias = [string]$candidate.suggested_alias }
        $enableAnswer = Read-Host ('¿Activar {0} ahora? [s/N]' -f $alias)
        $enable = ([string]$enableAnswer).Trim() -match '^(s|si|sí|y|yes)$'
        Show-CodeScopeResult -Invocation (Invoke-CodeScopeControl -Operation 'repository.add' -Alias ([string]$alias).Trim() -Root ([string]$candidate.path) -Enable $enable)
    }
}

function Invoke-CodeScopeAliasOperation {
    param([Parameter(Mandatory = $true)][string]$Operation)

    $alias = Read-CodeScopeAlias
    if ([string]::IsNullOrWhiteSpace([string]$alias)) { Write-Output 'Operación cancelada.'; return }
    Show-CodeScopeResult -Invocation (Invoke-CodeScopeControl -Operation $Operation -Alias $alias)
}

function Write-CodeScopeHeader {
    param(
        [string]$Screen = 'MENU',
        [string]$SelectedChoice = ''
    )

    $separator = '=' * 64
    Write-Output $separator
    Write-Output 'CodeScope | puente/tunel local'
    Write-Output ('Pantalla: {0}' -f $Screen.ToUpperInvariant())
    if ([string]::IsNullOrWhiteSpace($SelectedChoice)) {
        Write-Output 'Opcion actual: -'
    } else {
        Write-Output ('Opcion actual: [{0}]' -f $SelectedChoice)
    }
    Write-Output $separator
}

function Show-CodeScopePersistentStatus {
    param([Parameter(Mandatory = $true)]$Invocation)

    Write-Output 'Estado persistente:'
    if ($Invocation.ProtocolFailure) {
        Write-Output '  Tunel: no disponible'
        Write-Output ('  ERROR DE CONTROL [{0}]: {1}' -f $Invocation.ErrorCode, $Invocation.Message)
        return
    }

    $response = $Invocation.Response
    $lifecycle = [string](Get-UiProperty -Object $response -Names @('lifecycle'))
    $active = Get-UiProperty -Object $response -Names @('active')
    $tunnelState = if ($active -eq $true -or $lifecycle -match '(?i)running|active') {
        'ACTIVO'
    } elseif ($active -eq $false -or $lifecycle -match '(?i)stopped|inactive') {
        'PARADO'
    } else {
        'DESCONOCIDO'
    }

    $entries = @(Get-CodeScopeCatalogEntries -Response $response)
    $activeCount = 0
    foreach ($item in $entries) {
        $value = Get-UiProperty -Object $item -Names @('value', 'entry')
        $entry = if ($null -ne $value) { $value } else { $item }
        if ((Get-UiProperty -Object $entry -Names @('enabled', 'active')) -eq $true) { $activeCount++ }
    }

    $configVersion = Get-UiProperty -Object $response -Names @('config_version', 'configVersion')
    if ($null -eq $configVersion) { $configVersion = 'n/d' }
    $autodiscovery = if ((Get-UiProperty -Object $response -Names @('optional_autodiscovery', 'optionalAutodiscovery')) -eq $true) { 'si' } else { 'no' }
    $defaultRepository = [string](Get-UiProperty -Object $response -Names @('default_repository', 'defaultRepository'))
    if ([string]::IsNullOrWhiteSpace($defaultRepository)) { $defaultRepository = 'ninguno' }

    Write-Output ('  Tunel: {0}' -f $tunnelState)
    Write-Output ('  Repositorios activos: {0}/{1}' -f $activeCount, $entries.Count)
    Write-Output ('  Configuracion: version {0} | autodeteccion: {1} | predeterminado: {2}' -f $configVersion, $autodiscovery, $defaultRepository)
    Show-CodeScopeOptionalBackends -Response $response
}

function Wait-CodeScopeMenu {
    [void](Read-Host "`nPulsa Enter para volver al menú")
}

function New-CodeScopeMenuItem {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Label,
        [int]$Legacy = 0
    )
    return [pscustomobject]@{ Id = $Id; Label = $Label; Legacy = $Legacy }
}

function Show-CodeScopeMenu {
    param(
        [Parameter(Mandatory = $true)][object[]]$Items,
        [int]$SelectedIndex = 0,
        [Parameter(Mandatory = $true)]$StatusInvocation,
        [string]$Screen = 'MENU'
    )

    try { Clear-Host } catch { }
    $selectedLabel = if ($Items.Count -gt 0 -and $SelectedIndex -ge 0 -and $SelectedIndex -lt $Items.Count) { $Items[$SelectedIndex].Label } else { '' }
    Write-CodeScopeHeader -Screen $Screen -SelectedChoice $selectedLabel
    Show-CodeScopePersistentStatus -Invocation $StatusInvocation
    Write-Output ('-' * 64)
    for ($index = 0; $index -lt $Items.Count; $index++) {
        $marker = if ($index -eq $SelectedIndex) { '>' } else { ' ' }
        Write-Output ('{0} {1}. {2}' -f $marker, ($index + 1), $Items[$index].Label)
    }
    Write-Output ('-' * 64)
    Write-Output 'Arriba/abajo mover  Enter entrar/seleccionar  Esc volver'
}

function Read-CodeScopeMenuChoice {
    param(
        [Parameter(Mandatory = $true)][object[]]$Items,
        [Parameter(Mandatory = $true)]$StatusInvocation,
        [string]$Screen = 'MENU'
    )

    if ($Items.Count -eq 0) { return -1 }
    $selected = 0
    while ($true) {
        Show-CodeScopeMenu -Items $Items -SelectedIndex $selected -StatusInvocation $StatusInvocation -Screen $Screen
        $redirected = $false
        try { $redirected = [Console]::IsInputRedirected } catch { $redirected = $true }
        if ($redirected) {
            $answer = Read-Host 'Selecciona por número (solo respaldo)'
            if ($null -eq $answer -or [string]::IsNullOrWhiteSpace([string]$answer)) { return -1 }
            $number = 0
            if (-not [int]::TryParse(([string]$answer).Trim(), [ref]$number)) {
                Write-Output 'Opción no válida.'
                continue
            }
            $legacy = @($Items | Where-Object { $_.Legacy -eq $number })
            if ($legacy.Count -gt 0) { return [array]::IndexOf($Items, $legacy[0]) }
            if ($number -ge 1 -and $number -le $Items.Count) { return ($number - 1) }
            Write-Output 'Opción no válida.'
            continue
        }

        try { $key = [Console]::ReadKey($true) } catch {
            $answer = Read-Host 'Selecciona por número (solo respaldo)'
            $number = 0
            if ([int]::TryParse(([string]$answer).Trim(), [ref]$number)) {
                $legacy = @($Items | Where-Object { $_.Legacy -eq $number })
                if ($legacy.Count -gt 0) { return [array]::IndexOf($Items, $legacy[0]) }
                if ($number -ge 1 -and $number -le $Items.Count) { return ($number - 1) }
            }
            return -1
        }
        switch ($key.Key) {
            'UpArrow' { $selected = if ($selected -eq 0) { $Items.Count - 1 } else { $selected - 1 } }
            'DownArrow' { $selected = if ($selected -eq ($Items.Count - 1)) { 0 } else { $selected + 1 } }
            'Enter' { return $selected }
            'Escape' { return -1 }
            'LeftArrow' { return -1 }
        }
    }
}

function Invoke-CodeScopeRepositoryMenu {
    while ($true) {
        $status = Invoke-CodeScopeControl -Operation 'status'
        $items = @(
            (New-CodeScopeMenuItem -Id 'list' -Label 'Listar repositorios' -Legacy 2),
            (New-CodeScopeMenuItem -Id 'add' -Label 'Añadir repositorio manualmente' -Legacy 3),
            (New-CodeScopeMenuItem -Id 'codex' -Label 'Añadir repositorios desde Codex' -Legacy 4),
            (New-CodeScopeMenuItem -Id 'enable' -Label 'Activar repositorio' -Legacy 5),
            (New-CodeScopeMenuItem -Id 'disable' -Label 'Desactivar repositorio' -Legacy 6),
            (New-CodeScopeMenuItem -Id 'remove' -Label 'Eliminar repositorio' -Legacy 7),
            (New-CodeScopeMenuItem -Id 'back' -Label 'Volver' -Legacy 0)
        )
        $choice = Read-CodeScopeMenuChoice -Items $items -StatusInvocation $status -Screen 'REPOSITORIOS'
        if ($choice -lt 0 -or $items[$choice].Id -eq 'back') { return }
        switch ($items[$choice].Id) {
            'list' { Show-CodeScopeResult -Invocation (Invoke-CodeScopeControl -Operation 'list') -ShowRepositories -ShowPaths }
            'add' { Invoke-CodeScopeAdd }
            'codex' { Invoke-CodeScopeCodexImport }
            'enable' { Invoke-CodeScopeAliasOperation -Operation 'repository.enable' }
            'disable' { Invoke-CodeScopeAliasOperation -Operation 'repository.disable' }
            'remove' {
                Write-Output 'Eliminar solo quita el repositorio del perfil; nunca borra su directorio.'
                Invoke-CodeScopeAliasOperation -Operation 'repository.remove'
            }
        }
        Wait-CodeScopeMenu
    }
}

function Invoke-CodeScopeOptionalMenu {
    while ($true) {
        $status = Invoke-CodeScopeControl -Operation 'status'
        $cbm = Get-CodeScopeOptionalBackend -Response $(if ($status.ProtocolFailure) { $null } else { $status.Response }) -Backend 'codebase_memory'
        $ctx = Get-CodeScopeOptionalBackend -Response $(if ($status.ProtocolFailure) { $null } else { $status.Response }) -Backend 'context_mode'
        $cbmLabel = if ($cbm.enabled -eq $true) { 'Desactivar Codebase Memory' } elseif ($cbm.enabled -eq $false) { 'Activar Codebase Memory' } else { 'Cambiar Codebase Memory' }
        $ctxLabel = if ($ctx.enabled -eq $true) { 'Desactivar Context Mode' } elseif ($ctx.enabled -eq $false) { 'Activar Context Mode' } else { 'Cambiar Context Mode' }
        $items = @(
            (New-CodeScopeMenuItem -Id 'cbm' -Label $cbmLabel),
            (New-CodeScopeMenuItem -Id 'context' -Label $ctxLabel),
            (New-CodeScopeMenuItem -Id 'back' -Label 'Volver')
        )
        $choice = Read-CodeScopeMenuChoice -Items $items -StatusInvocation $status -Screen 'INTEGRACIONES OPCIONALES'
        if ($choice -lt 0 -or $items[$choice].Id -eq 'back') { return }
        $selected = $items[$choice].Id
        $backend = if ($selected -eq 'cbm') { 'codebase_memory' } else { 'context_mode' }
        $state = if ($selected -eq 'cbm') { $cbm } else { $ctx }
        $operation = if ($state.enabled -eq $true) { 'optional_backend.disable' } else { 'optional_backend.enable' }
        Show-CodeScopeResult -Invocation (Invoke-CodeScopeControl -Operation $operation -Backend $backend)
        Wait-CodeScopeMenu
    }
}

function Invoke-CodeScopeTunnelMenu {
    while ($true) {
        $status = Invoke-CodeScopeControl -Operation 'status'
        $items = @(
            (New-CodeScopeMenuItem -Id 'start' -Label 'Arrancar puente/túnel' -Legacy 8),
            (New-CodeScopeMenuItem -Id 'stop' -Label 'Parar puente/túnel' -Legacy 9),
            (New-CodeScopeMenuItem -Id 'back' -Label 'Volver')
        )
        $choice = Read-CodeScopeMenuChoice -Items $items -StatusInvocation $status -Screen 'PUENTE / TÚNEL'
        if ($choice -lt 0 -or $items[$choice].Id -eq 'back') { return }
        if ($items[$choice].Id -eq 'start') {
            Write-Output 'Esperando que el túnel confirme salud y disponibilidad local...'
            Show-CodeScopeResult -Invocation (Invoke-CodeScopeControl -Operation 'stack.start') -ShowLifecycle
        } else {
            Show-CodeScopeResult -Invocation (Invoke-CodeScopeControl -Operation 'stack.stop') -ShowLifecycle
        }
        Wait-CodeScopeMenu
    }
}

try {
    if ($Once) {
        $status = Invoke-CodeScopeControl -Operation 'status'
        Show-CodeScopeResult -Invocation $status -ShowLifecycle
        $list = Invoke-CodeScopeControl -Operation 'list'
        Show-CodeScopeResult -Invocation $list -ShowRepositories
        exit $(if ($status.ProtocolFailure -or $list.ProtocolFailure) { 1 } else { 0 })
    }

    while ($true) {
        $status = Invoke-CodeScopeControl -Operation 'status'
        $items = @(
            (New-CodeScopeMenuItem -Id 'status' -Label 'Ver estado' -Legacy 1),
            (New-CodeScopeMenuItem -Id 'repositories' -Label 'Repositorios' -Legacy 2),
            (New-CodeScopeMenuItem -Id 'optional' -Label 'Integraciones opcionales' -Legacy 3),
            (New-CodeScopeMenuItem -Id 'tunnel' -Label 'Puente / túnel' -Legacy 8),
            (New-CodeScopeMenuItem -Id 'exit' -Label 'Salir' -Legacy 10)
        )
        $choice = Read-CodeScopeMenuChoice -Items $items -StatusInvocation $status -Screen 'MENU'
        if ($choice -lt 0 -or $items[$choice].Id -eq 'exit') { exit $(if ($script:ProtocolFailure) { 1 } else { 0 }) }
        switch ($items[$choice].Id) {
            'status' { Show-CodeScopeResult -Invocation (Invoke-CodeScopeControl -Operation 'status') -ShowLifecycle; Wait-CodeScopeMenu }
            'repositories' { Invoke-CodeScopeRepositoryMenu }
            'optional' { Invoke-CodeScopeOptionalMenu }
            'tunnel' { Invoke-CodeScopeTunnelMenu }
        }
    }
} catch [System.Management.Automation.PipelineStoppedException] {
    Write-Output "`nOperación cancelada."
    exit 0
} catch [System.OperationCanceledException] {
    Write-Output "`nOperación cancelada."
    exit 0
} catch {
    Write-Output ('ERROR DE INICIO: {0}' -f (Limit-UiText $_.Exception.Message 500))
    exit 1
}
