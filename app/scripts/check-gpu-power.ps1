# Read-only NVIDIA driver readings for comparison on the computer being tested.
param(
  [ValidateRange(1,60)][int]$Samples=10,
  [ValidateRange(200,5000)][int]$IntervalMs=1000,
  [string]$ReportPath=(Join-Path $PSScriptRoot 'gpu-power-report.json')
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$command=Get-Command 'nvidia-smi.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
$fields='name,uuid,driver_version,power.draw,power.draw.instant,power.draw.average,power.limit,enforced.power.limit'
function Read-Driver([string]$Fields) {
  # Older nvidia-smi versions write an unsupported-field diagnostic to stderr.
  $ErrorActionPreference='Continue'
  $text=@(& $command.Source "--query-gpu=$Fields" '--format=csv,noheader,nounits' 2>&1 | ForEach-Object {"$_"})
  return @{text=$text;exitCode=$LASTEXITCODE}
}
$rows=@()
for ($sample=0;$sample -lt $Samples;$sample++) {
  $time=[DateTimeOffset]::Now.ToString('o')
  $result=Read-Driver $fields
  $output=$result.text;$exitCode=$result.exitCode
  if ($exitCode -ne 0) {
    $fields='name,uuid,driver_version,power.draw,power.limit'
    $result=Read-Driver $fields
    $output=$result.text;$exitCode=$result.exitCode
  }
  $rows+=@{timestamp=$time;fields=$fields;exitCode=$exitCode;readings=$output}
  Write-Output ($time+' '+($output -join ' | '))
  if ($sample+1 -lt $Samples) {Start-Sleep -Milliseconds $IntervalMs}
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath),(@{source='nvidia-smi';units='watts';samples=$rows}|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
Write-Output ('Report: '+[IO.Path]::GetFullPath($ReportPath))
