# Builds src/daemon/win-sender with MSYS2 UCRT64 (g++/cmake/ninja). Native Win32, no WSL.
param([string]$Msys = 'C:\msys64')
$ErrorActionPreference = 'Stop'
$env:PATH = "$Msys\ucrt64\bin;$env:PATH"
$dir = Join-Path $PSScriptRoot '..\src\daemon\win-sender'
cmake -S $dir -B "$dir\build" -G Ninja
if ($LASTEXITCODE) { exit $LASTEXITCODE }
cmake --build "$dir\build"
exit $LASTEXITCODE
