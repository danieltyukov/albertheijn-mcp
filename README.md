<p align="center">
  <img src="site/logo.svg" alt="albertheijn-mcp" width="380">
</p>

<p align="center">Do your Albert Heijn shopping from your AI assistant.</p>

<p align="center">
  <a href="https://github.com/danieltyukov/albertheijn-mcp/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/danieltyukov/albertheijn-mcp/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="https://github.com/danieltyukov/albertheijn-mcp/releases/latest"><img src="https://img.shields.io/github/v/release/danieltyukov/albertheijn-mcp" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20 or newer">
</p>

## What it does

albertheijn-mcp is an MCP server that runs on your own machine. It connects Claude, ChatGPT, Codex, Cursor, VS Code or any other MCP client to Albert Heijn, the Dutch supermarket. Your assistant can search the full assortment with prices, nutrition and allergens, see this week's bonus, find Allerhande recipes or import a recipe from any website, and turn a meal prep plan into a priced shopping list. Once you sign in it can also work with your shopping list, your booked order, past orders and in-store receipts.

It uses the same API as the Albert Heijn app. Nothing changes in a booked order until you have seen a preview and said yes.

Things you can ask once it is connected:

- Plan five high-protein lunches for next week, under 30 euros, and put them in my basket.
- What is on bonus this week that I usually buy?
- Which Greek yoghurt gives the most protein per euro?
- Shop for this recipe for four people: https://www.leukerecepten.nl/recepten/kip-tandoori/
- When is the cheapest delivery slot this weekend?
- How much did I spend at Albert Heijn per month since the summer?
- Is this product vegan, and does it contain gluten? (barcode 8710400058519)

## Install

macOS and Linux:

```sh
curl -fsSL https://danieltyukov.github.io/albertheijn-mcp/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://danieltyukov.github.io/albertheijn-mcp/install.ps1 | iex
```

The installer checks for Node.js 20 or newer, installs the package, and writes the MCP config for the clients it finds. You can also install the release tarball with npm directly:

```sh
npm install -g https://github.com/danieltyukov/albertheijn-mcp/releases/latest/download/albertheijn-mcp.tgz
albertheijn-mcp setup
```

Then, if you want the account features, sign in once:

```sh
albertheijn-mcp login
```

A Chrome, Edge, Chromium or Brave window opens on the Albert Heijn login page. You sign in there as usual and the window closes by itself. Products, bonus, recipes, stores and meal planning work without signing in.

### Connect a client

`albertheijn-mcp setup` finds the MCP clients installed on your machine and adds the server to their config. It supports Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Zed, Codex, Gemini CLI and Cline. Add `--dry-run` to see what it would write, or name the clients you want, for example `albertheijn-mcp setup cursor`. [docs/clients.md](docs/clients.md) has the config for each client.

Any other client:

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

Desktop apps such as Claude Desktop do not read your shell's PATH. If yours cannot start `albertheijn-mcp`, `albertheijn-mcp setup --dry-run` prints the same entry with absolute paths.

ChatGPT needs a public URL. Run `albertheijn-mcp serve --http --tunnel` and paste the printed URL into ChatGPT's connector settings.

## Tools

| Area                 | Tools                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Products             | `search_products`, `get_product`, `lookup_barcode`, `list_categories`, `compare_products`                                                        |
| Bonus                | `get_bonus`, `get_bonus_weeks`, `get_bonus_group`, `get_personal_bonus`, `price_items`                                                           |
| Recipes and research | `search_recipes`, `get_recipe`, `import_recipe`, `read_web_page`                                                                                 |
| Meal planning        | `plan_meal_prep`, `match_ingredients`                                                                                                            |
| Shopping list        | `get_shopping_list`, `update_shopping_list`, `get_favorite_lists`, `get_favorite_list`, `update_favorite_list`                                   |
| Order and delivery   | `get_order`, `prepare_basket_change`, `confirm_basket_change`, `get_delivery_slots`, `list_orders`, `get_order_details`, `get_frequent_products` |
| Receipts             | `list_receipts`, `get_receipt`, `get_spending`                                                                                                   |
| Stores               | `find_stores`, `get_store`, `get_last_chance`                                                                                                    |
| Account              | `auth_status`, `auth_login`, `auth_logout`, `get_profile`                                                                                        |

[docs/tools.md](docs/tools.md) lists every input. The server also ships four prompts: `meal_prep`, `weekly_shop`, `cook_from_bonus` and `recipe_to_basket`.

