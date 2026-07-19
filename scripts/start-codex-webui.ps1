param(
  [int]$Port = 9526,
  [string]$DataDir = "",
  [string]$DefaultCwd = "",
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ($DataDir) {
  $env:CODEX_WEBUI_DATA_DIR = [System.IO.Path]::GetFullPath($DataDir)
}
if ($DefaultCwd) {
  $env:CODEX_WEBUI_CWD = (Resolve-Path $DefaultCwd).Path
}
$env:PORT = [string]$Port
$env:HOST = "0.0.0.0"

Push-Location $ProjectRoot
try {
  if (!(Test-Path (Join-Path $ProjectRoot "node_modules"))) {
    npm install
  }
  npm run setup

  if ($Foreground) {
    npm start
    return
  }

  $ResolvedDataDir = if ($env:CODEX_WEBUI_DATA_DIR) {
    $env:CODEX_WEBUI_DATA_DIR
  } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "CodexWebUI"
  } else {
    Join-Path $HOME ".local/share/codex-webui"
  }
  New-Item -ItemType Directory -Force -Path $ResolvedDataDir | Out-Null
  $PidFile = Join-Path $ResolvedDataDir "codex-webui.pid"
  $LogFile = Join-Path $ResolvedDataDir "codex-webui.log"
  $ErrFile = Join-Path $ResolvedDataDir "codex-webui.err.log"

  $Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($Listening) {
    Set-Content -Path $PidFile -Value $Listening[0].OwningProcess -Encoding ascii
    Write-Host "Codex WebUI is already listening on port $Port."
  } else {
    $Process = Start-Process `
      -FilePath "node" `
      -ArgumentList "server/index.js" `
      -WorkingDirectory $ProjectRoot `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $LogFile `
      -RedirectStandardError $ErrFile
    Set-Content -Path $PidFile -Value $Process.Id -Encoding ascii
    Write-Host "Started Codex WebUI (PID $($Process.Id))."
  }

  $FirstToken = (node scripts/token-manager.js list --json | ConvertFrom-Json | Where-Object { $_.disabled -eq $false } | Select-Object -First 1)
  if ($FirstToken) {
    node scripts/token-manager.js qr $FirstToken.id
  }
  Write-Host "Logs: $LogFile"
} finally {
  Pop-Location
}
