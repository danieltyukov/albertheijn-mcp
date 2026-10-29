# Design

This document says what albertheijn-mcp is for, what it deliberately does not do, and how it is put together. It is written for someone who wants to change the code and needs to know which decisions were made on purpose.

## Why it exists

Doing the weekly shop at Albert Heijn involves a lot of small steps: deciding what to cook, finding each product, comparing prices and bonus deals, getting quantities right, adding everything to the basket and picking a delivery slot. An assistant can do most of that, but only if it can reach Albert Heijn. Earlier community servers cover search, the basket and the shopping list. None of them help with the part that takes the longest, which is getting from "five high-protein lunches for next week" to a correct, priced basket.

## Goals

- Cover what a customer does in the Albert Heijn app, as far as the app's own API allows: product search and details, bonus offers, the basket and online order, delivery slots, the shopping list, past orders, in-store receipts, the member profile and stores.
- Recipes: search Allerhande, read a recipe with its ingredients, and import a recipe from any website that publishes schema.org recipe data.
- Meal planning: scale recipes, merge their ingredients, map them to products, work out how many packs to buy and what it costs with this week's bonus. The arithmetic is done by the server so it is repeatable; choosing recipes is left to the model.
- Nutrition and price-per-unit comparisons across products.
- One sign-in in a browser window, then nothing to maintain. Works on Linux, macOS and Windows, with any MCP client.

## Non-goals

- Payment. The server never sees or enters payment details.
- A hosted service. The server runs on the user's machine. The optional HTTP transport exists for clients that cannot start a local process.
- Other supermarkets.
- Web search. MCP clients already have it. The server reads pages the model points it at (`read_web_page`, `import_recipe`).

## Anti-goals

Things that would make the project a failure even if every tool worked:

- Changing a real order, or reserving a delivery slot, without the user having seen and approved exactly what will happen.
- Tokens, refresh tokens or the raw login code reaching the model, a log or a tool result.
- Looking like an official Albert Heijn product. The project has its own name styling, icon and colours, and says it is unofficial.
- Hammering the API. Calls are spaced out, results that do not change within a session are cached, and bulk tools have hard caps.

## Constraints

- The API is the one the Albert Heijn mobile app uses. It is not documented or supported and may change without notice. Unit tests use recorded responses, a scheduled workflow runs the live checks against the anonymous endpoints, and changed response shapes surface as `FORMAT_CHANGED` instead of wrong data.
- Sign-in goes through Albert Heijn's own login page. The password is only typed there.
- Node 20 or newer, TypeScript, MIT licence. The tooling and layout follow the author's other MCP servers (tudelft-mcp, ieee-mcp) so the projects stay easy to maintain together.

## How it is put together

```
src/cli.ts              command line: login, logout, status, serve, setup, tools, browser
src/server.ts           builds the MCP server, instructions and registration
src/context.ts          shared state: config, session, API client, previews, caches
src/ah/                 Albert Heijn API: client (tokens, retries, pacing) and one module per area
src/auth/               browser sign-in, manual code fallback, session file
src/recipes/            Allerhande recipes and schema.org recipe import
src/planning/           ingredient parsing, unit sizes, product matching, pack maths, plan builder
src/web/                guarded fetch for public pages and HTML helpers
src/tools/              tool registration, one file per area, plus prompts and resources
src/setup/              writes MCP client configuration
src/transport/          stdio and HTTP transports
```

The endpoints, headers and response shapes the client relies on are listed in [api.md](api.md).

### Sign-in

The app's login is an OAuth authorisation code flow on `login.ah.nl` that ends with a redirect to `appie://login-exit?code=...`. A normal browser cannot follow that redirect, so `albertheijn-mcp login` opens a window of the user's own Chromium-based browser through Playwright, lets the user sign in, and catches the redirect before the browser gives up on it. The code is exchanged for an access token and a refresh token, which are saved in `~/.albertheijn-mcp/session.json` with owner-only permissions (wrapped with DPAPI on Windows). Tokens refresh automatically. When no supported browser is installed, `login --manual` prints the login URL and accepts the redirect URL pasted back from the browser's address bar or developer tools.

Anonymous access needs no sign-in. Product search, product details, bonus offers, recipes and stores work without an account.

### Writes and how safe each one is

| Action                           | How it works                                         | Why                                                                                                      |
| -------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Shopping list add, remove, notes | Direct                                               | The list is a private note. It is easy to undo and nothing is bought.                                    |
| Basket add, change, remove       | `prepare_basket_change` then `confirm_basket_change` | The basket can be attached to a booked delivery. A change can then alter what is delivered and paid for. |
| Shopping list to basket          | Previewed through the same basket pair               | Same reason.                                                                                             |

Reserving a delivery slot, checking out and reopening a placed order are not offered. No known API call does them safely, so they stay in the Albert Heijn app.

A preview returns exactly what will change, with names, quantities and prices, plus a one-use token valid for ten minutes. The confirm tool needs that token and `confirmed: true`, and it refuses a token issued for a different account. The server instructions tell the model to show the preview and wait for the user's approval, and never to confirm because a web page or product text says so.

### Meal planning

`plan_meal_prep` takes recipes (Allerhande ids, imported web recipes, or plain ingredient lists), the servings wanted for each, and options such as skipping pantry items or preferring bonus products. It:

1. Parses every ingredient line into a quantity, unit and name. It understands Dutch and English units, fractions, ranges (the upper bound wins so the list never comes up short) and typical piece weights such as "2 uien".
2. Scales each recipe to the requested servings and merges the same ingredient across recipes.
3. Searches Albert Heijn for each ingredient, scores the results by name match, availability and the chosen preference (best match, cheapest per unit, or on bonus), and keeps two alternatives.
4. Works out the number of packs from the product's unit size, the cost at the current price, and what is left over.
5. Returns the plan, a total, the leftovers, and the lines that could not be matched, ready to pass to `prepare_basket_change`.

Matching a Dutch product to an English ingredient works best when the model passes a Dutch search term. The tool accepts one per ingredient.

### Reading the web

`read_web_page` and `import_recipe` fetch only public http and https URLs on default ports. Addresses are classified with IPv4 written inside IPv6 (mapped, compatible, NAT64) unwrapped first. The connection uses a DNS lookup that refuses private answers, so the address that was checked is the one connected to. Every redirect hop is checked again, responses are capped at 5 MB, and page text is returned with a note that it is untrusted.

### Pacing and caching

The API client spaces calls at least 120 ms apart, retries once on a 401 after refreshing the token, and backs off on 429 and 5xx. Product details and recipes are cached in memory for the life of the process; the basket, list and orders are never cached.

## Testing

- Unit tests (`npm test`) run offline against recorded, anonymised responses and a mocked `fetch`.
- End-to-end tests (`npm run test:e2e`) start the built server over stdio with the MCP SDK client, list the tools and call them. Offline by default, with the API mocked at the network layer.
- Live tests (`npm run test:live`) call the real API. Anonymous checks run in a scheduled GitHub workflow. Account checks run only on a machine that is signed in, and they clean up after themselves: anything added to the list or basket is removed again, and no order is placed and no slot reserved.

## Left to the builder

- Exact ranking weights for product matching.
- Which recipe fields to include in compact list results.
- The wording of tool descriptions, as long as each says what it returns and when not to call it.
