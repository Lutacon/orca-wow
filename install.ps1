# Install or update Orca for World of Warcraft: Forever on Windows.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [--wow "C:\path\World of Warcraft"] [--slots N] [--no-service]
#
# Run it again to update. Copies the bridge and addon to %LOCALAPPDATA%\orca-wow\app,
# adds an orca-wow.cmd launcher next to it, then runs `orca-wow install`, which puts the
# addon into the game, registers the bridge as a logon task and walks you through the
# first launch. Needs Node.js 22 or newer (winget install OpenJS.NodeJS.LTS).

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  # A terminal opened before Node was installed still has the old PATH: read the current one.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $node = Get-Command node -ErrorAction SilentlyContinue
}
if (-not $node) {
  Write-Host 'Orca for World of Warcraft needs Node.js 22 or newer: winget install OpenJS.NodeJS.LTS' -ForegroundColor Red
  exit 1
}
# Parse `node --version` here: Windows PowerShell drops the inner quotes of arguments to programs.
$version = (& $node.Source --version).Trim()
$major = [int]($version.TrimStart('v').Split('.')[0])
if ($major -lt 22) {
  Write-Host "Orca for World of Warcraft needs Node.js 22 or newer; found $version." -ForegroundColor Red
  exit 1
}

$src = $PSScriptRoot
if (-not ((Test-Path (Join-Path $src 'bridge')) -and (Test-Path (Join-Path $src 'addon')))) {
  Write-Host "Run this script from a copy of the repository (it needs the bridge and addon folders next to it)." -ForegroundColor Red
  exit 1
}

$root = Join-Path $env:LOCALAPPDATA 'orca-wow'
$dest = Join-Path $root 'app'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Replace the installed copy as a whole, so files removed upstream don't linger.
foreach ($part in 'bridge', 'addon') {
  $new = Join-Path $dest "$part.new"
  if (Test-Path $new) { Remove-Item -Recurse -Force $new }
  Copy-Item -Recurse -Path (Join-Path $src $part) -Destination $new
  $old = Join-Path $dest $part
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
  Rename-Item -Path $new -NewName $part
}

$cli = Join-Path $dest 'bridge\bin\orca-wow.js'
$launcher = Join-Path $root 'orca-wow.cmd'
# The launcher is UTF-8 (no byte order mark) and switches cmd to UTF-8 before the line
# with Node's path, so a path with accented letters survives; % is doubled because
# batch files expand it. The bridge is found next to the launcher (%~dp0), which cmd
# fills in itself. The console's code page is put back afterwards.
$nodePath = $node.Source.Replace('%', '%%')
$lines = @(
  '@echo off',
  'setlocal',
  'for /f "tokens=2 delims=:" %%c in (''chcp'') do set "orca_cp=%%c"',
  'chcp 65001 >nul',
  "`"$nodePath`" `"%~dp0app\bridge\bin\orca-wow.js`" %*",
  'set "orca_rc=%errorlevel%"',
  'if defined orca_cp chcp %orca_cp:.=% >nul',
  'exit /b %orca_rc%'
)
[IO.File]::WriteAllText($launcher, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding $false))
Write-Host "Command: $launcher (add $root to PATH to type just orca-wow)"

& $node.Source $cli install @args
exit $LASTEXITCODE
