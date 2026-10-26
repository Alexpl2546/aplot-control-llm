# Actual NSIS in-place repair, using a file-only test backend: no registry, shortcuts or user data.
param(
  [Parameter(Mandatory=$true)][string]$Binary,
  [string]$Wizard=''
)
$ErrorActionPreference='Stop'
if (!$Wizard) { $Wizard=Join-Path $PSScriptRoot '../src-tauri/installer/Aplot-Maintenance.exe' }
$Binary=(Resolve-Path -LiteralPath $Binary).Path
$Wizard=(Resolve-Path -LiteralPath $Wizard).Path
$compiler=Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Build the NSIS package first.' }
$fixture=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('../artifacts/installer-ui/acceptance-'+[guid]::NewGuid())))
[IO.Directory]::CreateDirectory($fixture)|Out-Null
$target=Join-Path $fixture 'Обновление Aplot With Spaces'
[IO.Directory]::CreateDirectory($target)|Out-Null
$policy=[Reflection.Assembly]::LoadFile($Wizard).GetType('AplotInstaller.Policy')
$argumentMethod=$policy.GetMethod('Arguments',[Reflection.BindingFlags]'Public,Static')
$installMethod=$policy.GetMethod('InstallArguments',[Reflection.BindingFlags]'Public,Static')
$core=Join-Path $fixture 'file-only-core.exe'
$script=Join-Path $fixture 'file-only-core.nsi'
$source=@'
Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
!include "SHORTCUT_POLICY"
!insertmacro APLOT_SHORTCUT_VARIABLES
RequestExecutionLevel user
Name "Aplot file-only test"
OutFile "CORE"
InstallDir "TARGET"
Function .onInit
!insertmacro APLOT_SHORTCUT_ARGUMENTS
FunctionEnd
Section
SetOutPath $INSTDIR
File /oname=aplot-control-llm.exe "BINARY"
WriteUninstaller "$INSTDIR\uninstall.exe"
${If} $AplotDesktopShortcut == 1
CreateDirectory "$INSTDIR\desktop"
CreateShortcut "$INSTDIR\desktop\Aplot.lnk" "$INSTDIR\aplot-control-llm.exe"
${EndIf}
${If} $AplotStartMenuShortcut == 1
CreateDirectory "$INSTDIR\startmenu"
CreateShortcut "$INSTDIR\startmenu\Aplot.lnk" "$INSTDIR\aplot-control-llm.exe"
${EndIf}
SectionEnd
Section Uninstall
; This acceptance backend deliberately performs no deletion or registry operations.
SectionEnd
'@
$source=$source.Replace('CORE',$core).Replace('TARGET',$target).Replace('BINARY',$Binary)
$source=$source.Replace('SHORTCUT_POLICY',([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src-tauri/installer/shortcuts.nsh'))))
[IO.File]::WriteAllText($script,$source,[Text.UTF8Encoding]::new($true))
& $compiler /V2 $script
if ($LASTEXITCODE -ne 0) { throw 'NSIS acceptance compilation failed.' }
$sentinels=@{}
foreach ($name in @('data/settings.json','models/model.gguf','project/work.md')) {
  $file=Join-Path $target $name
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))|Out-Null
  [IO.File]::WriteAllText($file,('keep-'+$name),[Text.UTF8Encoding]::new($false))
  $sentinels[$file]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
}
$installed=Join-Path $target 'aplot-control-llm.exe'
[IO.File]::WriteAllText($installed,'old version fixture')
$expected=(Get-FileHash -LiteralPath $Binary -Algorithm SHA256).Hash
for ($attempt=1;$attempt -le 2;$attempt++) {
  $nativeArguments=[string[]]@('/S',('/D='+$target))
  $encoded=[string]$argumentMethod.Invoke($null,@(,$nativeArguments))
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$core;$start.Arguments=$encoded;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $process=[Diagnostics.Process]::Start($start)
  if (!$process.WaitForExit(30000)) { $process.Kill();throw 'NSIS test timed out.' }
  if ($process.ExitCode -ne 0) { throw ('NSIS failed: '+$process.ExitCode) }
  if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $expected) { throw 'The installed application does not match the packaged binary.' }
  if (!(Test-Path -LiteralPath (Join-Path $target 'uninstall.exe'))) { throw 'Uninstaller missing.' }
  if ((Test-Path -LiteralPath (Join-Path $target 'desktop/Aplot.lnk')) -or (Test-Path -LiteralPath (Join-Path $target 'startmenu/Aplot.lnk'))) { throw 'Silent installation must not create unrequested shortcuts.' }
  foreach ($file in $sentinels.Keys) {
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $sentinels[$file]) { throw ('User data changed: '+$file) }
  }
}
foreach ($choice in @(@($false,$false),@($true,$false),@($false,$true),@($true,$true))) {
  $shortcutTarget=Join-Path $fixture ('choices-'+[int]$choice[0]+'-'+[int]$choice[1])
  $nativeArguments=[string[]]$installMethod.Invoke($null,@($shortcutTarget.ToString(),[bool]$choice[0],[bool]$choice[1]))
  $encoded=[string]$argumentMethod.Invoke($null,@(,$nativeArguments))
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$core;$start.Arguments=$encoded;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $process=[Diagnostics.Process]::Start($start)
  if (!$process.WaitForExit(30000)) {$process.Kill();throw 'Shortcut fixture timed out.'}
  if ($process.ExitCode -ne 0) {throw 'Shortcut fixture failed.'}
  if ((Test-Path -LiteralPath (Join-Path $shortcutTarget 'desktop/Aplot.lnk')) -ne $choice[0]) {throw 'Desktop shortcut did not match explicit choice.'}
  if ((Test-Path -LiteralPath (Join-Path $shortcutTarget 'startmenu/Aplot.lnk')) -ne $choice[1]) {throw 'Start Menu shortcut did not match explicit choice.'}
}
Write-Host 'PASS: actual shared NSIS shortcut policy, default off and all four independent choices; all links confined to the fixture.'
$progressScript=Join-Path $fixture 'progress-stream.ps1'
$progressLog=Join-Path $fixture 'progress.log'
$installerScript=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src-tauri/installer/Install-Components.ps1'))
$progressSource=@'
. 'INSTALLER_SCRIPT'
$bytes=New-Object byte[] 700000
$inputStream=New-Object IO.MemoryStream(,$bytes)
$outputStream=New-Object IO.MemoryStream
try { Copy-DownloadStream $inputStream $outputStream $bytes.Length } finally {$inputStream.Dispose();$outputStream.Dispose()}
'@
[IO.File]::WriteAllText($progressScript,$progressSource.Replace('INSTALLER_SCRIPT',$installerScript.Replace("'","''")),[Text.UTF8Encoding]::new($true))
& powershell.exe -NoProfile -NonInteractive -File $progressScript *> $progressLog
if ($LASTEXITCODE -ne 0) {throw 'PowerShell progress fixture failed.'}
$readProgress=$policy.GetMethod('ReadProgress',[Reflection.BindingFlags]'Public,Static')
$events=@(Get-Content -LiteralPath $progressLog -Encoding UTF8 | ForEach-Object {$event=$readProgress.Invoke($null,@([string]$_));if($null -ne $event){$event}})
if ($events.Count -lt 2 -or $events[0].percent -ne 0 -or $events[-1].percent -ne 100 -or $events[-1].downloaded -ne 700000 -or $events[0].title -ne 'Загружаем архив') {throw 'PowerShell to WPF progress contract or Russian encoding failed.'}
Write-Host 'PASS: actual PowerShell byte-stream progress parsed by the WPF policy; byte counts, percentages and Russian UTF-8 labels.'
Write-Host 'PASS: actual NSIS update and repeat repair, WPF argument encoding, Unicode/spaced directory, binary SHA-256, uninstaller and preserved data/models/project.'
Write-Host ('Isolated fixture: '+$fixture)
