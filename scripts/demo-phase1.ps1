# Phase 1 live demo. Run one role per terminal tab:
#   ./scripts/demo-phase1.ps1 receiver   (plays the Mac)
#   ./scripts/demo-phase1.ps1 sender     (the Windows daemon)
#   ./scripts/demo-phase1.ps1 view       (live listing of the mirrored folder)
# Then edit/add/delete/rename files in  demo\windows-side  and watch  demo\mac-side.
param([Parameter(Mandatory)][ValidateSet('receiver','sender','view','reset')][string]$Role)
$root = (Resolve-Path "$PSScriptRoot\..").Path
$src = "$root\demo\windows-side"; $dst = "$root\demo\mac-side"
$env:CROSSDOCK_LOG_DIR = "$root\demo\logs"
New-Item -ItemType Directory -Force $src, $dst | Out-Null
switch ($Role) {
  'receiver' { node "$root\src\daemon\mac-listener\listener.js" --root $dst --port 9477 --host 127.0.0.1 }
  'sender'   { & "$root\src\daemon\win-sender\build\win-sender.exe" --dir $src --host 127.0.0.1 --port 9477 --telemetry "$root\demo\sync-telemetry.json" }
  'reset'    { Remove-Item "$src\*","$dst\*" -Recurse -Force -ErrorAction SilentlyContinue; "cleared" }
  'view' {
    while ($true) {
      Clear-Host
      Write-Host "WINDOWS SIDE  $src" -ForegroundColor Cyan
      Get-ChildItem $src -Recurse -File | % { "  {0,-45} {1,8} B   {2:HH:mm:ss.fff}" -f $_.FullName.Substring($src.Length+1), $_.Length, $_.LastWriteTime }
      Write-Host "`nMAC SIDE      $dst" -ForegroundColor Green
      Get-ChildItem $dst -Recurse -File | % { "  {0,-45} {1,8} B   {2:HH:mm:ss.fff}" -f $_.FullName.Substring($dst.Length+1), $_.Length, $_.LastWriteTime }
      if (Test-Path "$root\demo\sync-telemetry.json") {
        $t = Get-Content "$root\demo\sync-telemetry.json" -Raw | ConvertFrom-Json
        Write-Host "`nTCP: $($t.connection.tcp)   last syncs (latency):" -ForegroundColor Yellow
        $t.syncs | Select-Object -First 5 | % { "  {0,-35} {1,7:N1} ms" -f $_.path, $_.latencyMs }
      }
      Start-Sleep -Milliseconds 250
    }
  }
}
