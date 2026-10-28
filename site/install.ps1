#Requires -Version 5.1
<#
.SYNOPSIS
  Installs albertheijn-mcp on Windows.

.DESCRIPTION
  irm https://danieltyukov.github.io/albertheijn-mcp/install.ps1 | iex

  To skip client setup:
  iex "& { $(irm https://danieltyukov.github.io/albertheijn-mcp/install.ps1) } -NoSetup"

  Set $env:AH_MCP_VERSION to install an exact version instead of the latest release.

  What it does: checks for Node.js 20 or newer, installs the package globally with npm
  (falling back to the GitHub release tarball when the package is not on the registry),
  writes the MCP config of the clients it finds, and tells you to run "albertheijn-mcp login".
#>
param(
  [switch]$NoSetup
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Host "error: $Message" -ForegroundColor Red
  exit 1
}

function Show-NodeHint {
  Write-Host 'albertheijn-mcp needs Node.js 20 or newer.'
  Write-Host 'Install it with:  winget install OpenJS.NodeJS.LTS'
  Write-Host 'or download the LTS installer from https://nodejs.org'
  Write-Host 'Then open a new terminal and run this installer again.'
}

# Runs a native command, returns its combined output, and leaves the exit code in $LASTEXITCODE.
function Invoke-Native([string]$Command, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Command @Arguments 2>&1 | ForEach-Object { "$_" }
    return ($output -join "`n")
  } finally {
    $ErrorActionPreference = $previous
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Show-NodeHint
  exit 1
}
$major = 0
try { $major = [int](Invoke-Native 'node' @('-p', "process.versions.node.split('.')[0]")).Trim() } catch { $major = 0 }
if ($major -lt 20) {
  Write-Host "Found Node.js $(Invoke-Native 'node' @('--version')), which is too old."
  Show-NodeHint
  exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail 'npm was not found next to node. Reinstall Node.js from https://nodejs.org'
}

# Install the GitHub release, not the npm registry name: nobody has published
# albertheijn-mcp to npm yet, so a package under that name could be anyone's.
$tarball = 'https://github.com/danieltyukov/albertheijn-mcp/releases/latest/download/albertheijn-mcp.tgz'
if ($env:AH_MCP_VERSION) {
  $tarball = "https://github.com/danieltyukov/albertheijn-mcp/releases/download/v$($env:AH_MCP_VERSION)/albertheijn-mcp.tgz"
}

Write-Host 'Installing albertheijn-mcp with npm. This can take a minute.'
$output = Invoke-Native 'npm' @('install', '-g', $tarball)
if ($LASTEXITCODE -ne 0) {
  Write-Host $output
  Fail "Installing from $tarball failed."
}

$bin = Get-Command albertheijn-mcp -ErrorAction SilentlyContinue
if ($bin) {
  $binPath = $bin.Source
} else {
  $prefix = (Invoke-Native 'npm' @('prefix', '-g')).Trim()
  $binPath = Join-Path $prefix 'albertheijn-mcp.cmd'
  if (-not (Test-Path $binPath)) {
    Fail "albertheijn-mcp was installed but could not be found. Check 'npm prefix -g' and your PATH."
  }
  Write-Host "Note: $prefix is not on your PATH yet. Open a new terminal before running albertheijn-mcp directly."
}
$version = (Invoke-Native $binPath @('--version')).Trim()
Write-Host "Installed albertheijn-mcp $version."

if (-not $NoSetup) {
  Write-Host ''
  Write-Host 'Configuring the MCP clients found on this machine.'
  Invoke-Native $binPath @('setup', '--all') | Write-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Setup did not finish. Run 'albertheijn-mcp setup' later to try again."
  }
}

Write-Host ''
Write-Host "Next: run 'albertheijn-mcp login' to sign in once to your Albert Heijn account. A browser window opens for that."
Write-Host 'Then restart your MCP client (Claude Desktop, Cursor, ...) and ask it about your groceries.'
