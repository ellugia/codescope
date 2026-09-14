[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'list', 'repository.discover-codex', 'repository.add', 'repository.remove', 'repository.enable', 'repository.disable', 'optional_backend.enable', 'optional_backend.disable', 'stack.start', 'stack.stop')]
    [string]$Operation,
    [string]$Alias,
    [string]$Root,
    [string]$ProfilePath,
    [ValidateSet('codebase_memory', 'context_mode')]
    [string]$Backend,
    [switch]$Enable,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$managedRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'config\managed'))
$defaultProfilePath = Join-Path $managedRoot 'profile.json'
$runtimeConfigPath = Join-Path $managedRoot 'runtime.bridge.json'
$runDirectory = [IO.Path]::GetFullPath((Join-Path $workspace 'deps\tunnel-client\run'))
$tunnelProfileDirectory = [IO.Path]::GetFullPath((Join-Path $runDirectory 'profiles'))
$tunnelProfilePath = [IO.Path]::GetFullPath((Join-Path $tunnelProfileDirectory 'codescope.yaml'))
$pidPath = Join-Path $runDirectory 'tunnel-client.pid'
$runtimePath = Join-Path $runDirectory 'tunnel-client.runtime.json'
$healthPath = Join-Path $runDirectory 'health.url'
$aliasPattern = '^[a-z][a-z0-9_-]{0,31}$'

function Resolve-TunnelProfilePath {
    if (Test-Path -LiteralPath $tunnelProfilePath -PathType Leaf) { return $tunnelProfilePath }
    if (Test-Path -LiteralPath $tunnelProfileDirectory -PathType Container) {
        $candidate = Get-ChildItem -LiteralPath $tunnelProfileDirectory -Filter 'codescope*.yaml' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        if ($null -ne $candidate) { return [IO.Path]::GetFullPath($candidate.FullName) }
    }
    return $tunnelProfilePath
}

function Throw-ControlError {
    param([Parameter(Mandatory = $true)][string]$Code, [Parameter(Mandatory = $true)][string]$Message)
    $error = [Exception]::new($Message)
    $error.Data['Code'] = $Code
    throw $error
}

function Resolve-ManagedProfilePath {
    param([string]$Candidate)
    $selected = if ([string]::IsNullOrWhiteSpace($Candidate)) { $defaultProfilePath } else { [IO.Path]::GetFullPath($Candidate) }
    $prefix = $managedRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($selected -ine $managedRoot -and -not $selected.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        Throw-ControlError 'PROFILE_PATH_DENIED' 'El perfil debe estar dentro de config\managed.'
    }
    if ([IO.Path]::GetExtension($selected) -ine '.json') { Throw-ControlError 'PROFILE_PATH_DENIED' 'El perfil debe ser un archivo JSON.' }
    return $selected
}