## Meal prep

`plan_meal_prep` takes recipes and the number of servings you want of each. A recipe can be an Allerhande recipe, a URL from another recipe site, or a plain list of ingredient lines. The server then:

1. reads each ingredient line in Dutch or English, including fractions, ranges and spoons;
2. scales each recipe and merges ingredients that appear in more than one;
3. finds the Albert Heijn product for each ingredient (for Allerhande recipes it uses Albert Heijn's own suggestion);
4. works out how many packs to buy and what is left over;
5. prices the whole basket with this week's bonus, as Albert Heijn would at checkout.

It skips salt, pepper, oil and other pantry staples unless you ask for them. You choose between the best match, the cheapest way to cover each amount, or products on bonus. The result includes the items for `prepare_basket_change`. Picking the recipes is left to the assistant: it can search Allerhande, import recipes from the web, or come up with its own.

## How ordering works

In the Albert Heijn app, the shopping list and the online order share one basket. Before a delivery is booked, the basket is just your list. After you book a delivery or pick-up slot, everything in it becomes the order and is delivered and charged.

- While nothing is booked, `update_shopping_list` changes the list directly.
- Once a delivery is booked, list changes are refused. `prepare_basket_change` shows each product with its quantity before and after, the order total before and after with bonus, and the closing time. `confirm_basket_change` applies exactly that preview, only once, and only if the basket has not changed in the meantime.
- Booking the delivery slot and paying stay in the Albert Heijn app. `get_delivery_slots` shows the slots and what each one costs, so the assistant can tell you which to pick.

## Sign-in and privacy

`albertheijn-mcp login` opens a separate browser profile on Albert Heijn's own login page and catches the code that the page normally hands to the app. The server swaps that code for tokens and stores them in `~/.albertheijn-mcp/session.json`, readable only by you. On Windows the file is also encrypted with Windows data protection. Tokens renew automatically. No tool ever returns them, and only the last four digits of your Bonus card are shown.

Everything runs on your machine. The server talks to api.ah.nl and login.ah.nl, plus any web page you ask it to read. `read_web_page` and `import_recipe` refuse local and private network addresses, check each redirect, and return page text marked as untrusted. `albertheijn-mcp logout` deletes the session and the browser profile.

No browser on the machine, or the login page refuses the window it opens? Run `albertheijn-mcp login --manual`. It prints the login address. Open it in your normal browser with the developer tools open on the Network tab, sign in, and paste back the `appie://login-exit?code=...` address the page redirects to.

## Requirements

- Node 20 or newer.
- For signing in: Google Chrome, Microsoft Edge, Chromium or Brave, or `albertheijn-mcp browser install` to download Chromium.
- An Albert Heijn account for the account features. Albert Heijn delivers in the Netherlands; the assortment and recipes are in Dutch.

## Development

```sh
npm ci
npm run check          # typecheck, lint, unit tests, build
npm run test:e2e       # build, then drive the real CLI over stdio against a local mock API
npm run test:live      # read-only checks against the real API, no account needed
npm run dev -- status  # run the CLI from source
```

Unit tests use recorded responses and a mocked `fetch`. The end-to-end tests start `node dist/cli.js serve` the way an MCP client does and talk to it over stdio. The live tests call api.ah.nl. With `AH_MCP_LIVE_ACCOUNT=1` on a signed-in machine they also check the account tools: they add an item to your list, check it, remove it again, and never confirm a change to a booked order. A scheduled workflow runs the anonymous live tests every week to catch API changes.

[docs/design.md](docs/design.md) explains the design decisions, and [docs/api.md](docs/api.md) lists every Albert Heijn endpoint the server uses, with what was verified and when.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems through [SECURITY.md](SECURITY.md).

## Credits

The API notes build on work by [appie-go](https://github.com/gwillem/appie-go), [fedorov-xyz/ah-mcp](https://github.com/fedorov-xyz/ah-mcp), [mrserzhan/ah-mcp](https://github.com/mrserzhan/ah-mcp), [openclaw-skill-albert-heijn](https://github.com/markooms/openclaw-skill-albert-heijn) and [Albert-Heijn-OpenAPI](https://github.com/NickBouwhuis/Albert-Heijn-OpenAPI).

## License

MIT. See [LICENSE](LICENSE).

This is an independent project. It is not made, endorsed or supported by Albert Heijn or Ahold Delhaize. "Albert Heijn", "Allerhande" and "Bonus" are their trademarks. The API it uses is undocumented and can change at any time.
