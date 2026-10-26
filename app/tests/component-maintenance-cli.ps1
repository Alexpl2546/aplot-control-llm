# Acceptance against a built native EXE. All fixtures live in a new, isolated temporary folder.
param([Parameter(Mandatory=$true)][string]$Binary)
$ErrorActionPreference = 'Stop'
$Binary = (Resolve-Path -LiteralPath $Binary).Path
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('aplot-component-removal-cli-'+[guid]::NewGuid())
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$fixture = [IO.Path]::GetFullPath($fixture)
$componentRoot = Join-Path $fixture 'Aplot Control LLM/components'
$modelsRoot = Join-Path $fixture 'Downloads/Aplot Models'
$utf8 = [Text.UTF8Encoding]::new($false)
function Assert([bool]$Value,[string]$Message) { if (!$Value) { throw $Message } }
function Write-Json([string]$Path,$Value) { [IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 8),$utf8) }
function Get-TreeSnapshot([string]$Root) {
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $rows = @(Get-ChildItem -LiteralPath $fullRoot -Force -Recurse | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($fullRoot.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
    if ($_.PSIsContainer) {
      [pscustomobject]@{path=$relative;kind='directory';sha256=$null}
    } else {
      [pscustomobject]@{path=$relative;kind='file';sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
    }
  })
  return ConvertTo-Json -InputObject $rows -Compress -Depth 4
}
function Module([string]$Id) {
  $path = Join-Path $componentRoot ($Id+'/v1')
  [IO.Directory]::CreateDirectory($path) | Out-Null
  $entry = if ($Id -eq 'llama_cpp') { Join-Path $path 'llama-server.exe' } else { Join-Path $path 'fixture.bin' }
  $markerPath = if ($Id -eq 'llama_cpp') { $entry } else { $path }
  Write-Json (Join-Path $path 'aplot-component.json') @{id=$Id;version='v1';path=$markerPath}
  [IO.File]::WriteAllText($entry,'owned',$utf8)
  return $path
}
function Run-Cli([string[]]$Arguments) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$Binary; $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.EnvironmentVariables['LOCALAPPDATA']=$fixture
  $start.EnvironmentVariables['APPDATA']=$fixture
  $start.EnvironmentVariables['APLOT_COMPONENT_ROOT']=$componentRoot
  $start.Arguments=($Arguments | ForEach-Object { '"'+$_+'"' }) -join ' '
  $process=[Diagnostics.Process]::Start($start)
  if (!$process.WaitForExit(30000)) { $process.Kill(); throw 'Native maintenance timed out.' }
  return $process.ExitCode
}
$llama=Module 'llama_cpp'; $hermes=Module 'hermes'; $legacy=Module 'ollama'
foreach ($name in @('downloads','python','tools')) {
  $folder=Join-Path $componentRoot $name; [IO.Directory]::CreateDirectory($folder) | Out-Null
  [IO.File]::WriteAllText((Join-Path $folder 'fixture.bin'),'shared',$utf8)
}
$project=Join-Path $fixture 'project'; [IO.Directory]::CreateDirectory($project) | Out-Null
$projectFile=Join-Path $project 'keep.md'; [IO.File]::WriteAllText($projectFile,'project',$utf8)
$stagingId=[guid]::NewGuid().ToString()
$staging=Join-Path $modelsRoot ('.aplot-staging/'+$stagingId)
$installed=Join-Path $modelsRoot ('installed-model-'+[guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($staging) | Out-Null
[IO.Directory]::CreateDirectory($installed) | Out-Null
[IO.File]::WriteAllText((Join-Path $staging 'model.gguf.part'),'incomplete-model-bytes',$utf8)
Write-Json (Join-Path $staging 'checkpoint.json') @{downloadId=$stagingId;completedBytes=22;state='downloading'}
[IO.File]::WriteAllText((Join-Path $installed 'model.gguf'),'installed-model-bytes',$utf8)
Write-Json (Join-Path $installed 'manifest.json') @{files=@('model.gguf');revision='fixture-commit'}
$modelsBefore=Get-TreeSnapshot $modelsRoot

# Seed a separate app-data DB with real download and installation history rows.
$python=Get-Command python -ErrorAction SilentlyContinue
if (!$python) { $python=Get-Command python3 -ErrorAction SilentlyContinue }
Assert ([bool]$python) 'Python 3 is required to build the isolated SQLite history fixture.'
$historyDirectory=Join-Path $fixture 'app.aplot.llamacontrol'
[IO.Directory]::CreateDirectory($historyDirectory) | Out-Null
$historyDb=Join-Path $historyDirectory 'llama-control.sqlite3'
$historyHelper=Join-Path $fixture 'model-history-fixture.py'
$historySource=@'
import json, sqlite3, sys
mode, database, installed_path = sys.argv[1:]
if mode == "seed":
    with sqlite3.connect(database) as db:
        db.execute("PRAGMA journal_mode=DELETE")
        db.executescript("""
          CREATE TABLE model_downloads(id TEXT PRIMARY KEY, task_json TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE model_download_files(download_id TEXT NOT NULL, path TEXT NOT NULL, file_json TEXT NOT NULL, PRIMARY KEY(download_id,path));
          CREATE TABLE model_installations(id TEXT PRIMARY KEY, installed_path TEXT NOT NULL, manifest_json TEXT NOT NULL, installed_at TEXT NOT NULL);
        """)
        db.execute("INSERT INTO model_downloads VALUES(?,?,?)", ("fixture-download", json.dumps({"id":"fixture-download","state":"interrupted"}, separators=(",", ":")), "2026-10-22T10:00:00Z"))
        db.execute("INSERT INTO model_download_files VALUES(?,?,?)", ("fixture-download", "model.gguf", json.dumps({"state":"partial","bytesDownloaded":22}, separators=(",", ":"))))
        db.execute("INSERT INTO model_installations VALUES(?,?,?,?)", ("fixture-download", installed_path, json.dumps({"files":["model.gguf"]}, separators=(",", ":")), "2026-10-22T10:00:00Z"))
else:
    with sqlite3.connect("file:" + database.replace("\\", "/") + "?mode=ro", uri=True) as db:
        snapshot = {}
        for table, order in (("model_downloads", "id"), ("model_download_files", "download_id,path"), ("model_installations", "id")):
            snapshot[table] = db.execute("SELECT * FROM " + table + " ORDER BY " + order).fetchall()
        print(json.dumps(snapshot, sort_keys=True, separators=(",", ":")))
'@
[IO.File]::WriteAllText($historyHelper,$historySource,$utf8)
& $python.Source $historyHelper seed $historyDb $installed
Assert ($LASTEXITCODE -eq 0) 'Could not seed isolated model history database.'
$historyBefore=(& $python.Source $historyHelper snapshot $historyDb '') -join "`n"
Assert ($LASTEXITCODE -eq 0 -and $historyBefore.Contains('fixture-download')) 'Model history fixture rows are missing.'
Write-Json (Join-Path $componentRoot 'installations.json') @{schemaVersion=1;components=@(@{id='llama_cpp';path=(Join-Path $llama 'llama-server.exe');version='v1'},@{id='hermes';path=$projectFile;version='existing'})}
$inventory=Join-Path $fixture 'inventory.ini'; $report=Join-Path $fixture 'removal.json'
Assert ((Run-Cli @('--component-removal-inventory',$inventory)) -eq 0) 'Inventory failed'
Assert ((Get-Content -LiteralPath $inventory -Raw) -match 'llama_cpp=1') 'Owned module is missing'
$state=Join-Path $fixture 'state.json'
Assert ((Run-Cli @('--component-maintenance-state',$state,$project)) -eq 0) 'Wizard state failed'
$nativeState=Get-Content -LiteralPath $state -Raw -Encoding UTF8 | ConvertFrom-Json
Assert (@($nativeState.modules | Where-Object { $_.id -eq 'llama_cpp' -and $_.paths.Count -eq 1 }).Count -eq 1) 'Wizard module paths missing'
Assert (@($nativeState.modules | Where-Object { $_.id -eq 'ollama' }).Count -eq 0) 'Legacy engines must be hidden from maintenance.'
Assert ((Run-Cli @('--remove-components','../llama_cpp',$report)) -eq 1) 'Unknown selection accepted'
Assert ((Run-Cli @('--remove-components','ollama',$report)) -eq 1) 'Legacy engine removal was not rejected.'
Assert (Test-Path -LiteralPath $legacy) 'Update maintenance removed a legacy engine.'
Assert (Test-Path -LiteralPath $llama) 'Invalid request deleted files'
Assert ((Run-Cli @('--remove-components','python_runtime',$report)) -eq 1) 'Dependency guard failed'
Assert ((Run-Cli @('--remove-components','llama_cpp,cache',$report)) -eq 0) 'Selective removal failed'
Assert (!(Test-Path -LiteralPath $llama)) 'Selected module remains'
Assert (!(Test-Path -LiteralPath (Join-Path $componentRoot 'downloads'))) 'Cache remains'
Assert ((Get-TreeSnapshot $modelsRoot) -ceq $modelsBefore) 'Cache removal changed external model files, installed sets, or incomplete staging data.'
Assert (Test-Path -LiteralPath $historyDb) 'Cache removal deleted the independent model history database.'
$historyAfter=(& $python.Source $historyHelper snapshot $historyDb '') -join "`n"
Assert ($LASTEXITCODE -eq 0 -and $historyAfter -ceq $historyBefore) 'Cache removal changed model_downloads or model_installations history.'
Assert (Test-Path -LiteralPath $hermes) 'Unselected module deleted'
Assert (Test-Path -LiteralPath $projectFile) 'External project deleted'
Assert ((Get-Content -LiteralPath (Join-Path $componentRoot 'installations.json') -Raw) -match 'existing') 'External registration deleted'
Assert ((Run-Cli @('--remove-components','hermes,python_runtime',$report)) -eq 0) 'Combined dependency removal failed'
Assert (!(Test-Path -LiteralPath $hermes)) 'Hermes remains'
Assert (!(Test-Path -LiteralPath (Join-Path $componentRoot 'python'))) 'Shared Python remains'
Assert (Test-Path -LiteralPath $projectFile) 'Project was not preserved'
Write-Host 'PASS: native inventory, selection guard, dependency guard, selective removal, cache, manifest and external-data preservation.'
Write-Host ('Fixture/report: '+$fixture)
