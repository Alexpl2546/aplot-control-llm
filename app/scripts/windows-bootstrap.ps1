$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

function Invoke-Checked([scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE`: $Command" }
}

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command '$Name'. $Hint"
  }
}

Write-Host 'Aplot Control LLM - Windows bootstrap' -ForegroundColor Cyan
Require-Command node 'Install Node.js 22.12 or newer.'
Require-Command npm 'npm should be installed together with Node.js.'
Require-Command rustc 'Install Rust stable with the MSVC toolchain from rustup.rs.'
Require-Command cargo 'Install Rust stable with the MSVC toolchain from rustup.rs.'

Write-Host "Node:  $(node --version)"
Write-Host "npm:   $(npm --version)"
Write-Host "Rust:  $(rustc --version)"
Write-Host "Cargo: $(cargo --version)"

if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  Write-Host 'NVIDIA telemetry: detected' -ForegroundColor Green
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
} else {
  Write-Warning 'nvidia-smi was not found. The app can run, but NVIDIA telemetry will be unavailable.'
}

Write-Host 'Installing npm dependencies...'
Invoke-Checked { npm ci }

Write-Host 'Running TypeScript and static validation...'
Invoke-Checked { npm run typecheck }
Invoke-Checked { node .\scripts\validate-static.mjs }

Write-Host 'Fetching/checking Rust dependencies...'
Invoke-Checked { cargo check --locked --manifest-path .\src-tauri\Cargo.toml }

Write-Host 'Running frontend unit tests...'
Invoke-Checked { npm test }

Write-Host 'Bootstrap validation completed.' -ForegroundColor Green
Write-Host 'Next: npm run tauri:dev'
