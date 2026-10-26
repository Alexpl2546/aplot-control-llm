param(
    [string]$EngineRoot = "$PSScriptRoot/../../engines/infernix",
    [Parameter(Mandatory=$true)][string]$VcpkgRoot,
    [string]$CudaRoot = $env:CUDA_PATH,
    [string]$BuildRoot
)
$ErrorActionPreference = 'Stop'
$engine = (Resolve-Path -LiteralPath $EngineRoot).Path
$deps = (Resolve-Path -LiteralPath $VcpkgRoot).Path
if (-not $BuildRoot) { $BuildRoot = "$engine/build-windows" }
if (-not $CudaRoot -or -not (Test-Path -LiteralPath "$CudaRoot/bin/nvcc.exe")) { throw 'Specify -CudaRoot for CUDA Toolkit 13.' }
$env:VCPKG_ROOT = $deps
$env:VCPKG_TARGET_TRIPLET = 'x64-windows'
# CUDA's VS integration is selected explicitly; do not depend on the upstream maintainer's paths.
cmake -S $engine -B $BuildRoot -G 'Visual Studio 17 2022' -A x64 "-Tcuda=$CudaRoot" "-DCMAKE_PREFIX_PATH=$deps/installed/x64-windows" -DCMAKE_CUDA_ARCHITECTURES=120a -DINFERNIX_BUILD_APPS=ON -DBUILD_TESTING=ON
if ($LASTEXITCODE -ne 0) { throw 'Infernix configure failed.' }
cmake --build $BuildRoot --config Release -j --target infernix-serve infernix_http_routes_test infernix_openai_schema_test infernix_linear_bf16_a16_test infernix_linear_fp8_a16_test infernix_linear_nvfp4_a16_test infernix_linear_nvfp4_a4_test infernix_offloaded_moe_wide_test
if ($LASTEXITCODE -ne 0) { throw 'Infernix build failed.' }
ctest --test-dir $BuildRoot -C Release --output-on-failure -R 'http_routes|openai_schema|linear_bf16_a16|linear_fp8_a16|linear_nvfp4_a16|linear_nvfp4_a4|offloaded_moe_wide'
if ($LASTEXITCODE -ne 0) { throw 'Infernix serving tests failed.' }
$runtime = "$engine/bin"
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Get-ChildItem -LiteralPath "$BuildRoot/apps/Release" -File | Where-Object { $_.Extension -eq '.dll' -or $_.Name -eq 'infernix-serve.exe' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $runtime -Force }
$licenses = "$runtime/licenses"
New-Item -ItemType Directory -Path $licenses -Force | Out-Null
Copy-Item -LiteralPath "$PSScriptRoot/LICENSE" -Destination "$licenses/Infernix-Apache-2.0.txt" -Force
foreach ($dependency in @('ffmpeg', 'curl', 'zlib')) {
    Copy-Item -LiteralPath "$deps/installed/x64-windows/share/$dependency/copyright" -Destination "$licenses/$dependency.txt" -Force
}
