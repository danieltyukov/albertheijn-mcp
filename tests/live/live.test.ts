import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadConfig } from '../../src/config.js';
import { createContext, type AppContext } from '../../src/context.js';
import { call, connect } from '../mcp.js';

/**
 * Calls the real Albert Heijn API. Runs only with AH_MCP_LIVE=1 (npm run test:live).
 * The account block also needs AH_MCP_LIVE_ACCOUNT=1 and a signed-in machine
 * ("albertheijn-mcp login"). It never confirms a change to a booked order and puts
 * the shopping list back the way it found it.
 */

const ACCOUNT = process.env.AH_MCP_LIVE_ACCOUNT === '1';
const MILK = 33693;

let ctx: AppContext;
let client: Client;

beforeAll(async () => {
  ctx = createContext(loadConfig());
  ({ client } = await connect(ctx));
});

afterAll(async () => {
  await client?.close();
});

const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await call(client, name, args);
  expect(result.isError, `${name}: ${JSON.stringify(result.data.error)}`).toBe(false);
  return result.data as Record<string, any>;
};

describe('live, anonymous', () => {
  it('searches, filters and reads products', async () => {
    const search = await ok('search_products', { query: 'halfvolle melk', size: 5 });
    expect(search.products.length).toBeGreaterThan(0);
    const bonus = await ok('search_products', { query: 'kaas', bonusOnly: true, size: 5 });
    expect(bonus.products.every((p: { bonus?: unknown }) => p.bonus)).toBe(true);
    const detail = await ok('get_product', { productId: MILK });
    expect(detail.nutrition.per).toMatch(/100/);
    const barcode = await ok('lookup_barcode', { barcode: '8710400058519' });
    expect(barcode.id).toBe(MILK);
    const categories = await ok('list_categories');
    expect(categories.categories.length).toBeGreaterThan(10);
    const compare = await ok('compare_products', { query: 'kwark', limit: 4, sortBy: 'protein_per_euro' });
    expect(compare.products.length).toBeGreaterThan(1);
  });

  it('reads the bonus and prices a basket with it', async () => {
    const weeks = await ok('get_bonus_weeks');
    expect(weeks.periods.length).toBeGreaterThan(0);
    const bonus = await ok('get_bonus', { limit: 5 });
    expect(bonus.offers.length).toBeGreaterThan(0);
    const group = bonus.offers.find((o: { groupId?: string }) => o.groupId);
    if (group) {
      const products = await ok('get_bonus_group', { groupId: group.groupId });
      expect(products.title).toBeTruthy();
    }
    const price = await ok('price_items', { items: [{ productId: MILK, quantity: 2 }] });
    expect(price.total).toBeGreaterThan(0);
  });

  it('finds recipes, imports one from the web and plans meal prep', async () => {
    const recipes = await ok('search_recipes', {
      search: 'kip',
      size: 3,
      filters: [{ group: 'speciale-wensen', values: ['eiwitrijk'] }],
    });
    expect(recipes.recipes.length).toBeGreaterThan(0);
    const recipe = await ok('get_recipe', { recipeId: recipes.recipes[0].id, servings: 2 });
    expect(recipe.ingredients.length).toBeGreaterThan(0);
    const plan = await ok('plan_meal_prep', {
      recipes: [
        { allerhandeId: recipes.recipes[0].id, makeServings: 4 },
        {
          title: 'Oats',
          ingredients: ['60 g havermout', '150 g kwark', '1 banaan'],
          servings: 1,
          makeServings: 4,
        },
      ],
      preference: 'bonus',
    });
    expect(plan.basketItems.length).toBeGreaterThan(2);
    expect(plan.totals.total).toBeGreaterThan(0);
    expect(plan.lookupFailed).toEqual([]);
    const imported = await ok('import_recipe', {
      url: 'https://www.leukerecepten.nl/recepten/kip-tandoori/',
    });
    expect(imported.ingredients.length).toBeGreaterThan(3);
    const fromWeb = await ok('plan_meal_prep', {
      recipes: [{ url: 'https://www.leukerecepten.nl/recepten/kip-tandoori/', makeServings: 2 }],
    });
    expect(fromWeb.basketItems.length).toBeGreaterThan(2);
    const web = await ok('read_web_page', {
      url: 'https://en.wikipedia.org/wiki/Meal_preparation',
      maxChars: 2000,
    });
    expect(web.text.length).toBeGreaterThan(100);
    expect(web.truncated).toBe(true);
  });

  it('finds stores and delivery slots', async () => {
    const stores = await ok('find_stores', { postalCode: '2611MC', limit: 2 });
    expect(stores.stores[0].hours.length).toBeGreaterThan(0);
    const store = await ok('get_store', { storeId: stores.stores[0].id });
    expect(store.name).toBeTruthy();
    const slots = await ok('get_delivery_slots', {
      address: { street: 'Bastiaanpoort', houseNumber: 7, postalCode: '2611MC', city: 'Delft' },
      days: 3,
    });
    expect(Array.isArray(slots.days)).toBe(true);
  });
});

describe.runIf(ACCOUNT)('live, signed in', () => {
  it('reads the profile, orders, receipts, lists and personal bonus', async () => {
    const profile = await ok('get_profile');
    expect(profile.firstName ?? profile.id).toBeTruthy();
    if (profile.bonusCard) expect(profile.bonusCard).toMatch(/^\*+\d{4}$/);
    await ok('list_orders', { which: 'all', limit: 5 });
    await ok('get_order');
    const receipts = await ok('list_receipts', { limit: 3 });
    if (receipts.receipts.length) await ok('get_receipt', { receiptId: receipts.receipts[0].id });
    await ok('get_favorite_lists');
    await ok('get_personal_bonus');
  });

  it('changes the shopping list and puts it back, only when no delivery is booked', async () => {
    const before = await ok('get_shopping_list');
    if (before.orderActive) {
      // A booked order: preview only, never confirm.
      const preview = await ok('prepare_basket_change', { items: [{ productId: MILK, add: 1 }] });
      expect(preview.target).toBe('booked order');
      return;
    }
    const original = before.items.find((i: { productId: number }) => i.productId === MILK)?.quantity ?? 0;
    try {
      const added = await ok('update_shopping_list', {
        items: [{ productId: MILK, quantity: original + 1 }],
        addNotes: ['albertheijn-mcp test note'],
      });
      expect(added.list.items.find((i: { productId: number }) => i.productId === MILK)?.quantity).toBe(
        original + 1,
      );
      expect(added.list.notes.map((n: { text: string }) => n.text)).toContain('albertheijn-mcp test note');

      const preview = await ok('prepare_basket_change', {
        items: [{ productId: MILK, quantity: original + 2 }],
      });
      expect(preview.target).toBe('shopping list (no delivery booked)');
      const confirmed = await ok('confirm_basket_change', {
        confirmationToken: preview.confirmationToken,
        confirmed: true,
      });
      expect(confirmed.applied).toBe(true);
    } finally {
      await call(client, 'update_shopping_list', {
        items: [{ productId: MILK, quantity: original }],
        removeNotes: ['albertheijn-mcp test note'],
      });
    }
    const after = await ok('get_shopping_list');
    expect(after.items.find((i: { productId: number }) => i.productId === MILK)?.quantity ?? 0).toBe(
      original,
    );
    expect(after.notes.map((n: { text: string }) => n.text)).not.toContain('albertheijn-mcp test note');
  });
});
