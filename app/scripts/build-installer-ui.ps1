# Windows ships the .NET Framework WPF runtime; no WebView or network is needed to show the wizard.
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installerRoot = Join-Path $appRoot 'src-tauri/installer'
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is required to package the installer UI.' }
$version = (Get-Content -LiteralPath (Join-Path $appRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
$metadata = Join-Path $appRoot 'artifacts/installer-ui'
[IO.Directory]::CreateDirectory($metadata) | Out-Null
$buildInfo = Join-Path $metadata 'build.json'
[IO.File]::WriteAllText($buildInfo,(@{version=$version;product='Aplot Control LLM'}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$references = @('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Windows.Forms.dll','System.Xaml.dll','WPF/WindowsBase.dll','WPF/PresentationCore.dll','WPF/PresentationFramework.dll')
$arguments = @('/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output',('/out:'+(Join-Path $installerRoot 'Aplot-Maintenance.exe')),('/win32icon:'+(Join-Path $appRoot 'src-tauri/icons/icon.ico')),('/win32manifest:'+(Join-Path $installerRoot 'ui/Installer.manifest')))
foreach ($reference in $references) { $arguments += '/reference:'+(Join-Path $framework $reference) }
$arguments += @(
  ('/resource:'+(Join-Path $installerRoot 'ui/Installer.xaml')+',Installer.xaml'),
  ('/resource:'+(Join-Path $installerRoot 'components.json')+',components.json'),
  ('/resource:'+(Join-Path $installerRoot 'licenses.json')+',licenses.json'),
  ('/resource:'+$buildInfo+',build.json'),
  ('/resource:'+(Join-Path $appRoot 'src-tauri/icons/128x128.png')+',logo.png'),
  ('/resource:'+(Join-Path $appRoot '../LICENSE')+',license.txt'),
  (Join-Path $installerRoot 'ui/Installer.cs')
)
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Installer UI compilation failed.' }
$testReport=Join-Path $metadata 'self-test.json'
$testProcess=Start-Process -FilePath (Join-Path $installerRoot 'Aplot-Maintenance.exe') -ArgumentList @('--self-test',('"'+$testReport+'"')) -WindowStyle Hidden -PassThru -Wait
if ($testProcess.ExitCode -ne 0) { throw 'Installer policy tests failed; see the wizard error in TEMP.' }
Get-Content -LiteralPath $testReport -Raw
