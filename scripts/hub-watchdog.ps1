# Keep the acp-editor hub running: restart it whenever it exits and log everything.
#
#   powershell -NoProfile -File scripts\hub-watchdog.ps1 [-Port 7878] [-Cwd <project>]
#
# Stop with:  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
#               Where-Object CommandLine -like '*hub-watchdog*' | ForEach-Object Stop-Process
param(
  [int]$Port = 7878,
  [string]$Cwd = (Get-Location).Path,
  [string]$Log = (Join-Path (Split-Path $PSScriptRoot -Parent) 'hub.log')
)

$root = Split-Path $PSScriptRoot -Parent
$cli = Join-Path $root 'packages\hub\dist\cli.js'

if (-not (Test-Path $cli)) {
  Write-Error "Build first: pnpm build ($cli not found)"
  exit 1
}

while ($true) {
  node $cli --port $Port --cwd $Cwd 2>&1 |
    ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $Log
  "---- hub exited at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ----" |
    Out-File -Append -Encoding utf8 $Log
  Start-Sleep -Seconds 2
}
