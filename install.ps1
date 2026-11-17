#Requires -Version 5.1
<#
.SYNOPSIS
  Install or update antigravity-context-plugin for Google Antigravity Desktop on Windows.
  Installs into ~/.gemini/config/plugins/antigravity-context-plugin in-place (copying
  plugin.json last so Antigravity's live directory watcher never locks a temporary
  staging directory or loads a half-copied bundle), without modifying config.json.
#>
param(
  [switch]$Uninstall,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'

if ($ExtraArgs -contains '--uninstall') {
  $Uninstall = $true
}

$PluginName = 'antigravity-context-plugin'
$SrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginsRoot = if ($env:ANTIGRAVITY_PLUGINS_DIR) {
  $env:ANTIGRAVITY_PLUGINS_DIR
} else {
  Join-Path $HOME '.gemini\config\plugins'
}
$DestDir = Join-Path $PluginsRoot $PluginName

function Remove-DirectoryWithRetry {
  param([string]$TargetPath)
  if (-not (Test-Path -LiteralPath $TargetPath)) { return }
  # Remove manifests first so Antigravity's Language Server stops any running sidecar
  # process holding a Windows CWD lock on the directory.
  foreach ($manifest in @(
    (Join-Path $TargetPath 'sidecars\context_panel\sidecar.json'),
    (Join-Path $TargetPath 'plugin.json')
  )) {
    if (Test-Path -LiteralPath $manifest) {
      Remove-Item -LiteralPath $manifest -Force -ErrorAction SilentlyContinue
    }
  }
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try {
      if (-not (Test-Path -LiteralPath $TargetPath)) { return }
      Remove-Item -LiteralPath $TargetPath -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 8) { throw }
      Start-Sleep -Milliseconds 350
    }
  }
}

# Clean up any leftover staging directories inside PluginsRoot if present
if (Test-Path -LiteralPath $PluginsRoot) {
  Get-ChildItem -LiteralPath $PluginsRoot -Force -Directory -Filter ".$PluginName.stage.*" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-DirectoryWithRetry -TargetPath $_.FullName }
}

if ($Uninstall) {
  if (Test-Path -LiteralPath $DestDir) {
    Remove-DirectoryWithRetry -TargetPath $DestDir
    Write-Host "Removed $DestDir"
  } else {
    Write-Host "Plugin is not installed at $DestDir"
  }
  exit 0
}

New-Item -ItemType Directory -Path $DestDir -Force | Out-Null

# Copy assets, hooks, skills, sidecars first, and plugin.json last so Antigravity's
# live watcher discovers the plugin only once all bundle files are present on disk.
$OrderedItems = @(
  'README.md',
  'LICENSE',
  'assets',
  'hooks',
  'hooks.json',
  'skills',
  'sidecars',
  'plugin.json'
)

foreach ($item in $OrderedItems) {
  $srcPath = Join-Path $SrcDir $item
  Copy-Item -LiteralPath $srcPath -Destination $DestDir -Recurse -Force
}

Write-Host "Installed $PluginName -> $DestDir"
Write-Host ""
Write-Host "Usage in Antigravity Desktop:"
Write-Host "  1. Side Pane: click '+' in the conversation header -> 'Context'"
Write-Host "     (or open sidecar://$PluginName/context_panel/)"
Write-Host "  2. Slash Command: type '/context' in any conversation"
Write-Host "  3. Manage in UI: customization://$PluginName"
exit 0