function Ensure-ManagedDirectory {
    if (-not (Test-Path -LiteralPath $managedRoot -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $managedRoot | Out-Null
    }
}

function Test-BindingRelativePath {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or [IO.Path]::IsPathFullyQualified($Value)) { return $false }
    $normalized = $Value.Replace('\', '/')
    return -not ($normalized.StartsWith('/') -or $normalized -match '(^|/)\.\.(/|$)' -or $normalized -match '(^|/)\.$')
}

function Test-StrictChildPath {
    param([Parameter(Mandatory = $true)][string]$Parent, [Parameter(Mandatory = $true)][string]$Candidate)
    $parentFull = ([IO.Path]::GetFullPath($Parent)).TrimEnd('\', '/')
    $candidateFull = ([IO.Path]::GetFullPath($Candidate)).TrimEnd('\', '/')
    $prefix = $parentFull + [IO.Path]::DirectorySeparatorChar
    return $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-KnownContextModeStorageRoots {
    $candidates = [Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:CONTEXT_MODE_DIR) -and [IO.Path]::IsPathFullyQualified($env:CONTEXT_MODE_DIR)) {
        $candidates.Add($env:CONTEXT_MODE_DIR)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME) -and [IO.Path]::IsPathFullyQualified($env:CODEX_HOME)) {
        $candidates.Add((Join-Path $env:CODEX_HOME 'context-mode'))
    }
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    if (-not [string]::IsNullOrWhiteSpace($userProfile)) {
        $candidates.Add((Join-Path $userProfile '.context-mode'))
        $candidates.Add((Join-Path $userProfile '.codex\context-mode'))
        $candidates.Add((Join-Path $userProfile '.claude\context-mode'))
    }
    $roots = [Collections.Generic.List[string]]::new()
    foreach ($candidate in $candidates) {
        try {
            $normalized = ([IO.Path]::GetFullPath($candidate)).TrimEnd('\', '/')
            if (@($roots | Where-Object { $_ -ieq $normalized }).Count -eq 0) { $roots.Add($normalized) }
        } catch { }
    }
    return $roots.ToArray()
}

function Test-KnownContextModeStorageRoot {
    param([Parameter(Mandatory = $true)][string]$Candidate)
    try {
        $normalized = ([IO.Path]::GetFullPath($Candidate)).TrimEnd('\', '/')
        foreach ($root in @(Get-KnownContextModeStorageRoots)) {
            if ($root -ieq $normalized) { return $true }
        }
    } catch { }
    return $false
}

function Get-ContextModeProjectHash {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $canonical = ([IO.Path]::GetFullPath($ProjectRoot)).Replace('\', '/').TrimEnd('/').ToLowerInvariant()
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))
    } finally {
        $algorithm.Dispose()
    }
    return (-join ($digest | ForEach-Object { $_.ToString('x2') })).Substring(0, 16)
}

function Find-ContextModeBinding {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $hash = Get-ContextModeProjectHash -ProjectRoot $ProjectRoot
    foreach ($storage in @(Get-KnownContextModeStorageRoots)) {
        $storageItem = $null
        try { $storageItem = Get-Item -LiteralPath $storage -Force -ErrorAction Stop } catch { continue }
        if (-not $storageItem.PSIsContainer -or (($storageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { continue }

        $databaseKind = 'content'
        $database = Join-Path $storage "content\$hash.db"
        $databaseItem = $null
        try { $databaseItem = Get-Item -LiteralPath $database -Force -ErrorAction Stop } catch { }
        if ($null -eq $databaseItem -or $databaseItem.PSIsContainer -or (($databaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            $databaseKind = 'sessions'
            $database = Join-Path $storage "sessions\$hash.db"
            try { $databaseItem = Get-Item -LiteralPath $database -Force -ErrorAction Stop } catch { continue }
            if ($databaseItem.PSIsContainer -or (($databaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { continue }
        }

        $storageFiles = [Collections.Generic.List[string]]::new()
        $storageFiles.Add("$databaseKind/$hash.db")
        $safe = $true
        foreach ($suffix in @('-wal', '-shm')) {
            $sibling = "$database$suffix"
            if (-not (Test-Path -LiteralPath $sibling -PathType Leaf)) { continue }
            try {
                $siblingItem = Get-Item -LiteralPath $sibling -Force -ErrorAction Stop
                if ($siblingItem.PSIsContainer -or (($siblingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { $safe = $false; break }
            } catch { $safe = $false; break }
            $storageFiles.Add("$databaseKind/$hash.db$suffix")
        }
        if (-not $safe) { continue }

        return [ordered]@{
            status = 'BOUND'
            reason = if ($databaseKind -eq 'sessions') { 'project_session_database_found' } else { 'project_database_found' }
            storage = $storage
            storage_files = @($storageFiles.ToArray())
            binding = [ordered]@{
                context_mode = [ordered]@{
                    enabled = $true
                    read_only = $true
                    scope = 'bound'
                    query_mode = if ($databaseKind -eq 'sessions') { 'timeline' } else { 'relevance' }
                    project_root = $ProjectRoot
                    storage = $storage
                    storage_files = @($storageFiles.ToArray())
                }
            }
        }
    }
    return [ordered]@{ status = 'UNAVAILABLE'; reason = 'project_database_not_found'; storage = $null; storage_files = @(); binding = $null }
}

function Get-OptionalBindings {
    param(
        [Parameter(Mandatory = $true)]$Raw,
        [Parameter(Mandatory = $true)][Collections.IDictionary]$Repositories
    )

    $bindings = [ordered]@{}
    if (-not $Raw.ContainsKey('optional_backends') -or $null -eq $Raw.optional_backends) { return $bindings }
    $optional = $Raw.optional_backends
    if (-not ($optional -is [Collections.IDictionary])) { Throw-ControlError 'PROFILE_INVALID' 'optional_backends debe ser un objeto.' }
    if (-not $optional.ContainsKey('bindings') -or $null -eq $optional.bindings) { return $bindings }
    if (-not ($optional.bindings -is [Collections.IDictionary])) { Throw-ControlError 'PROFILE_INVALID' 'optional_backends.bindings debe ser un objeto.' }

    $bindingFields = @{
        codebase_memory = @('enabled', 'read_only', 'project', 'root', 'allowed_paths')
        context_mode = @('enabled', 'read_only', 'scope', 'project', 'project_root', 'storage', 'session_id', 'source', 'query_mode', 'corpus_paths', 'storage_files')
    }
    foreach ($entry in $optional.bindings.GetEnumerator()) {
        $alias = [string]$entry.Key
        if ($alias -notmatch $aliasPattern) { Throw-ControlError 'PROFILE_INVALID' "Alias de binding no válido: $alias" }
        if (-not $Repositories.Contains($alias)) { Throw-ControlError 'PROFILE_INVALID' "La binding $alias no tiene un repositorio configurado." }
        if ($null -eq $entry.Value -or -not ($entry.Value -is [Collections.IDictionary])) { Throw-ControlError 'PROFILE_INVALID' "La binding $alias debe ser un objeto." }

        $binding = [ordered]@{}
        foreach ($backendEntry in $entry.Value.GetEnumerator()) {
            $backend = [string]$backendEntry.Key
            if (-not $bindingFields.ContainsKey($backend)) { Throw-ControlError 'PROFILE_INVALID' "Backend no permitido en la binding ${alias}: $backend" }
            $value = $backendEntry.Value
            if ($null -eq $value -or -not ($value -is [Collections.IDictionary])) { Throw-ControlError 'PROFILE_INVALID' "La binding ${alias}.${backend} debe ser un objeto." }
            foreach ($field in $value.Keys) {
                if ($bindingFields[$backend] -notcontains [string]$field) { Throw-ControlError 'PROFILE_INVALID' "Campo no permitido en la binding ${alias}.${backend}: $field" }
            }
            if ($value.ContainsKey('enabled') -and $value.enabled -isnot [bool]) { Throw-ControlError 'PROFILE_INVALID' "enabled debe ser booleano en la binding ${alias}.${backend}." }
            if ($value.ContainsKey('read_only') -and $value.read_only -ne $true) { Throw-ControlError 'PROFILE_INVALID' "La binding ${alias}.${backend} debe ser de solo lectura." }
            $enabled = -not ($value.ContainsKey('enabled') -and $value.enabled -eq $false)

            if ($backend -eq 'codebase_memory') {
                if ($value.ContainsKey('project') -and [string]::IsNullOrWhiteSpace([string]$value.project)) { Throw-ControlError 'PROFILE_INVALID' "El proyecto CBM de la binding $alias no puede estar vacío." }
                if ($value.ContainsKey('root')) {
                    if ([string]::IsNullOrWhiteSpace([string]$value.root) -or -not [IO.Path]::IsPathFullyQualified([string]$value.root)) { Throw-ControlError 'PROFILE_INVALID' "La raíz CBM de la binding $alias debe ser absoluta." }
                    $bindingRoot = [IO.Path]::GetFullPath([string]$value.root).TrimEnd('\', '/')
                    $repositoryRoot = [IO.Path]::GetFullPath([string]$Repositories[$alias].root).TrimEnd('\', '/')
                    if ($bindingRoot -ine $repositoryRoot) { Throw-ControlError 'PROFILE_INVALID' "La raíz CBM de la binding $alias debe coincidir con la raíz del alias." }
                } elseif ($enabled) {
                    Throw-ControlError 'PROFILE_INVALID' "La binding CBM activa $alias debe declarar root."
                }
                if ($value.ContainsKey('allowed_paths')) {
                    if (-not ($value.allowed_paths -is [Collections.IList]) -or $value.allowed_paths.Count -lt 1 -or $value.allowed_paths.Count -gt 8) { Throw-ControlError 'PROFILE_INVALID' "allowed_paths no es válido en la binding $alias." }
                    foreach ($pathValue in $value.allowed_paths) { if (-not (Test-BindingRelativePath -Value ([string]$pathValue))) { Throw-ControlError 'PROFILE_INVALID' "allowed_paths contiene una ruta no segura en la binding $alias." } }
                }
                if ($enabled -and ([string]::IsNullOrWhiteSpace([string]$value.project))) { Throw-ControlError 'PROFILE_INVALID' "La binding CBM activa $alias debe declarar project." }
            } else {
                $knownStorage = $false
                if ($value.ContainsKey('project') -and [string]::IsNullOrWhiteSpace([string]$value.project)) { Throw-ControlError 'PROFILE_INVALID' "El proyecto Context Mode de la binding $alias no puede estar vacío." }
                if ($value.ContainsKey('project_root')) {
                    if ([string]::IsNullOrWhiteSpace([string]$value.project_root) -or -not [IO.Path]::IsPathFullyQualified([string]$value.project_root)) { Throw-ControlError 'PROFILE_INVALID' "project_root de la binding $alias debe ser absoluto." }
                    $projectRoot = [IO.Path]::GetFullPath([string]$value.project_root).TrimEnd('\', '/')
                    $repositoryRoot = [IO.Path]::GetFullPath([string]$Repositories[$alias].root).TrimEnd('\', '/')
                    if ($projectRoot -ine $repositoryRoot) {
                        Throw-ControlError 'PROFILE_INVALID' "project_root de la binding $alias debe coincidir con la raíz del alias."
                    }
                } elseif ($enabled) {
                    Throw-ControlError 'PROFILE_INVALID' "La binding Context Mode activa $alias debe declarar project_root."
                }
                if ($value.ContainsKey('storage')) {
                    if ([string]::IsNullOrWhiteSpace([string]$value.storage) -or -not [IO.Path]::IsPathFullyQualified([string]$value.storage)) { Throw-ControlError 'PROFILE_INVALID' "storage de la binding $alias debe ser absoluto." }
                    $storagePath = [IO.Path]::GetFullPath([string]$value.storage).TrimEnd('\', '/')
                    $knownStorage = Test-KnownContextModeStorageRoot -Candidate $storagePath
                    if ($value.ContainsKey('project_root') -and -not (Test-StrictChildPath -Parent ([string]$value.project_root) -Candidate ([string]$value.storage)) -and -not $knownStorage) {
                        Throw-ControlError 'PROFILE_INVALID' "storage de la binding $alias debe permanecer dentro de project_root."
                    }
                } elseif ($enabled) {
                    Throw-ControlError 'PROFILE_INVALID' "La binding Context Mode activa $alias debe declarar storage."
                }
                foreach ($field in @('corpus_paths', 'storage_files')) {
                    if (-not $value.ContainsKey($field)) { continue }
                    $minimum = if ($field -eq 'corpus_paths' -and $knownStorage) { 0 } else { 1 }
                    if (-not ($value[$field] -is [Collections.IList]) -or $value[$field].Count -lt $minimum -or $value[$field].Count -gt 8) { Throw-ControlError 'PROFILE_INVALID' "$field no es válido en la binding $alias." }
                    foreach ($pathValue in $value[$field]) { if (-not (Test-BindingRelativePath -Value ([string]$pathValue))) { Throw-ControlError 'PROFILE_INVALID' "$field contiene una ruta no segura en la binding $alias." } }
                }
                if ($enabled -and (-not $knownStorage) -and (-not $value.ContainsKey('corpus_paths') -or $value.corpus_paths.Count -lt 1)) {
                    Throw-ControlError 'PROFILE_INVALID' "La binding Context Mode activa $alias debe declarar corpus_paths."
                }
            }
            $binding[$backend] = $value
        }
        if ($binding.Count -eq 0) { Throw-ControlError 'PROFILE_INVALID' "La binding $alias debe enlazar Codebase Memory, Context Mode o ambos." }
        $bindings[$alias] = $binding
    }
    return $bindings
}

function Get-Profile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $empty = [ordered]@{ schema_version = 1; config_version = 0; optional_autodiscovery = $true; optional_backends = [ordered]@{ codebase_memory_enabled = $true; context_mode_enabled = $true; bindings = [ordered]@{} }; repositories = [ordered]@{}; default_repository = $null }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $empty }
    try { $raw = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable } catch { Throw-ControlError 'PROFILE_INVALID' 'El perfil no contiene JSON válido.' }
    if ($null -eq $raw -or -not ($raw -is [Collections.IDictionary])) { Throw-ControlError 'PROFILE_INVALID' 'El perfil debe ser un objeto JSON.' }
    $repositories = [ordered]@{}
    if ($raw.ContainsKey('repositories') -and $null -ne $raw.repositories) {
        if (-not ($raw.repositories -is [Collections.IDictionary])) { Throw-ControlError 'PROFILE_INVALID' 'repositories debe ser un objeto.' }
        foreach ($entry in $raw.repositories.GetEnumerator()) {
            $name = [string]$entry.Key
            if ($name -notmatch $aliasPattern) { Throw-ControlError 'PROFILE_INVALID' "Alias no válido: $name" }
            $value = $entry.Value
            if ($null -eq $value -or -not ($value -is [Collections.IDictionary]) -or [string]::IsNullOrWhiteSpace([string]$value.root)) {
                Throw-ControlError 'PROFILE_INVALID' "La entrada $name no tiene una raíz válida."
            }
            if ($value.read_only -ne $true) { Throw-ControlError 'PROFILE_INVALID' "La entrada $name debe ser de solo lectura." }
            $fullRoot = [IO.Path]::GetFullPath([string]$value.root)
            $enabled = if ($value.ContainsKey('enabled')) { [bool]$value.enabled } else { $false }
            foreach ($previous in $repositories.Values) {
                if ([IO.Path]::GetFullPath([string]$previous.root).TrimEnd('\', '/') -ieq $fullRoot.TrimEnd('\', '/')) {
                    Throw-ControlError 'DUPLICATE_ROOT' 'Dos alias no pueden apuntar a la misma raíz.'
                }
            }
            $repositories[$name] = [ordered]@{ root = $fullRoot; read_only = $true; enabled = $enabled }
        }
    }
    $version = 0
    if ($raw.ContainsKey('config_version')) { [void][int]::TryParse([string]$raw.config_version, [ref]$version) }
    $autoDiscover = $true
    if ($raw.ContainsKey('optional_autodiscovery')) {
        if ($raw.optional_autodiscovery -isnot [bool]) { Throw-ControlError 'PROFILE_INVALID' 'optional_autodiscovery debe ser booleano.' }
        $autoDiscover = [bool]$raw.optional_autodiscovery
    } elseif ($raw.ContainsKey('optional_backends') -and $raw.optional_backends -is [Collections.IDictionary] -and $raw.optional_backends.ContainsKey('auto_discover')) {
        if ($raw.optional_backends.auto_discover -isnot [bool]) { Throw-ControlError 'PROFILE_INVALID' 'optional_backends.auto_discover debe ser booleano.' }
        $autoDiscover = [bool]$raw.optional_backends.auto_discover
    }
    $default = if ($raw.ContainsKey('default_repository') -and $raw.default_repository) { [string]$raw.default_repository } else { $null }
    if ($null -ne $default -and -not $repositories.Contains($default)) { Throw-ControlError 'PROFILE_INVALID' 'default_repository no existe en repositories.' }
    $codebaseMemoryEnabled = $true
    $contextModeEnabled = $true
    if ($raw.ContainsKey('optional_backends') -and $null -ne $raw.optional_backends) {
        if (-not ($raw.optional_backends -is [Collections.IDictionary])) { Throw-ControlError 'PROFILE_INVALID' 'optional_backends debe ser un objeto.' }
        if ($raw.optional_backends.ContainsKey('codebase_memory_enabled')) {
            if ($raw.optional_backends.codebase_memory_enabled -isnot [bool]) { Throw-ControlError 'PROFILE_INVALID' 'optional_backends.codebase_memory_enabled debe ser booleano.' }
            $codebaseMemoryEnabled = [bool]$raw.optional_backends.codebase_memory_enabled
        }
        if ($raw.optional_backends.ContainsKey('context_mode_enabled')) {
            if ($raw.optional_backends.context_mode_enabled -isnot [bool]) { Throw-ControlError 'PROFILE_INVALID' 'optional_backends.context_mode_enabled debe ser booleano.' }
            $contextModeEnabled = [bool]$raw.optional_backends.context_mode_enabled
        }
    }
    $bindings = Get-OptionalBindings -Raw $raw -Repositories $repositories
    return [ordered]@{ schema_version = 1; config_version = $version; optional_autodiscovery = $autoDiscover; optional_backends = [ordered]@{ codebase_memory_enabled = $codebaseMemoryEnabled; context_mode_enabled = $contextModeEnabled; bindings = $bindings }; repositories = $repositories; default_repository = $default }
}

function Save-Profile {
    param([Parameter(Mandatory = $true)]$Profile, [Parameter(Mandatory = $true)][string]$Path)
    Ensure-ManagedDirectory
    $temporary = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $json = $Profile | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try { [IO.File]::Replace($temporary, $Path, $null) } catch { Move-Item -LiteralPath $temporary -Destination $Path -Force }
        } else {
            Move-Item -LiteralPath $temporary -Destination $Path -Force
        }
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Get-RepositoryRoot {
    param([Parameter(Mandatory = $true)][string]$Candidate)
    if (-not [IO.Path]::IsPathFullyQualified($Candidate)) { Throw-ControlError 'ROOT_INVALID' 'La raíz debe ser una ruta absoluta.' }
    try { $item = Get-Item -LiteralPath ([IO.Path]::GetFullPath($Candidate)) -Force -ErrorAction Stop } catch { Throw-ControlError 'ROOT_MISSING' 'La raíz no existe.' }
    if (-not $item.PSIsContainer) { Throw-ControlError 'ROOT_INVALID' 'La raíz debe ser un directorio.' }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Throw-ControlError 'ROOT_REPARSE_DENIED' 'No se aceptan directorios reparse o enlaces.' }
    return ([IO.Path]::GetFullPath($item.FullName)).TrimEnd('\', '/')
}

function Set-SelectedDefault {
    param([Parameter(Mandatory = $true)]$Profile)
    $enabled = @($Profile.repositories.GetEnumerator() | Where-Object { $_.Value.enabled })
    if ($null -eq $Profile.default_repository -or -not $Profile.repositories.Contains($Profile.default_repository) -or -not $Profile.repositories[$Profile.default_repository].enabled) {
        $Profile.default_repository = if ($enabled.Count -gt 0) { [string]$enabled[0].Key } else { $null }
    }
}

function Write-ManagedBridgeConfig {
    param([Parameter(Mandatory = $true)]$Profile)
    $repositories = [ordered]@{}
    $bindings = [ordered]@{}
    foreach ($entry in $Profile.repositories.GetEnumerator()) {
        if (-not $entry.Value.enabled) { continue }
        $root = Get-RepositoryRoot -Candidate ([string]$entry.Value.root)
        $repositories[$entry.Key] = [ordered]@{ root = $root; read_only = $true }
    }
    if ($repositories.Count -eq 0) {
        if (Test-Path -LiteralPath $runtimeConfigPath -PathType Leaf) { Remove-Item -LiteralPath $runtimeConfigPath -Force }
        return $false
    }
    $backendEnabled = @{
        codebase_memory = [bool]$Profile.optional_backends.codebase_memory_enabled
        context_mode = [bool]$Profile.optional_backends.context_mode_enabled
    }
    foreach ($entry in $Profile.optional_backends.bindings.GetEnumerator()) {
        if (-not $repositories.Contains($entry.Key)) { continue }
        $selected = [ordered]@{}
        foreach ($backendEntry in $entry.Value.GetEnumerator()) {
            $backend = [string]$backendEntry.Key
            if ($backendEnabled.ContainsKey($backend) -and -not $backendEnabled[$backend]) { continue }
            if ($backendEntry.Value.Contains('enabled') -and $backendEntry.Value.enabled -eq $false) { continue }
            $selected[$backend] = $backendEntry.Value
        }
        if ($selected.Count -gt 0) { $bindings[$entry.Key] = $selected }
    }
    $config = [ordered]@{
        git_binary = 'git'
        default_repository = [string]$Profile.default_repository
        repositories = $repositories
        optional_backends = [ordered]@{
            auto_discover = [bool]$Profile.optional_autodiscovery
            bindings = $bindings
        }
        session_access = [ordered]@{
            mode = 'session_select'
            require_session = $true
            ttl_seconds = 3600
        }
        limits = [ordered]@{
            max_response_bytes = 65536; max_file_bytes = 524288; max_entries = 200; max_matches = 100
            max_lines = 2000; max_depth = 6; max_git_output_bytes = 131072; max_diff_bytes = 2097152; timeout_ms = 15000
        }
    }
    $temporary = "$runtimeConfigPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    try {
        if (Test-Path -LiteralPath $runtimeConfigPath -PathType Leaf) {
            try { [IO.File]::Replace($temporary, $runtimeConfigPath, $null) } catch { Move-Item -LiteralPath $temporary -Destination $runtimeConfigPath -Force }
        } else { Move-Item -LiteralPath $temporary -Destination $runtimeConfigPath -Force }
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    return $true
}

function Get-Catalog {
    param([Parameter(Mandatory = $true)]$Profile)
    $items = [Collections.Generic.List[object]]::new()
    foreach ($entry in $Profile.repositories.GetEnumerator()) {
        $items.Add([ordered]@{ alias = [string]$entry.Key; root = [string]$entry.Value.root; read_only = $true; enabled = [bool]$entry.Value.enabled })
    }
    return ,$items.ToArray()
}

function Get-OptionalBackendState {
    param([Parameter(Mandatory = $true)]$Profile)
    $configured = @{ codebase_memory = $false; context_mode = $false }
    foreach ($entry in $Profile.optional_backends.bindings.GetEnumerator()) {
        foreach ($backend in @('codebase_memory', 'context_mode')) {
            if ($entry.Value.Contains($backend)) { $configured[$backend] = $true }
        }
    }
    return [ordered]@{
        codebase_memory = [ordered]@{ enabled = [bool]$Profile.optional_backends.codebase_memory_enabled; configured = [bool]$configured.codebase_memory }
        context_mode = [ordered]@{ enabled = [bool]$Profile.optional_backends.context_mode_enabled; configured = [bool]$configured.context_mode }
    }
}

function Get-CodexProjectAlias {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][hashtable]$Used
    )

    $leaf = [IO.Path]::GetFileName($Root.TrimEnd('\', '/'))
    $alias = ($leaf.ToLowerInvariant() -replace '[^a-z0-9_-]+', '-').Trim('-', '_')
    if ([string]::IsNullOrWhiteSpace($alias)) { $alias = 'repo' }
    if ($alias -notmatch '^[a-z]') { $alias = "repo-$alias" }
    $alias = $alias.Substring(0, [Math]::Min(32, $alias.Length))
    $base = $alias
    $suffix = 2
    while ($Used.ContainsKey($alias)) {
        $tail = "-$suffix"
        $prefixLength = [Math]::Max(1, 32 - $tail.Length)
        $alias = $base.Substring(0, [Math]::Min($prefixLength, $base.Length)) + $tail
        $suffix++
    }
    $Used[$alias] = $true
    return $alias
}

function Get-CodexConfigPath {
    $codexRoot = if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        [IO.Path]::GetFullPath($env:CODEX_HOME)
    } else {
        Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
    }
    return [IO.Path]::GetFullPath((Join-Path $codexRoot 'config.toml'))
}

function Convert-CodexTomlProjectPath {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Quote
    )
    $path = $Value.Trim()
    if ($Quote -eq '"') {
        # Windows paths in Codex normally use literal TOML strings. Handle only
        # the two escapes that can occur in a quoted key; keep \U-style path
        # segments untouched because they are valid Windows folder names.
        $path = $path -replace '\\\\', '\\'
        $path = $path -replace '\\"', '"'
    }
    return $path
}

function Get-CodexProjectCandidates {
    param([Parameter(Mandatory = $true)]$Profile)

    $configPath = Get-CodexConfigPath
    $candidates = [Collections.Generic.List[object]]::new()
    $seenRoots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $usedAliases = @{}
    foreach ($entry in $Profile.repositories.GetEnumerator()) { $usedAliases[[string]$entry.Key] = $true }

    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        return [ordered]@{ config_path = $configPath; config_exists = $false; candidates = @() }
    }

    foreach ($line in Get-Content -LiteralPath $configPath) {
        if ($line -notmatch "^\s*\[\s*projects\.(?<quote>['`"`"])(?<path>.+?)\k<quote>\s*\]\s*$") { continue }
        $rawPath = Convert-CodexTomlProjectPath -Value ([string]$Matches.path) -Quote ([string]$Matches.quote)
        if ([string]::IsNullOrWhiteSpace($rawPath)) { continue }
        try { $fullPath = [IO.Path]::GetFullPath($rawPath) } catch { continue }
        if (-not $seenRoots.Add($fullPath.TrimEnd('\', '/'))) { continue }

        $exists = $false
        $available = $false
        $isGit = $false
        $root = $fullPath.TrimEnd('\', '/')
        $reason = $null
        if (Test-Path -LiteralPath $fullPath -PathType Container) {
            try {
                $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
                $exists = $true
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    $reason = 'reparse'
                } else {
                    $root = ([IO.Path]::GetFullPath($item.FullName)).TrimEnd('\', '/')
                    $gitTop = (& git -C $root rev-parse --show-toplevel 2>$null | Select-Object -First 1)
                    $isGit = ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$gitTop))
                    $available = $true
                }
            } catch { $reason = 'unavailable' }
        } else { $reason = 'missing' }

        $alreadyRegistered = $false
        foreach ($entry in $Profile.repositories.GetEnumerator()) {
            if ([IO.Path]::GetFullPath([string]$entry.Value.root).TrimEnd('\', '/') -ieq $root) { $alreadyRegistered = $true; break }
        }
        $suggested = Get-CodexProjectAlias -Root $root -Used $usedAliases
        $candidates.Add([ordered]@{
            path = $root
            exists = $exists
            available = $available
            is_git = $isGit
            reason = $reason
            suggested_alias = $suggested
            already_registered = $alreadyRegistered
        })
    }

    return [ordered]@{ config_path = $configPath; config_exists = $true; candidates = @($candidates.ToArray()) }
}

function Get-ActiveState {
    $active = $false; $pidValue = $null; $runtime = $null
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidPath).Trim(), [ref]$pidValue)
        if ($pidValue -gt 0 -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { $active = $true }
    }
    if (Test-Path -LiteralPath $runtimePath -PathType Leaf) { try { $runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json } catch { } }
    $health = if ($active -and (Test-Path -LiteralPath $healthPath -PathType Leaf)) { (Get-Content -Raw -LiteralPath $healthPath).Trim() } else { $null }
    $runtimeProfile = if ($null -ne $runtime) { [string]$runtime.profile } else { $null }
    return [ordered]@{ active = $active; pid = $pidValue; health_url = $health; runtime_profile = $runtimeProfile }
}

function Wait-ForTunnelReady {
    param([int]$TimeoutSeconds = 20)

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $state = Get-ActiveState
        if ($state.active -and -not [string]::IsNullOrWhiteSpace([string]$state.health_url)) {
            try {
                $base = [Uri]::new(([string]$state.health_url).TrimEnd('/'))
                if ($base.IsLoopback -and $base.Scheme -eq 'http') {
                    $health = Invoke-WebRequest -UseBasicParsing -Uri ($base.AbsoluteUri + '/healthz') -TimeoutSec 2
                    $ready = Invoke-WebRequest -UseBasicParsing -Uri ($base.AbsoluteUri + '/readyz') -TimeoutSec 2
                    if ($health.StatusCode -eq 200 -and $ready.StatusCode -eq 200) { return $state }
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return Get-ActiveState
}

function Invoke-Launcher {
    # ponytail: one-shot child plus a bounded wait; a resident IPC daemon is only needed for multiple clients.
    param([Parameter(Mandatory = $true)][string]$ScriptPath, [Parameter(Mandatory = $true)][string[]]$Arguments, [hashtable]$Environment = @{})
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $pwsh -PathType Leaf)) { $pwsh = (Get-Command pwsh -ErrorAction Stop).Source }
    $saved = @{}
    foreach ($key in $Environment.Keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process') }
    $process = $null
    # ponytail: fixed 60s ceiling keeps a stalled control-plane check from blocking the TUI indefinitely.
    $timeoutMs = 60000
    try {
        $argumentList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $Arguments
        # Separate device handles prevent a detached tunnel child from keeping a captured pipe open.
        $process = Start-Process -FilePath $pwsh -ArgumentList $argumentList -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput 'NUL' -RedirectStandardError '\\.\NUL' -PassThru
        $timedOut = -not $process.WaitForExit($timeoutMs)
        if ($timedOut) {
            try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
            try { $process.WaitForExit(5000) | Out-Null } catch { }
        }
        $childExitCode = if ($timedOut) { 124 } elseif ($process.HasExited) { [int]$process.ExitCode } else { 1 }
        return [ordered]@{ exit_code = $childExitCode; timed_out = $timedOut }
    } finally {
        foreach ($key in $Environment.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
        if ($null -ne $process) { $process.Dispose() }
    }
}

function New-Response {
    param([Parameter(Mandatory = $true)]$Body, [int]$ExitCode = 0)
    $Body | ConvertTo-Json -Depth 12 -Compress
    if ($ExitCode -ne 0) { exit $ExitCode }
}

$profilePathResolved = $null
try {
    $profilePathResolved = Resolve-ManagedProfilePath -Candidate $ProfilePath
    $profile = Get-Profile -Path $profilePathResolved
    switch ($Operation) {
        'list' {
            New-Response ([ordered]@{ status = 'PASS'; profile = 'managed'; session_access = 'session_select'; optional_autodiscovery = [bool]$profile.optional_autodiscovery; optional_backends = Get-OptionalBackendState -Profile $profile; config_version = $profile.config_version; default_repository = $profile.default_repository; repositories = Get-Catalog -Profile $profile })
        }
        'status' {
            $active = Get-ActiveState
            $lifecycle = if ($active.active) { 'RUNNING' } else { 'STOPPED' }
            New-Response ([ordered]@{ status = 'PASS'; lifecycle = $lifecycle; active = $active.active; pid = $active.pid; health_url = $active.health_url; session_access = 'session_select'; optional_autodiscovery = [bool]$profile.optional_autodiscovery; optional_backends = Get-OptionalBackendState -Profile $profile; config_version = $profile.config_version; default_repository = $profile.default_repository; repositories = Get-Catalog -Profile $profile; restart_required = [bool]$active.active })
        }
        'repository.discover-codex' {
            $discovery = Get-CodexProjectCandidates -Profile $profile
            New-Response ([ordered]@{
                status = 'PASS'
                operation = $Operation
                source = 'CODEX_HOME/config.toml'
                config_path = $discovery.config_path
                config_exists = $discovery.config_exists
                candidates = $discovery.candidates
            })
        }
        'repository.add' {
            if ([string]::IsNullOrWhiteSpace($Alias) -or $Alias -notmatch $aliasPattern) { Throw-ControlError 'ALIAS_INVALID' 'El alias debe cumplir ^[a-z][a-z0-9_-]{0,31}$.' }
            $root = Get-RepositoryRoot -Candidate $Root
            if ($profile.repositories.Contains($Alias)) { Throw-ControlError 'ALIAS_EXISTS' 'El alias ya existe.' }
            foreach ($entry in $profile.repositories.Values) { if ([IO.Path]::GetFullPath([string]$entry.root).TrimEnd('\', '/') -ieq $root) { Throw-ControlError 'DUPLICATE_ROOT' 'La raíz ya está registrada.' } }
            $profile.repositories[$Alias] = [ordered]@{ root = $root; read_only = $true; enabled = [bool]$Enable }
            $contextMode = Find-ContextModeBinding -ProjectRoot $root
            if ($null -ne $contextMode.binding) { $profile.optional_backends.bindings[$Alias] = $contextMode.binding }
            $profile.config_version = [int]$profile.config_version + 1
            Set-SelectedDefault -Profile $profile
            Save-Profile -Profile $profile -Path $profilePathResolved
            [void](Write-ManagedBridgeConfig -Profile $profile)
            New-Response ([ordered]@{ status = 'PASS'; operation = $Operation; repository = $Alias; filesystem_deleted = $false; config_version = $profile.config_version; context_mode = [ordered]@{ status = $contextMode.status; reason = $contextMode.reason; storage = $contextMode.storage; storage_files = $contextMode.storage_files }; repositories = Get-Catalog -Profile $profile })
        }
        'repository.remove' {
            if ([string]::IsNullOrWhiteSpace($Alias) -or -not $profile.repositories.Contains($Alias)) { Throw-ControlError 'REPOSITORY_UNKNOWN' 'El alias no existe.' }
            if ($profile.repositories[$Alias].enabled) { Throw-ControlError 'REPOSITORY_ACTIVE' 'Desactiva el repositorio antes de eliminarlo del perfil.' }
            $profile.repositories.Remove($Alias)
            if ($profile.optional_backends.bindings.Contains($Alias)) { $profile.optional_backends.bindings.Remove($Alias) }
            $profile.config_version = [int]$profile.config_version + 1
            Set-SelectedDefault -Profile $profile
            Save-Profile -Profile $profile -Path $profilePathResolved
            [void](Write-ManagedBridgeConfig -Profile $profile)
            New-Response ([ordered]@{ status = 'PASS'; operation = $Operation; repository = $Alias; removed = $true; filesystem_deleted = $false; config_version = $profile.config_version; repositories = Get-Catalog -Profile $profile })
        }
        'repository.enable' {
            if ([string]::IsNullOrWhiteSpace($Alias) -or -not $profile.repositories.Contains($Alias)) { Throw-ControlError 'REPOSITORY_UNKNOWN' 'El alias no existe.' }
            $root = Get-RepositoryRoot -Candidate ([string]$profile.repositories[$Alias].root)
            $contextMode = Find-ContextModeBinding -ProjectRoot $root
            if ($null -ne $contextMode.binding) {
                if (-not $profile.optional_backends.bindings.Contains($Alias)) { $profile.optional_backends.bindings[$Alias] = [ordered]@{} }
                $profile.optional_backends.bindings[$Alias].context_mode = $contextMode.binding.context_mode
            } elseif ($profile.optional_backends.bindings.Contains($Alias) -and $profile.optional_backends.bindings[$Alias].Contains('context_mode')) {
                $profile.optional_backends.bindings[$Alias].Remove('context_mode')
                if ($profile.optional_backends.bindings[$Alias].Count -eq 0) { $profile.optional_backends.bindings.Remove($Alias) }
            }
            $profile.repositories[$Alias].enabled = $true; Set-SelectedDefault -Profile $profile
            $profile.config_version = [int]$profile.config_version + 1; Save-Profile -Profile $profile -Path $profilePathResolved; [void](Write-ManagedBridgeConfig -Profile $profile)
            New-Response ([ordered]@{ status = 'PASS'; operation = $Operation; repository = $Alias; config_version = $profile.config_version; context_mode = [ordered]@{ status = $contextMode.status; reason = $contextMode.reason; storage = $contextMode.storage; storage_files = $contextMode.storage_files }; repositories = Get-Catalog -Profile $profile })
        }
        'repository.disable' {
            if ([string]::IsNullOrWhiteSpace($Alias) -or -not $profile.repositories.Contains($Alias)) { Throw-ControlError 'REPOSITORY_UNKNOWN' 'El alias no existe.' }
            $profile.repositories[$Alias].enabled = $false; Set-SelectedDefault -Profile $profile
            $profile.config_version = [int]$profile.config_version + 1; Save-Profile -Profile $profile -Path $profilePathResolved; [void](Write-ManagedBridgeConfig -Profile $profile)
            New-Response ([ordered]@{ status = 'PASS'; operation = $Operation; repository = $Alias; config_version = $profile.config_version; repositories = Get-Catalog -Profile $profile })
        }
        'optional_backend.enable' {
            if ([string]::IsNullOrWhiteSpace($Backend)) { Throw-ControlError 'BACKEND_INVALID' 'Backend es obligatorio.' }
            $profile.optional_backends["${Backend}_enabled"] = $true
            $profile.config_version = [int]$profile.config_version + 1
            Save-Profile -Profile $profile -Path $profilePathResolved
            [void](Write-ManagedBridgeConfig -Profile $profile)
            New-Response ([ordered]@{ status = 'PASS'; operation = $Operation; backend = $Backend; enabled = $true; config_version = $profile.config_version; restart_required = [bool](Get-ActiveState).active; optional_backends = Get-OptionalBackendState -Profile $profile })
        }
        'optional_backend.disable' {
            if ([string]::IsNullOrWhiteSpace($Backend)) { Throw-ControlError 'BACKEND_INVALID' 'Backend es obligatorio.' }
            $profile.optional_backends["${Backend}_enabled"] = $false
            $profile.config_version = [int]$profile.config_version + 1
            Save-Profile -Profile $profile -Path $profilePathResolved
            [void](Write-ManagedBridgeConfig -Profile $profile)
            New-Response ([ordered]@{ status = 'PASS'; operation = $Operation; backend = $Backend; enabled = $false; config_version = $profile.config_version; restart_required = [bool](Get-ActiveState).active; optional_backends = Get-OptionalBackendState -Profile $profile })
        }
        'stack.start' {
            if (-not (Write-ManagedBridgeConfig -Profile $profile)) { Throw-ControlError 'NO_ENABLED_REPOSITORIES' 'Activa al menos un repositorio antes de arrancar.' }
            if ([string]::IsNullOrWhiteSpace($env:CODESCOPE_TUNNEL_RUNTIME_KEY)) { Throw-ControlError 'RUNTIME_KEY_MISSING' 'CODESCOPE_TUNNEL_RUNTIME_KEY debe estar configurada en el entorno; nunca se guarda en el perfil.' }
            $start = Join-Path $PSScriptRoot 'tunnel-start.ps1'
            $result = Invoke-Launcher -ScriptPath $start -Arguments @('-Start', '-ConfigPath', (Resolve-TunnelProfilePath), '-RunDirectory', $runDirectory, '-AllowManagedBridgeConfig') -Environment @{ CODESCOPE_CONFIG = $runtimeConfigPath }
            $active = Wait-ForTunnelReady
            $success = $result.exit_code -eq 0 -and $active.active
            $errorCode = if ($result.timed_out) { 'LAUNCHER_TIMEOUT' } elseif (-not $success) { 'LAUNCHER_FAILED' } else { $null }
            $responseStatus = if ($success) { 'PASS' } else { 'BLOCKED' }
            $responseExit = if ($success) { 0 } else { 1 }
            New-Response ([ordered]@{ status = $responseStatus; operation = $Operation; error_code = $errorCode; config_version = $profile.config_version; lifecycle = [ordered]@{ launcher_exit_code = $result.exit_code; timed_out = $result.timed_out; active = $active; exit_code = $result.exit_code }; exit_code = $result.exit_code }) $responseExit
        }
        'stack.stop' {
            $stop = Join-Path $PSScriptRoot 'tunnel-stop.ps1'
            $result = Invoke-Launcher -ScriptPath $stop -Arguments @('-PidFile', $pidPath, '-AllowManagedBridgeConfig')
            $success = $result.exit_code -eq 0
            $errorCode = if ($result.timed_out) { 'LAUNCHER_TIMEOUT' } elseif (-not $success) { 'LAUNCHER_FAILED' } else { $null }
            $responseStatus = if ($success) { 'PASS' } else { 'BLOCKED' }
            $responseExit = if ($success) { 0 } else { 1 }
            New-Response ([ordered]@{ status = $responseStatus; operation = $Operation; error_code = $errorCode; lifecycle = [ordered]@{ launcher_exit_code = $result.exit_code; timed_out = $result.timed_out; active = (Get-ActiveState) }; exit_code = $result.exit_code }) $responseExit
        }
    }
} catch {
    $code = if ($_.Exception.Data.Contains('Code')) { [string]$_.Exception.Data['Code'] } else { 'CONTROL_FAILED' }
    New-Response ([ordered]@{ status = 'BLOCKED'; error_code = $code; message = [string]$_.Exception.Message }) 1
}
