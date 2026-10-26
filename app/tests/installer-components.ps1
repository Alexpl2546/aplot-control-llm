$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\src-tauri\installer\Install-Components.ps1')
function Assert([bool]$Condition,[string]$Message) { if (!$Condition) { throw $Message } }
function Rejects([scriptblock]$Action,[string]$Message) { $failed=$false;try { & $Action } catch { $failed=$true };Assert $failed $Message }
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('aplot-installer-tests-'+[guid]::NewGuid())
[IO.Directory]::CreateDirectory($testRoot)|Out-Null
try {
  $catalog=Read-Catalog $CatalogPath
  Assert (@($catalog.components).Count -eq 5) 'Only two engines and three supported agents must be selectable.'
  Assert ((@($catalog.components | Where-Object { $_.kind -eq 'engine' } | ForEach-Object { $_.id } | Sort-Object) -join ',') -eq 'llama_cpp,strata') 'Only llama.cpp and Strata may be installed as local engines.'
  Assert (@($catalog.components|Where-Object {$_.kind -eq 'agent' -and $_.id -in @('hermes','codex','claude')}).Count -eq 3) 'Only implemented Hermes, Codex and Claude agents are offered.'
  Rejects { Assert-Artifact @{url='https://example.com/unsigned.zip';sha256=('a'*64)} } 'Reject third-party download URLs.'
  Rejects { Assert-Artifact @{url='https://github.com/unknown/repo/releases/download/v1/a.zip';sha256=('a'*64)} } 'Reject unreviewed repositories.'
  Rejects { Assert-Artifact @{url='https://github.com/ggml-org/llama.cpp/releases/download/v1/a.zip';sha256=''} } 'SHA-256 must be present.'
  $InstallRoot=Join-Path $testRoot 'express';$Components='';$Probe=$false;$Fresh=$false;$AppPath=''
  Assert ((Invoke-ComponentInstaller) -eq 0) 'Express mode should succeed without optional components.'
  Assert (!(Test-Path -LiteralPath $InstallRoot)) 'Express mode must not create component directories.'
  $Components='ollama';Rejects { Invoke-ComponentInstaller } 'Removed legacy engines cannot be installed.'
  $Components='unknown';Rejects { Invoke-ComponentInstaller } 'Unknown component IDs must fail before downloading.'

  $InstallRoot=Join-Path $testRoot 'custom';[IO.Directory]::CreateDirectory($InstallRoot)|Out-Null
  $binary=Join-Path $testRoot 'llama-server.exe';[IO.File]::WriteAllText($binary,'existing fixture')
  $legacy=Join-Path $testRoot 'ollama.exe';[IO.File]::WriteAllText($legacy,'legacy installation')
  [IO.File]::WriteAllText((Join-Path $InstallRoot 'installations.json'),(@{components=@(@{id='llama_cpp';path=$binary;version='original'},@{id='ollama';path=$legacy;version='legacy'})}|ConvertTo-Json -Depth 6))
  Assert (!(Test-ComponentPath 'ollama' $legacy)) 'An external legacy engine must not be registered as supported.'
  $found=Get-Existing $catalog $InstallRoot ''
  Assert (!$found.ContainsKey('ollama')) 'An old manifest entry must not be reused or rewritten as an active engine.'
  $Components='llama_cpp'
  Assert ((Invoke-ComponentInstaller) -eq 0) 'Existing installations must be reused.'
  $result=Get-Content -LiteralPath (Join-Path $InstallRoot 'last-result.json') -Raw|ConvertFrom-Json
  Assert ($result.components[0].status -eq 'reused') 'Reuse must be explicit in the result.'
  Assert (!(Test-Path -LiteralPath (Join-Path $InstallRoot 'downloads'))) 'Reuse must not download an archive.'
  $saved=Get-Content -LiteralPath (Join-Path $InstallRoot 'installations.json') -Raw|ConvertFrom-Json
  Assert ((@($saved.components | Where-Object { $_.id -eq 'llama_cpp' })[0].version -eq 'original')) 'Reuse must preserve a known version.'
  Assert (([IO.File]::ReadAllText($binary)) -eq 'existing fixture') 'Never overwrite external installations.'
  Assert (([IO.File]::ReadAllText($legacy)) -eq 'legacy installation') 'An update must preserve an external legacy engine.'

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath=Join-Path $testRoot 'traversal.zip'
  $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
  $entry=$zip.CreateEntry('../escape.txt');$writer=New-Object IO.StreamWriter($entry.Open());$writer.Write('escape');$writer.Dispose();$zip.Dispose()
  Rejects { Expand-VerifiedZip $zipPath (Join-Path $testRoot 'extract') } 'ZIP traversal must be rejected.'
  Assert (!(Test-Path -LiteralPath (Join-Path $testRoot 'escape.txt'))) 'Archive must not write outside staging.'

  $script:Downloads=0
  function Receive-InstallerFile { param($Uri,$Path);$script:Downloads++;[IO.File]::WriteAllText($Path,'bad archive') }
  $artifact=@{url='https://github.com/ggml-org/llama.cpp/releases/download/v1/a.zip';sha256=('0'*64)}
  Rejects { Get-VerifiedArchive $artifact $InstallRoot } 'Reject a corrupt download before extraction.'
  Assert (!(Test-Path -LiteralPath (Join-Path $InstallRoot ('downloads/'+('0'*64)+'.zip')))) 'A bad archive must never enter the verified cache.'

  function Get-CimInstance { param($ClassName,$ErrorAction);[pscustomobject]@{Name='NVIDIA RTX 5080'} }
  $Components='strata,llama_cpp';$Fresh=$false
  Assert ((Invoke-ComponentInstaller) -eq 1) 'A failed optional component must return a failure status.'
  $result=Get-Content -LiteralPath (Join-Path $InstallRoot 'last-result.json') -Raw|ConvertFrom-Json
  Assert ($result.components[0].status -eq 'failed' -and $result.components[1].status -eq 'reused') 'Keep processing independent selected components after a download failure.'
  Assert (([IO.File]::ReadAllText($binary)) -eq 'existing fixture') 'Failure must preserve existing components.'
  Assert-Artifact $catalog.dependencies.msvc
  Rejects { Assert-Artifact @{url='https://download.visualstudio.microsoft.com/unreviewed.exe';sha256=('a'*64)} } 'Only the reviewed Microsoft download route is allowed.'
  & {
    $SkipDependencies=$true
    function Get-Uv { throw 'Disabled dependencies must not download uv or Python.' }
    function Install-VcRuntime { throw 'Disabled dependencies must not install a system runtime.' }
    function Invoke-Checked { param($Executable,$Arguments,$AllowedExitCodes);Assert ($Executable -like '*python.exe') 'Only an existing Python environment may be checked.' }
    $item=[pscustomobject]@{id='hermes';method='hermes';version='test';python='3.14';repository='https://github.com/NousResearch/hermes-agent';dependencyIds=@('python')}
    $target=Join-Path $testRoot 'no-dependencies/hermes/test'
    [IO.Directory]::CreateDirectory((Join-Path $target '.venv/Scripts'))|Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $target 'tui_gateway'))|Out-Null
    [IO.File]::WriteAllText((Join-Path $target '.venv/Scripts/python.exe'),'fixture')
    [IO.File]::WriteAllText((Join-Path $target 'tui_gateway/entry.py'),'fixture')
    [IO.File]::WriteAllText((Join-Path $target 'aplot-installing.json'),'{"id":"hermes"}')
    Assert (!(Test-ComponentPath 'hermes' $target)) 'A prepared but unfinished agent must not be reused as a ready installation.'
    $path=Install-One $item $catalog (Join-Path $testRoot 'no-dependencies')
    Assert ($path -eq $target) 'An existing environment should work with dependency installation disabled.'
    Assert (!(Test-Path -LiteralPath (Join-Path $testRoot 'no-dependencies/downloads'))) 'Dependency opt-out must not download packages.'
  }
  & {
    $script:progressEvents=New-Object 'Collections.Generic.List[object]'
    function Write-InstallProgress { param($Stage,$Title,$Percent,$Detail,$Downloaded,$Total,$Rate);$script:progressEvents.Add(@{stage=$Stage;title=$Title;percent=$Percent;downloaded=$Downloaded;total=$Total;rate=$Rate}) }
    $bytes=New-Object byte[] 700000
    $inputStream=New-Object IO.MemoryStream(,$bytes);$outputStream=New-Object IO.MemoryStream
    try {
      Copy-DownloadStream $inputStream $outputStream $bytes.Length
      Assert ($outputStream.Length -eq $bytes.Length) 'The stream must copy all downloaded bytes.'
      Assert ($script:progressEvents[0].percent -eq 0 -and $script:progressEvents[$script:progressEvents.Count-1].percent -eq 100) 'Known download lengths must emit real 0–100 progress.'
      Assert ($script:progressEvents[$script:progressEvents.Count-1].downloaded -eq $bytes.Length) 'Reported download size must match actual output bytes.'
    } finally {$inputStream.Dispose();$outputStream.Dispose()}
    $inputStream=New-Object IO.MemoryStream(,[byte[]]@(1,2,3));$outputStream=New-Object IO.MemoryStream
    try { Rejects { Copy-DownloadStream $inputStream $outputStream 10 } 'Truncated downloads must fail before hash/extraction.' } finally {$inputStream.Dispose();$outputStream.Dispose()}
  }
  Write-Host 'PASS: catalog, express, selection, reuse, archive scope, SHA-256, partial failure, Microsoft allowlist and dependency opt-out.'
} finally {
  $resolved=[IO.Path]::GetFullPath($testRoot)
  $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
  if ($resolved.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($resolved)).StartsWith('aplot-installer-tests-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
