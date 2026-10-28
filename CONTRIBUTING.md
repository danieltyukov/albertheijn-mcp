# Contributing

Thanks for helping with albertheijn-mcp. This page covers the setup, how the code is organised, how to add a tool, and what to check before opening a pull request.

## Setup

You need Node 20 or newer (the project is developed on Node 22, see `.nvmrc`) and git.

```sh
git clone https://github.com/danieltyukov/albertheijn-mcp.git
cd albertheijn-mcp
npm ci
npm run check
```

`npm run check` runs the typecheck, the linter, the unit tests and the build. Use `npm run dev -- <command>` to run the CLI from source, for example `npm run dev -- tools` or `npm run dev -- status`.

## Tests

- `npm test`: unit tests in `tests/`. They use recorded responses from `tests/fixtures/` and a mocked `fetch`, run offline, and must stay that way.
- `npm run test:e2e`: builds the package, starts `node dist/cli.js serve` over stdio and drives it with the MCP SDK client against a local stand-in for the API (`tests/e2e/mock-ah.ts`). Add a case here when you change how tools fit together.
- `npm run test:live`: read-only checks against the real API with an anonymous token. Run them when you touch an endpoint.
- `npm run test:live:account`: also checks the account tools on a signed-in machine. It adds one product and one note to your shopping list and removes them again. When a delivery is booked it only prepares a preview and never confirms it.

## Layout

- `src/cli.ts`: the command line (login, status, serve, setup, tools, browser).
- `src/server.ts`: builds the MCP server and holds the instructions the model sees.
- `src/ah/`: the Albert Heijn API. `client.ts` handles tokens, pacing and retries; the other files cover one area each (products, bonus, basket, orders, receipts, favourites, stores, slots, member).
- `src/recipes/`: Allerhande recipes and the schema.org importer for other sites.
- `src/planning/`: ingredient parsing (`quantity.ts`), product matching (`match.ts`) and the meal plan builder (`plan.ts`).
- `src/web/`: the guarded fetch for public pages and the HTML helpers.
- `src/tools/`: one file per area, each exporting a `register*Tools` function, plus prompts.
- `src/auth/`: browser sign-in, the session file and status.
- `docs/api.md` lists every endpoint with where it came from and when it was last verified. Update it when you add or change a call.

## Adding a tool

1. Put the API call in the matching module under `src/ah/` (or `src/recipes/`, `src/planning/`). Tool files only validate input, call that code and shape the result.
2. Register the tool with `reg.tool(name, spec, handler)` in a file under `src/tools/`. The description is read by the model: say what the tool returns, what it needs, and when not to use it. Pick an annotation from `src/tools/registry.ts` (`READ`, `LOCAL`, `WRITE`, `DESTRUCTIVE`).
3. Anything that can change a booked order, a reservation or money must be a `prepare_*` and `confirm_*` pair using the preview store. Look at `prepare_basket_change` for the pattern, including the check that the basket did not change in between.
4. Add a unit test with a mocked response. `tests/server.test.ts` picks up the new tool automatically.
5. Run `npm run docs:tools` so `docs/tools.md` matches.

## Fixtures and privacy

Fixtures must never contain account data. Product, bonus, recipe and store responses are public and fine to record after trimming. Anything from an account (lists, orders, receipts, profile, tokens) must be invented. Keep only the fields the code reads, so a fixture documents the shape rather than a person.

## Commits

Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `ci:`, with an optional scope such as `feat(planning):`. Keep the subject under 72 characters and describe the change. Do not add generated-by notices or tool attribution trailers.

Prettier (`npm run format`) and `eslint.config.js` decide formatting. No emojis in code, comments, docs or commit messages.
