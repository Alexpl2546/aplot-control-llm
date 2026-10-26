[CmdletBinding()]
param(
  [string]$Components = '',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Aplot Control LLM\components'),
  [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA 'Aplot Control LLM\components'),
  [string]$AppPath = '',
  [string]$AppDirectory = '',
  [string]$ResultIni = '',
  [switch]$Probe,
  [switch]$Fresh,
  [switch]$SkipDependencies,
  [string]$DiscoveryRoot = '',
  [string]$CatalogPath = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (!$CatalogPath) { $CatalogPath = Join-Path $PSScriptRoot 'components.json' }
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=$script:Utf8
$OutputEncoding=$script:Utf8
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
function Write-InstallProgress([string]$Stage,[string]$Title,$Percent=$null,[string]$Detail='', $Downloaded=$null,$Total=$null,$Rate=$null) {
  $event=@{stage=$Stage;title=$Title;percent=$Percent;detail=$Detail;downloaded=$Downloaded;total=$Total;rate=$Rate}
  Write-Host ('APLOT_PROGRESS '+($event|ConvertTo-Json -Compress))
}
function Copy-DownloadStream([IO.Stream]$InputStream,[IO.Stream]$OutputStream,[long]$Total,[long]$Offset=0) {
  $buffer=New-Object byte[] (256*1024);$received=$Offset;$clock=[Diagnostics.Stopwatch]::StartNew();$last=0L
  Write-InstallProgress 'download' 'Загружаем архив' $(if ($Total -gt 0) {100.0*$Offset/$Total} else {$null}) '' $Offset $Total 0
  while (($read=$InputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
    $OutputStream.Write($buffer,0,$read);$received+=$read
    if ($clock.ElapsedMilliseconds-$last -ge 250) {
      $percent=if ($Total -gt 0) {[Math]::Min(100,100.0*$received/$Total)} else {$null}
      Write-InstallProgress 'download' 'Загружаем архив' $percent '' $received $Total (($received-$Offset)/[Math]::Max(0.001,$clock.Elapsed.TotalSeconds))
      $last=$clock.ElapsedMilliseconds
    }
  }
  if ($Total -gt 0 -and $received -ne $Total) { throw 'Incomplete download; retry the installation.' }
  Write-InstallProgress 'download' 'Архив загружен' 100 '' $received $received (($received-$Offset)/[Math]::Max(0.001,$clock.Elapsed.TotalSeconds))
}
function Receive-InstallerFile([string]$Uri,[string]$Path,[int]$MaxAttempts=3,[int]$RetryDelaySeconds=2) {
  $lastFailure=''
  for ($attempt=1;$attempt -le $MaxAttempts;$attempt++) {
    $response=$null;$inputStream=$null;$outputStream=$null
    $offset=if (Test-Path -LiteralPath $Path) {(Get-Item -LiteralPath $Path).Length} else {0L}
    try {
      Write-InstallProgress 'connect' 'Соединяемся с сервером загрузки' $null ("Попытка $attempt из $MaxAttempts")
      $request=[Net.HttpWebRequest]::Create($Uri);$request.Timeout=30000;$request.ReadWriteTimeout=120000;$request.UserAgent='Aplot-Installer'
      if ($offset -gt 0) {$request.AddRange([long]$offset)}
      $response=$request.GetResponse()
      $append=$false;$total=$response.ContentLength
      if ($offset -gt 0 -and [int]$response.StatusCode -eq 206) {
        $range=[regex]::Match([string]$response.Headers['Content-Range'],'^bytes (\d+)-(\d+)/(\d+)$')
        if (!$range.Success -or [long]$range.Groups[1].Value -ne $offset) {throw 'Invalid Content-Range for resumed download.'}
        $total=[long]$range.Groups[3].Value;$append=$true
        Write-Log ("Resuming download at $offset bytes (attempt $attempt/$MaxAttempts).")
      } elseif ([int]$response.StatusCode -ne 200) {throw "Unexpected HTTP response: $([int]$response.StatusCode)"}
      if (!$append) {$offset=0L}
      $inputStream=$response.GetResponseStream()
      $outputStream=[IO.File]::Open($Path,$(if ($append){[IO.FileMode]::Append}else{[IO.FileMode]::Create}),[IO.FileAccess]::Write,[IO.FileShare]::Read)
      Copy-DownloadStream $inputStream $outputStream $total $offset
      return
    } catch {
      $errorObject=$_.Exception
      while ($errorObject.InnerException) {$errorObject=$errorObject.InnerException}
      $lastFailure=$errorObject.GetType().Name+': '+$errorObject.Message
      Write-Log ("Download attempt $attempt/$MaxAttempts failed: $lastFailure")
      if ($attempt -lt $MaxAttempts) {
        Write-InstallProgress 'retry' 'Соединение прервано — повторяем загрузку' $null ("Попытка $($attempt+1) из $MaxAttempts. Загруженная часть сохранена.")
        if ($RetryDelaySeconds -gt 0) {Start-Sleep -Seconds ($RetryDelaySeconds*$attempt)}
      }
    } finally {
      if ($outputStream){$outputStream.Dispose()};if ($inputStream){$inputStream.Dispose()};if ($response){$response.Dispose()}
    }
  }
  throw "Не удалось загрузить архив после $MaxAttempts попыток. Загруженная часть сохранена для докачки. $lastFailure"
}
function Write-Log([string]$Message) {
  Write-Host $Message
  if ($script:LogPath) { [IO.File]::AppendAllText($script:LogPath, "$(Get-Date -Format o) $Message`r`n", $script:Utf8) }
}
function Read-Catalog([string]$Path) {
  $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($value.schemaVersion -ne 1) { throw 'Unsupported component catalog.' }
  $ids = @{}
  foreach ($item in $value.components) {
    if ($item.id -notmatch '^[a-z_]+$' -or $ids.ContainsKey($item.id) -or $item.version -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Invalid component catalog.' }
    $ids[$item.id] = $true
    foreach ($property in $item.artifacts.PSObject.Properties) { Assert-Artifact $property.Value }
  }
  $engineIds = @($value.components | Where-Object { $_.kind -eq 'engine' } | ForEach-Object { $_.id } | Sort-Object)
  if (($engineIds -join ',') -ne 'llama_cpp,strata') { throw 'Only llama.cpp and Strata may be installed as local engines.' }
  if ($value.dependencies.git) { Assert-Artifact $value.dependencies.git }
  Assert-Artifact $value.dependencies.uv
  if ($value.dependencies.msvc) { Assert-Artifact $value.dependencies.msvc }
  return $value
}
function Assert-Artifact($Artifact) {
  $uri = [Uri]$Artifact.url
  if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $Artifact.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid download URL or SHA-256.' }
  if ($uri.Host -eq 'download.visualstudio.microsoft.com' -and $uri.AbsolutePath -match '^/download/pr/[a-f0-9-]+/[A-Fa-f0-9]+/VC_redist[.]x64[.]exe$') { return }
  if ($uri.Host -eq 'downloads.claude.ai' -and $uri.AbsolutePath -match '^/claude-code-releases/[0-9]+[.][0-9]+[.][0-9]+/win32-x64/claude[.]exe$') { return }
  if ($uri.Host -ne 'github.com') { throw 'Download is outside official repositories.' }
  $allowed = @('ggml-org/llama.cpp','Niko1221/Strata','NousResearch/hermes-agent','astral-sh/uv','openai/codex','git-for-windows/git')
  $parts = $uri.AbsolutePath.Trim('/').Split('/')
  if ($parts.Length -lt 4 -or ($parts[0]+'/'+$parts[1]) -notin $allowed -or $parts[2] -notin @('archive','releases')) { throw 'Download is outside official repositories.' }
}
function Test-ComponentPath([string]$Id,[string]$Path,[switch]$AllowIncomplete) {
  if (!$Path) { return $false }
  if (!$AllowIncomplete -and (Test-Path -LiteralPath (Join-Path $Path 'aplot-installing.json')) -and !(Test-Path -LiteralPath (Join-Path $Path 'aplot-component.json'))) { return $false }
  if ($Id -eq 'strata') { return (Test-Path -LiteralPath (Join-Path $Path 'setup.py') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $Path '.venv\Scripts\python.exe') -PathType Leaf) }
  if ($Id -eq 'hermes') { return (Test-Path -LiteralPath (Join-Path $Path 'tui_gateway\entry.py') -PathType Leaf) -and ((Test-Path -LiteralPath (Join-Path $Path '.venv\Scripts\python.exe') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $Path 'venv\Scripts\python.exe') -PathType Leaf)) }
  if ($Id -eq 'claude') { return ([IO.Path]::GetFileName($Path) -ieq 'claude.exe') -and (Test-Path -LiteralPath $Path -PathType Leaf) }
  if ($Id -eq 'codex') { return ([IO.Path]::GetFileName($Path) -in @('codex.exe','codex-x86_64-pc-windows-msvc.exe')) -and (Test-Path -LiteralPath $Path -PathType Leaf) }
  $names = @{llama_cpp='llama-server.exe'}
  return $names.ContainsKey($Id) -and ([IO.Path]::GetFileName($Path) -ieq $names[$Id]) -and (Test-Path -LiteralPath $Path -PathType Leaf)
}
function Get-Existing($Catalog,[string]$Root,[string]$Executable) {
  $result = @{}
  if ($Executable -and (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    $report = Join-Path ([IO.Path]::GetTempPath()) ('aplot-inventory-'+[guid]::NewGuid()+'.json')
    try {
      $arguments=@('--component-inventory',('"'+$report+'"'))
      if ($AppDirectory) { $arguments+=('"'+$AppDirectory.TrimEnd('\')+'"') }
      if ($DiscoveryRoot -and $AppDirectory) { $arguments+=('"'+$DiscoveryRoot.TrimEnd('\')+'"') }
      $process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru -WindowStyle Hidden
      if (!$process.WaitForExit(15000)) { $process.Kill(); throw 'Component inventory timed out.' }
      if ($process.ExitCode -eq 0 -and (Test-Path -LiteralPath $report)) {
        $data = Get-Content -LiteralPath $report -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($data.schemaVersion -eq 1) { foreach ($item in $data.components) { if (Test-ComponentPath $item.id $item.path) { $result[$item.id]=$item.path } } }
      }
    } finally { if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force } }
  }
  $manifest = Join-Path $Root 'installations.json'
  if (Test-Path -LiteralPath $manifest) {
    try { foreach ($item in (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).components) { if (!$result.ContainsKey($item.id) -and (Test-ComponentPath $item.id $item.path)) { $result[$item.id]=$item.path } } } catch { Write-Verbose 'Unreadable old component manifest.' }
  }
  $candidates = @{
    llama_cpp=@(); claude=@((Join-Path $env:USERPROFILE '.local/bin/claude.exe'));codex=@();strata=@();hermes=@((Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent'))
  }
  foreach ($item in $Catalog.components) {
    if ($result.ContainsKey($item.id)) { continue }
    $command = Get-Command ([IO.Path]::GetFileName($item.entry)) -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $paths = @($candidates[$item.id]); if ($command) { $paths += $command.Source }
    foreach ($path in $paths) { if (Test-ComponentPath $item.id $path) { $result[$item.id]=$path; break } }
  }
  return $result
}
function Get-VerifiedFile($Artifact,[string]$Root,[string]$Extension) {
  Assert-Artifact $Artifact
  $cache = Join-Path $Root 'downloads'; [IO.Directory]::CreateDirectory($cache) | Out-Null
  if ($Extension -notin @('.zip','.exe','.tar.gz')) { throw 'Invalid cache extension.' }
  $path = Join-Path $cache ($Artifact.sha256+$Extension)
  Write-InstallProgress 'verify' 'Проверяем кэш загрузок'
  if ((Test-Path -LiteralPath $path) -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Artifact.sha256) { Write-Log 'Using verified download cache.'; return $path }
  $sharedCache=Join-Path (Join-Path $CacheRoot 'downloads') ($Artifact.sha256+$Extension)
  if ($sharedCache -ne $path -and (Test-Path -LiteralPath $sharedCache) -and (Get-FileHash -LiteralPath $sharedCache -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Artifact.sha256) {
    Copy-Item -LiteralPath $sharedCache -Destination $path
    Write-Log 'Using verified download cache from the existing component store.'
    return $path
  }
  $part = $path+'.partial'
  if ((Test-Path -LiteralPath $part) -and (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Artifact.sha256) {Move-Item -LiteralPath $part -Destination $path -Force;return $path}
  Write-Log ('Downloading '+$Artifact.url)
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Receive-InstallerFile $Artifact.url $part
  Write-InstallProgress 'verify' 'Проверяем SHA-256 загруженного архива'
  if ((Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Artifact.sha256) { Remove-Item -LiteralPath $part -Force; throw 'SHA-256 mismatch; downloaded content was not installed.' }
  Move-Item -LiteralPath $part -Destination $path -Force
  return $path
}
function Get-VerifiedArchive($Artifact,[string]$Root) {
  $extension=if ($Artifact.url -match '(?i)\.tar\.gz(?:$|\?)') { '.tar.gz' } else { '.zip' }
  return Get-VerifiedFile $Artifact $Root $extension
}
function Test-VcRuntime($Catalog) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view)
    try {
      $key=$base.OpenSubKey('SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')
      if ($key) { try { if ($key.GetValue('Installed') -eq 1 -and [version](([string]$key.GetValue('Version')).TrimStart('v')) -ge [version]$Catalog.dependencies.msvc.version) { return $true } } finally { $key.Dispose() } }
    } finally { $base.Dispose() }
  }
  return $false
}
function Install-VcRuntime($Catalog,[string]$Root) {
  Write-InstallProgress 'runtime' 'Проверяем Microsoft Visual C++ Runtime'
  if (Test-VcRuntime $Catalog) { Write-Log 'Microsoft Visual C++ x64 is already installed.';return }
  $runtime=Get-VerifiedFile $Catalog.dependencies.msvc $Root '.exe'
  Write-InstallProgress 'runtime' 'Устанавливаем Microsoft Visual C++ Runtime' $null 'Если Windows запросит разрешение, подтвердите установку пакета Microsoft.'
  Write-Log 'Installing Microsoft Visual C++ x64. Windows may request administrator permission.'
  # Shell execution lets the signed Microsoft installer request its own elevation; the Aplot wizard stays per-user.
  $process=Start-Process -FilePath $runtime -ArgumentList '/install /passive /norestart' -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -notin @(0,1638,3010)) { throw "Microsoft Visual C++ installation failed ($($process.ExitCode))." }
  if (!(Test-VcRuntime $Catalog)) { throw 'Microsoft Visual C++ runtime was not detected after installation.' }
  if ($process.ExitCode -eq 3010) { Write-Log 'Microsoft Visual C++ requests a Windows restart; no automatic restart will occur.' }
}
function Use-ExistingPython([string]$Target,[string]$Version) {
  $python=Join-Path $Target '.venv\Scripts\python.exe'
  if (Test-Path -LiteralPath $python) { return $python }
  $candidates=@()
  $launcher=Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($launcher) { $candidates+=@{exe=$launcher.Source;args=@('-'+$Version)} }
  $command=Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $candidates+=@{exe=$command.Source;args=@()} }
  foreach ($candidate in $candidates) {
    $previous=$ErrorActionPreference
    try {
      $ErrorActionPreference='Continue'
      $runtimeVersion=& $candidate.exe @($candidate.args) -c 'import sys; print(sys.version.split()[0].rsplit(chr(46),1)[0])' 2>$null
      if ($LASTEXITCODE -ne 0 -or "$runtimeVersion" -ne $Version) { continue }
    } finally { $ErrorActionPreference=$previous }
    Invoke-Checked $candidate.exe (@($candidate.args)+@('-m','venv','--system-site-packages',(Join-Path $Target '.venv')))
    return $python
  }
  throw "Dependency installation was disabled. Install Python $Version and the required packages, or enable additional packages and retry."
}
function Expand-VerifiedZip([string]$Archive,[string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $prefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\')+'\'
  [IO.Directory]::CreateDirectory($Destination) | Out-Null
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $entryIndex=0;$lastProgress=[Diagnostics.Stopwatch]::StartNew()
    Write-InstallProgress 'extract' 'Распаковываем архив' 0
    foreach ($entry in $zip.Entries) {
      $entryIndex++
      $name = $entry.FullName.Replace('/','\')
      $target = [IO.Path]::GetFullPath((Join-Path $Destination $name))
      if (!$target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or $name.Contains(':') -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe path in component archive.' }
      if ($name.EndsWith('\')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true)
      if ($lastProgress.ElapsedMilliseconds -ge 250 -or $entryIndex -eq $zip.Entries.Count) {
        Write-InstallProgress 'extract' 'Распаковываем архив' (100.0*$entryIndex/[Math]::Max(1,$zip.Entries.Count)) ("Файлов: $entryIndex из $($zip.Entries.Count)")
        $lastProgress.Restart()
      }
    }
  } finally { $zip.Dispose() }
}
function Expand-VerifiedTarGz([string]$Archive,[string]$Destination,[string]$Python) {
  if (!(Test-Path -LiteralPath $Python -PathType Leaf)) { throw 'Python is required to extract the verified Strata engine archive.' }
  $scriptPath=Join-Path $env:TEMP ('aplot-extract-'+[guid]::NewGuid()+'.py')
  $script=@'
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    for member in members:
        name = member.name.replace("\\", "/")
        path = pathlib.PurePosixPath(name)
        windows = pathlib.PureWindowsPath(name)
        if path.is_absolute() or windows.drive or windows.root or ".." in path.parts:
            raise SystemExit("Unsafe path in component archive.")
        if not (member.isfile() or member.isdir()):
            raise SystemExit("Unsupported link or special file in component archive.")
        target = (destination / pathlib.Path(*path.parts)).resolve()
        if target != destination and destination not in target.parents:
            raise SystemExit("Unsafe path in component archive.")
    bundle.extractall(destination, members=members)
'@
  [IO.File]::WriteAllText($scriptPath,$script,[Text.UTF8Encoding]::new($false))
  try { Invoke-Checked $Python @('-X','utf8',$scriptPath,$Archive,$Destination) }
  finally { if (Test-Path -LiteralPath $scriptPath) { Remove-Item -LiteralPath $scriptPath -Force } }
}
function Expand-VerifiedArchive([string]$Archive,[string]$Destination,[string]$Python='') {
  if ($Archive.EndsWith('.tar.gz',[StringComparison]::OrdinalIgnoreCase)) {
    Expand-VerifiedTarGz $Archive $Destination $Python
  } else {
    Expand-VerifiedZip $Archive $Destination
  }
}
function Invoke-Checked([string]$Executable,[string[]]$Arguments,[int[]]$AllowedExitCodes=@(0)) {
  if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Missing executable: $Executable" }
  $previous=$ErrorActionPreference
  try {
    # Windows PowerShell 5.1 wraps ordinary native stderr (uv progress) in ErrorRecord.
    $ErrorActionPreference='Continue'
    & $Executable @Arguments 2>&1 | ForEach-Object { Write-Log "$_" }
    $code=$LASTEXITCODE
  } finally { $ErrorActionPreference=$previous }
  if ($code -notin $AllowedExitCodes) { throw "Process failed ($code): $([IO.Path]::GetFileName($Executable))" }
}
function Find-Entry([string]$Directory,[string]$Name) {
  $files = @(Get-ChildItem -LiteralPath $Directory -Filter $Name -File -Recurse | Where-Object {$_.FullName -notmatch '[\\/]\.venv[\\/]'} )
  if ($files.Count -ne 1) { throw "Expected one $Name in official archive, found $($files.Count)." }
  return $files[0].FullName
}
function Get-StrataEnginePackageInfo([string]$PackagePath,[string]$ArtifactKey) {
  $manifestPath=Join-Path $PackagePath 'engine-component.json'
  if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The Strata engine package has no engine-component.json manifest.' }
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $expectedBackend=if ($ArtifactKey -like 'cuda*') {'cuda'} else {'hip'}
  $expectedVariant=switch ($ArtifactKey) {
    'cuda12' {'cuda12'}
    'cuda13' {'cuda13'}
    'hip-rdna2' {'rdna2'}
    'hip-rdna3' {'rdna3'}
    'hip-rx9070' {'rx9070'}
    default { throw 'Unknown Strata engine artifact variant.' }
  }
  if ($manifest.schema_version -notin @(1,2) -or $manifest.id -ne 'strata-engine' -or $manifest.name -ne 'strata-engine') { throw 'The downloaded Strata engine manifest is invalid.' }
  if ($manifest.platform -ne 'windows-x86_64' -or $manifest.backend -ne $expectedBackend -or $manifest.variant -ne $expectedVariant) { throw 'The downloaded Strata engine package does not match the selected Windows GPU build.' }
  if ($manifest.entrypoint -ne 'strata.exe' -or !(Test-Path -LiteralPath (Join-Path $PackagePath 'strata.exe') -PathType Leaf)) { throw 'The Strata engine package has no expected strata.exe entrypoint.' }
  if ($manifest.version -notmatch '^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$') { throw 'The Strata engine package has an invalid version.' }
  $folderName=$manifest.version+'-'+$manifest.platform+'-'+$manifest.backend+'-'+$manifest.variant
  if ($folderName -notmatch '^[A-Za-z0-9._-]+$' -or $folderName.Contains('..')) { throw 'The Strata engine package has an unsafe component name.' }
  return [pscustomobject]@{FolderName=$folderName;ManifestPath=$manifestPath;Version=$manifest.version;Backend=$expectedBackend;Variant=$expectedVariant}
}
function Verify-StrataEnginePackage([string]$Python,[string]$InstallPath,[string]$ComponentsPath,[string]$PackagePath,[string]$ArtifactKey) {
  $info=Get-StrataEnginePackageInfo $PackagePath $ArtifactKey
  $backend=$info.Backend;$variant=$info.Variant
  $verifyScriptPath=Join-Path $env:TEMP ('aplot-verify-strata-engine-'+[guid]::NewGuid()+'.py')
  $verifyScript=@'
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from strata_control import engine_component as ec
component = ec.read_manifest(Path(sys.argv[2]))
if component.id != "strata-engine" or component.platform != "windows-x86_64":
    raise SystemExit("The package is not a Windows Strata engine component.")
if component.backend != sys.argv[3] or component.variant != sys.argv[4]:
    raise SystemExit("The signed component manifest does not match the selected GPU variant.")
if component.entrypoint != "strata.exe":
    raise SystemExit("The signed component manifest has an unexpected entrypoint.")
signature_status = ec.verify_signature(component)
if signature_status != "verified":
    raise SystemExit("The Strata engine package does not have a valid signature from a trusted release key.")
ec.verify(component, full=True)
'@
  [IO.File]::WriteAllText($verifyScriptPath,$verifyScript,[Text.UTF8Encoding]::new($false))
  $names=@('STRATA_CONTROL_INSTALL','STRATA_INSTALL_DIR','STRATA_COMPONENTS_DIR','STRATA_REQUIRE_SIGNED_COMPONENTS')
  $previous=@{};foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
  try {
    $env:STRATA_CONTROL_INSTALL='1';$env:STRATA_INSTALL_DIR=$InstallPath;$env:STRATA_COMPONENTS_DIR=$ComponentsPath;$env:STRATA_REQUIRE_SIGNED_COMPONENTS='1'
    Invoke-Checked $Python @('-X','utf8',$verifyScriptPath,$InstallPath,$PackagePath,$backend,$variant)
  } finally {
    foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
    if (Test-Path -LiteralPath $verifyScriptPath) { Remove-Item -LiteralPath $verifyScriptPath -Force }
  }
  return $info
}
function Install-StrataEngineComponent([string]$Python,[string]$InstallPath,[string]$Root,$Artifact,[string]$ArtifactKey) {
  $componentsPath=Join-Path $InstallPath 'components'
  $destinationRoot=Join-Path $componentsPath 'engine'
  $stage=Join-Path $Root ('.staging-strata-engine-'+[guid]::NewGuid())
  try {
    Expand-VerifiedArchive (Get-VerifiedArchive $Artifact $Root) $stage $Python
    $info=Verify-StrataEnginePackage $Python $InstallPath $componentsPath $stage $ArtifactKey
    $destination=Join-Path $destinationRoot $info.FolderName
    if (Test-Path -LiteralPath $destination) {
      $existingInfo=Verify-StrataEnginePackage $Python $InstallPath $componentsPath $destination $ArtifactKey
      $stagedHash=(Get-FileHash -LiteralPath $info.ManifestPath -Algorithm SHA256).Hash
      $existingHash=(Get-FileHash -LiteralPath $existingInfo.ManifestPath -Algorithm SHA256).Hash
      if ($stagedHash -ne $existingHash) { throw 'A different Strata engine package already uses the selected component version; it was not overwritten.' }
      return $destination
    }
    [IO.Directory]::CreateDirectory($destinationRoot)|Out-Null
    Move-Item -LiteralPath $stage -Destination $destination | Out-Null
    return $destination
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
}
function Get-Uv($Catalog,[string]$Root) {
  $directory=Join-Path $Root 'tools\uv-0.12.3';$binary=Join-Path $directory 'uv.exe'
  if (!(Test-Path -LiteralPath $binary)) { Expand-VerifiedZip (Get-VerifiedArchive $Catalog.dependencies.uv $Root) $directory }
  if (!(Test-Path -LiteralPath $binary)) { $binary=Find-Entry $directory 'uv.exe' }
  return $binary
}
function Publish-Location([string]$Root,$Item,[string]$Path,[string]$PreviousPath='') {
  $file=Join-Path $Root 'installations.json';$items=@();$previousPaths=@()
  $version=$Item.version
  if (Test-Path -LiteralPath $file) {
    $previous=@((Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json).components)
    $sameId=@($previous | Where-Object {$_.id -eq $Item.id})
    $known=$sameId | Where-Object {$_.path -eq $Path} | Select-Object -First 1
    if ($version -eq 'existing' -and $known.version) { $version=$known.version }
    foreach($prior in $sameId) {
      foreach($candidate in @($prior.previousPaths)+@($prior.path)) {
        if($candidate -and $candidate -ne $Path -and $candidate -notin $previousPaths){$previousPaths+=([string]$candidate)}
      }
    }
    $items=@($previous | Where-Object {$_.id -ne $Item.id})
  }
  if($PreviousPath -and $PreviousPath -ne $Path -and $PreviousPath -notin $previousPaths){$previousPaths+= $PreviousPath}
  $items+=@{id=$Item.id;path=$Path;version=$version;previousPaths=@($previousPaths)}
  $data=@{schemaVersion=1;components=@($items)}|ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($file+'.new',$data,$script:Utf8)
  Move-Item -LiteralPath ($file+'.new') -Destination $file -Force
}
function Install-GitRuntime($Catalog,[string]$Root) {
  $candidates=@((Join-Path $env:ProgramFiles 'Git/bin/bash.exe'),(Join-Path $env:LOCALAPPDATA 'Programs/Git/bin/bash.exe'))
  foreach($path in $candidates){if(Test-Path -LiteralPath $path -PathType Leaf){return}}
  $command=Get-Command git.exe -ErrorAction SilentlyContinue
  if($command){$base=Split-Path -Parent (Split-Path -Parent $command.Source);if(Test-Path -LiteralPath (Join-Path $base 'bin/bash.exe') -PathType Leaf){return}}
  Write-InstallProgress 'packages' 'Устанавливаем Git for Windows и Git Bash'
  $installer=Get-VerifiedFile $Catalog.dependencies.git $Root '.exe'
  Invoke-Checked $installer @('/VERYSILENT','/NORESTART','/SP-','/CURRENTUSER','/NOICONS') @(0,3010)
}
function Install-One($Item,$Catalog,[string]$Root,[string]$PreviousPath='') {
  $target=Join-Path (Join-Path $Root $Item.id) $Item.version
  $ready=Join-Path $target 'aplot-component.json'
  if (!$SkipDependencies -and 'git' -in @($Item.dependencyIds)) { Install-GitRuntime $Catalog $Root }
  if (!$SkipDependencies -and 'msvc' -in @($Item.dependencyIds)) { Install-VcRuntime $Catalog $Root }
  if (Test-Path -LiteralPath $ready) {
    $path=(Get-Content -LiteralPath $ready -Raw -Encoding UTF8 | ConvertFrom-Json).path
    if (Test-ComponentPath $Item.id $path) { Publish-Location $Root $Item $path $PreviousPath; return $path }
  }
  $gpu=@(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {$_.Name}) -join ' '
  $backend=if ($gpu -match 'NVIDIA') {'cuda'} elseif ($gpu -match 'AMD|Radeon') {'hip'} else {''}
  $artifactKey=$backend
  if ($Item.id -eq 'strata' -and $backend -eq 'cuda') {
    $nvidiaSmi=Get-Command nvidia-smi.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$nvidiaSmi) {
      $candidate=Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nvidiaSmi=[pscustomobject]@{Source=$candidate} }
    }
    $driver=''
    if ($nvidiaSmi) {
      $driverLine = & $nvidiaSmi.Source --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1
      if ($driverLine) { $driver=([string]$driverLine).Trim() }
    }
    $driverVersion=$null
    if ($driver -match '^\d+(?:\.\d+)+$') { try { $driverVersion=[version]$driver } catch { $driverVersion=$null } }
    $artifactKey=if ($driverVersion -and $driverVersion -ge [version]'580.65') {'cuda13'} else {'cuda12'}
  }
  if ($Item.id -eq 'strata' -and $backend -eq 'hip') {
    if ($gpu -match 'RX\s*9\d{3}|Radeon AI PRO R9700|R9700') { $artifactKey='hip-rx9070' }
    elseif ($gpu -match 'RX\s*7\d{3}|Ryzen AI Max|Strix Halo') { $artifactKey='hip-rdna3' }
    elseif ($gpu -match 'RX\s*6\d{3}') { $artifactKey='hip-rdna2' }
    else { throw 'This AMD GPU is not covered by a Strata Windows engine package.' }
  }
  if ($Item.id -eq 'strata' -and !$backend) { throw 'Strata requires a supported NVIDIA or AMD GPU.' }
  if (!(Test-Path -LiteralPath $target)) {
    $stage=Join-Path $Root ('.staging-'+[guid]::NewGuid());[IO.Directory]::CreateDirectory($stage)|Out-Null
    if ($Item.method -eq 'binary') { Copy-Item -LiteralPath (Get-VerifiedFile $Item.artifacts.binary $Root '.exe') -Destination (Join-Path $stage $Item.entry);$source=$stage } else {
    $archive=if ($Item.method -eq 'archive') {$Item.artifacts.binary} else {$Item.artifacts.source}
    Expand-VerifiedArchive (Get-VerifiedArchive $archive $Root) $stage
    if ($Item.method -ne 'archive') {
      $folders=@(Get-ChildItem -LiteralPath $stage -Directory)
      if ($folders.Count -ne 1) { throw 'Unexpected official source archive structure.' }
      $source=$folders[0].FullName
    } else { $source=$stage }
    }
    [IO.File]::WriteAllText((Join-Path $source 'aplot-installing.json'),('{"id":"'+$Item.id+'"}'),$script:Utf8)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
    Move-Item -LiteralPath $source -Destination $target
  } elseif (!(Test-Path -LiteralPath (Join-Path $target 'aplot-installing.json'))) { throw 'Unrecognized existing directory; it will not be overwritten.' }
  if ($Item.method -in @('strata','hermes')) {
    Write-InstallProgress 'python' 'Подготавливаем Python и менеджер пакетов'
    $uv=if (!$SkipDependencies) { Get-Uv $Catalog $Root } else { '' }
    $python=Join-Path $target '.venv\Scripts\python.exe'
    $env:UV_PYTHON_INSTALL_DIR=Join-Path $CacheRoot 'python'
    $env:UV_CACHE_DIR=Join-Path $CacheRoot 'cache'
    if ($Item.method -eq 'hermes') {
      if ($SkipDependencies) { $python=Use-ExistingPython $target $Item.python }
      else { Write-InstallProgress 'packages' 'Устанавливаем Python и пакеты Hermes' $null 'Загрузка и настройка пакетов, включая диктовку';Invoke-Checked $uv @('sync','--project',$target,'--python',$Item.python,'--managed-python','--locked','--no-dev','--extra','voice') }
      Write-InstallProgress 'validate' 'Проверяем окружение Hermes'
      Invoke-Checked $python @('-X','utf8','-c','import tui_gateway.entry, hermes_cli.voice, faster_whisper, sounddevice')
    } else {
      if ($SkipDependencies) { $python=Use-ExistingPython $target $Catalog.python }
      else {
        Write-InstallProgress 'python' 'Создаём окружение Python для Strata'
        if (!(Test-Path -LiteralPath $python)) { Invoke-Checked $uv @('venv','--python',$Catalog.python,'--managed-python',(Join-Path $target '.venv')) }
        Invoke-Checked $python @('-m','ensurepip','--upgrade')
        Write-InstallProgress 'packages' 'Устанавливаем Python-пакеты Strata'
        Invoke-Checked $uv @('pip','install','--python',$python,'-r',(Join-Path $target 'requirements.txt'))
      }
      $enginePackage=Install-StrataEngineComponent $python $target $Root $Item.artifacts.$artifactKey $artifactKey
      Write-InstallProgress 'configure' 'Настраиваем движок Strata'
      $binary=Join-Path $enginePackage 'strata.exe'
      Invoke-Checked $python @('-X','utf8',(Join-Path $PSScriptRoot 'apply_strata_patch.py'),$target,(Join-Path $PSScriptRoot 'strata-api.patch'))
      Write-InstallProgress 'validate' 'Проверяем запуск и зависимости Strata'
      Invoke-Checked $python @('-X','utf8','-c','import sys; sys.path.insert(0,sys.argv[1]); import serve.server',$target)
      Invoke-Checked $binary @('--help')
    }
    $path=$target
  } else {
    Write-InstallProgress 'validate' ('Проверяем '+$Item.name)
    $path=Find-Entry $target $Item.entry
    if ($Item.id -eq 'qwfnfer') { Invoke-Checked $path @() @(0,1) }
    else { Invoke-Checked $path @('--help') }
  }
  if (!(Test-ComponentPath $Item.id $path -AllowIncomplete)) { throw 'Component validation failed.' }
  [IO.File]::WriteAllText($ready,(@{id=$Item.id;version=$Item.version;path=$path;repository=$Item.repository}|ConvertTo-Json),$script:Utf8)
  Publish-Location $Root $Item $path $PreviousPath
  Write-InstallProgress 'ready' ($Item.name+' готов') 100
  return $path
}
function Invoke-ComponentInstaller {
  $catalog=Read-Catalog $CatalogPath
  $existing=Get-Existing $catalog $InstallRoot $AppPath
  if ($Probe) {
    if ($ResultIni) {
      $lines=@('[components]');foreach ($item in $catalog.components) { $lines+=($item.id+'='+[int]$existing.ContainsKey($item.id)) }
      [IO.File]::WriteAllLines($ResultIni,$lines,[Text.Encoding]::ASCII)
    }
    return 0
  }
  $ids=@($Components.Split(',') | Where-Object {$_} | Select-Object -Unique)
  foreach ($id in $ids) { if ($id -notin @($catalog.components.id)) { throw "Unknown component: $id" } }
  if (!$ids.Count) { return 0 }
  [IO.Directory]::CreateDirectory($InstallRoot)|Out-Null
  $script:LogPath=Join-Path $InstallRoot 'install.log'
  $lockPath=Join-Path $InstallRoot '.install.lock'
  $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $failures=@();$results=@()
  try {
    foreach ($id in $ids) {
      $item=$catalog.components|Where-Object {$_.id -eq $id}|Select-Object -First 1
      try {
        if (!$Fresh -and $existing.ContainsKey($id)) {
          $path=$existing[$id];Write-Log "[$($item.name)] Reusing existing installation: $path"
          Publish-Location $InstallRoot @{id=$id;version='existing'} $path
          $results+=@{id=$id;status='reused';path=$path}
        } else {
          Write-Log "[$($item.name)] Installing $($item.version)"
          $previousPath='';if($existing.ContainsKey($id)){$previousPath=[string]$existing[$id]}
          $path=Install-One $item $catalog $InstallRoot $previousPath
          $results+=@{id=$id;status='installed';path=$path}
          Write-Log "[$($item.name)] Ready: $path"
        }
      } catch { $failures+=$id;$results+=@{id=$id;status='failed';error=$_.Exception.Message};Write-Log "[$($item.name)] FAILED: $($_.Exception.Message)" }
    }
    [IO.File]::WriteAllText((Join-Path $InstallRoot 'last-result.json'),(@{schemaVersion=1;components=$results}|ConvertTo-Json -Depth 8),$script:Utf8)
  } finally { $lock.Dispose() }
  if ($failures.Count) { return 1 };return 0
}
if ($MyInvocation.InvocationName -ne '.') {
  try { exit (Invoke-ComponentInstaller) } catch { Write-Host "Component installer failed: $($_.Exception.Message)"; exit 1 }
}
