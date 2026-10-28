# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-28

### Fixed

- Sign-in: when Albert Heijn's bot protection refuses the login window, `login` now stops at once with `LOGIN_BLOCKED` and points to `login --manual`, instead of waiting until the timeout.
- The API sometimes refuses a saved anonymous token with HTTP 400 before it expires. The client now gets a new token and tries once more.
- With `AH_MCP_DEBUG=1`, a failed API call logs the start of the response body, with tokens redacted.

### Security

- The install scripts now install the GitHub release directly. They used to try the npm registry name first, which nobody has published yet, so a package someone else put under that name would have been installed instead.

## [0.1.0] - 2026-10-28

### Added

- Products: search with bonus, brand, Nutri-Score, diet and allergy filters; details with nutrition per 100 g, ingredients, allergens and diet labels; barcode lookup; categories; comparison on price per kg, protein per euro and calories.
- Bonus: weekly offers by section or search, products in a bonus group, personal Bonus Box offers, and basket pricing with every deal applied by Albert Heijn.
- Recipes: Allerhande search with filters, recipes scaled to any number of servings with Albert Heijn's product per ingredient, import from any site with schema.org recipe data, and a reader for public web pages.
- Meal planning: `plan_meal_prep` scales and merges recipes, matches products, counts packs and leftovers, and prices the result; `match_ingredients` for loose shopping lines.
- Account: shopping list and favourite lists, booked order with closing time, delivery slots with prices, past orders and their contents, usual products, store receipts and a spending summary, marked-down items per store, member profile.
- Order safety: changes to a booked order go through `prepare_basket_change` and `confirm_basket_change` with a one-use token bound to the account and a check that the basket did not change.
- Browser sign-in that captures the app login code, a manual fallback, automatic token renewal, and `setup` for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI and Cline.
- Unit, end-to-end (stdio) and live tests; a weekly live check of the anonymous API.

[Unreleased]: https://github.com/danieltyukov/albertheijn-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/danieltyukov/albertheijn-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/danieltyukov/albertheijn-mcp/releases/tag/v0.1.0
