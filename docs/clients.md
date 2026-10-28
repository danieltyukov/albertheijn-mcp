# Connecting MCP clients

`albertheijn-mcp setup` writes these snippets for you. It detects installed clients, merges the
`albertheijn` entry into each config file without touching other servers, and keeps the previous
version next to it as `<file>.bak`. Run it with no arguments to pick clients interactively,
with `--all` to configure every detected client, with client ids to force specific ones
(`albertheijn-mcp setup cursor zed`), with `--dry-run` to only print what would change, or with
`--json` for a machine-readable summary.

By default it writes the absolute path of `node` and of the installed `dist/cli.js`. Claude
Desktop, Cursor and other desktop apps do not read your shell's PATH, so a bare
`albertheijn-mcp` installed through nvm, fnm or Homebrew would not be found there. The cost is
that after switching Node versions with a version manager you run `albertheijn-mcp setup`
again.

| Option          | Command                 | Arguments                                                            |
| --------------- | ----------------------- | -------------------------------------------------------------------- |
| default         | absolute path to `node` | `["<path>/dist/cli.js", "serve"]`                                    |
| `--command npx` | `npx`                   | `["-y", "--package=<release .tgz URL>", "albertheijn-mcp", "serve"]` |

`--command npx` needs no global install. It fetches the GitHub release of the version you ran
setup with, not a package from the npm registry.

The snippets below use `albertheijn-mcp serve` to keep them short. That works when the client
inherits a PATH that contains `albertheijn-mcp`, which is usually true for terminal clients
such as Claude Code, Codex and Gemini CLI. For desktop apps use the absolute paths that setup
prints with `--dry-run`.

After any change: run `albertheijn-mcp login` once, then restart the client.

## Claude Desktop

File: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/.config/Claude/claude_desktop_config.json` (Linux).

```json
{
  "mcpServers": {
    "albertheijn": {
      "command": "albertheijn-mcp",
      "args": ["serve"]
    }
  }
}
```

## Claude Code

Setup runs `claude mcp add --scope user --transport stdio albertheijn -- albertheijn-mcp serve` when the
`claude` binary is on PATH, and otherwise edits `~/.claude.json`:

```json
{
  "mcpServers": {
    "albertheijn": {
      "command": "albertheijn-mcp",
      "args": ["serve"]
    }
  }
}
```

## Cursor

File: `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "albertheijn": {
      "command": "albertheijn-mcp",
      "args": ["serve"]
    }
  }
}
```

## Windsurf

File: `~/.codeium/windsurf/mcp_config.json`. Same shape as Cursor (`mcpServers.albertheijn`).

## VS Code

File: `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%\Code\User\mcp.json`
(Windows), `~/.config/Code/User/mcp.json` (Linux).

```json
{
  "servers": {
    "albertheijn": {
      "type": "stdio",
      "command": "albertheijn-mcp",
      "args": ["serve"]
    }
  }
}
```

## Zed

File: `~/.config/zed/settings.json` on every platform.

```json
{
  "context_servers": {
    "albertheijn": {
      "source": "custom",
      "command": "albertheijn-mcp",
      "args": ["serve"]
    }
  }
}
```

Zed settings may contain comments. Setup only edits the file when it parses as plain JSON;
otherwise it prints this snippet for you to paste.

## Codex CLI

File: `~/.codex/config.toml`. Setup replaces an existing `[mcp_servers.albertheijn]` block or appends one.

```toml
[mcp_servers.albertheijn]
command = "albertheijn-mcp"
args = ["serve"]
startup_timeout_sec = 30
tool_timeout_sec = 300
```

## Gemini CLI

File: `~/.gemini/settings.json`. Same shape as Cursor (`mcpServers.albertheijn`).

## Cline

File: `<Code user dir>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`,
where the Code user dir is the one listed under VS Code. Same shape as Cursor (`mcpServers.albertheijn`).

## OpenCode

File: `~/.config/opencode/opencode.json`.

```json
{
  "mcp": {
    "albertheijn": {
      "type": "local",
      "command": ["albertheijn-mcp", "serve"]
    }
  }
}
```

## ChatGPT

ChatGPT has no local config file and needs a public HTTPS URL. The server can expose itself
through a temporary tunnel:

1. Install `cloudflared` (preferred) or `ngrok` and make sure it is on PATH.
2. Run `albertheijn-mcp serve --http --tunnel`. It prints a URL of the form
   `https://<name>.trycloudflare.com/<token>/mcp`.
3. In ChatGPT open Settings, then Connectors, enable Developer mode, choose Create, and paste
   the URL. Leave authentication off: the token is part of the URL.
4. Keep the terminal open while you use it. Quick tunnels get a new hostname on every start,
   so update the connector URL when you restart the server.

Anyone who has that URL can read your orders and receipts and change your shopping list, so do not share it. Changes to a booked order still need a preview and confirmation.

## Clients that connect over HTTP locally

`albertheijn-mcp serve --http` listens on `http://127.0.0.1:3848/mcp` and requires a bearer token.
The token is generated on first run and kept in `~/.albertheijn-mcp/session.json`; print it with
`albertheijn-mcp serve --http --show-token`, or set your own with `--token` or
`AH_MCP_HTTP_TOKEN`.

```json
{
  "mcpServers": {
    "albertheijn": {
      "url": "http://127.0.0.1:3848/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Clients that cannot send headers can use `http://127.0.0.1:3848/<token>/mcp` instead.
Failed attempts are rate limited (10 per minute per address). Use `--host 0.0.0.0` only on a
network you trust.

## Remote or headless machine

Signing in needs a browser once: `albertheijn-mcp login` opens Chrome, Edge, Chromium or Brave on
the Albert Heijn login page. After that the server only uses the saved tokens, which renew
themselves, so it does not need a display.

On a server without a display:

- Easiest: sign in on your laptop, then copy `~/.albertheijn-mcp/session.json` to the same
  place on the server. Sessions written on Windows are protected with DPAPI and only work for the
  same Windows user, so copy from macOS or Linux.
- Or sign in by hand: `albertheijn-mcp login --manual` prints the login address. Open it in any
  browser, sign in, and paste back the `appie://login-exit?code=...` address the browser tries to
  open at the end (visible in the developer tools, Network tab).
- No browser installed at all: `albertheijn-mcp browser install` downloads Chromium through
  Playwright.

Keep `session.json` private (`chmod 600`). It holds tokens for your Albert Heijn account until
you run `albertheijn-mcp logout`.
