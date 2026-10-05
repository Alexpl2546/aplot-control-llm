$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

function Invoke-Checked([scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE`: $Command" }
}

Write-Host 'Aplot Control LLM - release verification' -ForegroundColor Cyan
Invoke-Checked { npm ci }
Invoke-Checked { npm run typecheck }
Invoke-Checked { npm test }
Invoke-Checked { npm run verify:source }
Invoke-Checked { cargo fmt --manifest-path .\src-tauri\Cargo.toml -- --check }
Invoke-Checked { cargo test --locked --manifest-path .\src-tauri\Cargo.toml }
Invoke-Checked { cargo check --locked --manifest-path .\src-tauri\Cargo.toml }
Invoke-Checked { npm run build }
Invoke-Checked { npm run tauri:build }

$bundle = Join-Path $PSScriptRoot '..\src-tauri\target\release\bundle'
Write-Host "Release bundle directory: $bundle" -ForegroundColor Green
if (Test-Path $bundle) {
  Get-ChildItem -Path $bundle -Recurse -File | Select-Object FullName, Length
}
