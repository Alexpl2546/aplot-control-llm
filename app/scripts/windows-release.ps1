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
Invoke-Checked { npm run verify:docs }
Invoke-Checked { & powershell.exe -NoProfile -NonInteractive -File .\tests\installer-components.ps1 }
Invoke-Checked { python -m unittest discover -s tests -p test_installer_patch.py }
Invoke-Checked { cargo fmt --manifest-path .\src-tauri\Cargo.toml -- --check }
Invoke-Checked { cargo test --locked --manifest-path .\src-tauri\Cargo.toml }
Invoke-Checked { cargo check --locked --manifest-path .\src-tauri\Cargo.toml }
Invoke-Checked { npm run build }
Invoke-Checked { npm run tauri:build }
Invoke-Checked { & powershell.exe -NoProfile -NonInteractive -File .\tests\component-maintenance-cli.ps1 -Binary .\src-tauri\target\release\aplot-control-llm.exe }
Invoke-Checked { & powershell.exe -NoProfile -NonInteractive -File .\tests\installer-ui-acceptance.ps1 -Binary .\src-tauri\target\release\aplot-control-llm.exe }
Invoke-Checked { & python .\tests\installer_download_test.py }

$bundle = Join-Path $PSScriptRoot '..\src-tauri\target\release\bundle'
Write-Host "Release bundle directory: $bundle" -ForegroundColor Green
if (Test-Path $bundle) {
  Get-ChildItem -Path $bundle -Recurse -File | Select-Object FullName, Length
}
