#!/bin/sh
# Installs albertheijn-mcp on macOS and Linux.
#
#   curl -fsSL https://danieltyukov.github.io/albertheijn-mcp/install.sh | sh
#   curl -fsSL https://danieltyukov.github.io/albertheijn-mcp/install.sh | sh -s -- --no-setup
#
# Environment:
#   AH_MCP_VERSION   Install this exact version instead of the latest release.
#
# What it does: checks for Node.js 20 or newer, installs the package globally with npm
# (falling back to the GitHub release tarball when the package is not on the registry),
# writes the MCP config of the clients it finds, and tells you to run "albertheijn-mcp login".
set -eu

usage() {
  printf '%s\n' \
    'Usage: install.sh [--no-setup]' \
    '' \
    '  --no-setup             Install only; skip writing MCP client configs.' \
    '  AH_MCP_VERSION    Environment variable that pins an exact version.'
}

SETUP=1
for arg in "$@"; do
  case "$arg" in
    --no-setup) SETUP=0 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

node_hint() {
  say "albertheijn-mcp needs Node.js 20 or newer."
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      say "Install it with Homebrew:  brew install node"
      say "or download the LTS installer from https://nodejs.org"
      ;;
    Linux)
      say "Install the LTS release for your distribution:"
      say "  Debian/Ubuntu: https://github.com/nodesource/distributions#installation-instructions"
      say "  Fedora:        sudo dnf install nodejs"
      say "  Arch:          sudo pacman -S nodejs npm"
      say "  Any distro:    https://github.com/nvm-sh/nvm then 'nvm install --lts'"
      say "or download it from https://nodejs.org"
      ;;
    *)
      say "Download it from https://nodejs.org"
      ;;
  esac
  say "Then open a new terminal and run this installer again."
}

if ! command -v node >/dev/null 2>&1; then
  node_hint
  exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 20 ]; then
  say "Found Node.js $(node --version 2>/dev/null || echo unknown), which is too old."
  node_hint
  exit 1
fi
command -v npm >/dev/null 2>&1 || fail "npm was not found next to node. Reinstall Node.js from https://nodejs.org"

PKG="albertheijn-mcp"
FALLBACK="https://github.com/danieltyukov/albertheijn-mcp/releases/latest/download/albertheijn-mcp.tgz"
if [ -n "${AH_MCP_VERSION:-}" ]; then
  PKG="albertheijn-mcp@${AH_MCP_VERSION}"
  FALLBACK="https://github.com/danieltyukov/albertheijn-mcp/releases/download/v${AH_MCP_VERSION}/albertheijn-mcp.tgz"
fi

say "Installing $PKG with npm. This can take a minute."
if OUTPUT=$(npm install -g "$PKG" 2>&1); then
  :
else
  case "$OUTPUT" in
    *E404*|*"404 Not Found"*)
      say "The package is not on the npm registry yet. Installing the GitHub release instead."
      if ! OUTPUT=$(npm install -g "$FALLBACK" 2>&1); then
        printf '%s\n' "$OUTPUT" >&2
        fail "Installing from $FALLBACK failed."
      fi
      ;;
    *EACCES*|*"permission denied"*)
      printf '%s\n' "$OUTPUT" >&2
      fail "npm is not allowed to write to its global directory. See https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
      ;;
    *)
      printf '%s\n' "$OUTPUT" >&2
      fail "npm install failed."
      ;;
  esac
fi

BIN=$(command -v albertheijn-mcp 2>/dev/null || true)
if [ -z "$BIN" ]; then
  PREFIX=$(npm prefix -g 2>/dev/null || true)
  if [ -n "$PREFIX" ] && [ -x "$PREFIX/bin/albertheijn-mcp" ]; then
    BIN="$PREFIX/bin/albertheijn-mcp"
    say "Note: $PREFIX/bin is not on your PATH. Add it to your shell profile to run albertheijn-mcp directly."
  else
    fail "albertheijn-mcp was installed but could not be found. Check 'npm prefix -g' and your PATH."
  fi
fi
say "Installed albertheijn-mcp $("$BIN" --version)."

if [ "$SETUP" -eq 1 ]; then
  say ""
  say "Configuring the MCP clients found on this machine."
  "$BIN" setup --all || say "Setup did not finish. Run 'albertheijn-mcp setup' later to try again."
fi

say ""
say "Next: run 'albertheijn-mcp login' to sign in once to your Albert Heijn account. A browser window opens for that."
say "Then restart your MCP client (Claude Desktop, Cursor, ...) and ask it about your groceries."
