# Security policy

albertheijn-mcp keeps Albert Heijn access and refresh tokens on the user's machine and can change the user's shopping list and booked order. Problems in those areas matter most.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub security advisories: open the repository's Security tab and choose "Report a vulnerability", or go to https://github.com/danieltyukov/albertheijn-mcp/security/advisories/new. Include the version (`albertheijn-mcp --version`), the operating system, the steps to reproduce, and what an attacker could gain.

## Scope

In scope:

- The session file under `~/.albertheijn-mcp`, its permissions and the DPAPI wrapping on Windows, and any way a token could reach the model, a log or another user.
- Order safety: changing a booked order without a preview, reusing a confirmation token, applying a preview after the basket changed, or acting on a different product or quantity than the one shown.
- The web reader (`read_web_page`, `import_recipe`): reaching local or private network addresses, redirect tricks, or reading past the size limit. The host is resolved before connecting; a DNS answer that changes between that check and the connection is a known limitation.
- Prompt injection, where text from a web page, recipe or product steers the server into an action the user did not ask for.
- The HTTP transport (bearer token, binding, the tunnel option), the installers and the release workflow.

Out of scope: problems in Albert Heijn's own services (report those to Albert Heijn), attacks that need the user's OS account already, and dependency issues with no demonstrated impact here.

## What to expect

An acknowledgement within seven days. The project is maintained by one person in their spare time. Confirmed problems are fixed in a patch release and described in `CHANGELOG.md` and the advisory.

## Supported versions

Only the latest release receives fixes.
