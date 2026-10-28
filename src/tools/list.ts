import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { addToFavoriteList, favoriteList, favoriteLists, removeFromFavoriteList } from '../ah/favorites.js';
import {
  applyChanges,
  orderActive,
  planChanges,
  quantities,
  rawBasket,
  setNotes,
  shoppingList,
} from '../ah/basket.js';
import { READ, WRITE, type ToolRegistry } from './registry.js';
import { productId } from './products.js';

export const changeItems = z
  .array(
    z.object({
      productId,
      quantity: z.number().int().min(0).max(99).optional().describe('Set to this quantity; 0 removes'),
      add: z.number().int().min(-99).max(99).optional().describe('Or change by this many'),
    }),
  )
  .min(1)
  .max(60);

export function registerListTools(reg: ToolRegistry, _ctx: AppContext): void {
  reg.tool(
    'get_shopping_list',
    {
      title: 'Shopping list',
      description:
        'The products and free-text notes on the Albert Heijn shopping list (Mijn lijst), with prices and an estimated total. orderActive tells whether a delivery or pick-up is booked; if so, the list feeds that order and changes go through prepare_basket_change. Needs sign-in.',
      input: {},
      annotations: READ,
    },
    async (_args, ctx) => shoppingList(ctx),
  );

  reg.tool(
    'update_shopping_list',
    {
      title: 'Change the shopping list',
      description:
        'Add, change or remove products and free-text notes on the shopping list. Only works while no delivery is booked, because then nothing is bought; with a booked order it refuses and you must use prepare_basket_change so the user sees the change first. Returns the updated list.',
      input: {
        items: changeItems.optional(),
        addNotes: z
          .array(z.string().min(1).max(120))
          .max(20)
          .optional()
          .describe('Free-text lines such as "kaas bij de kaasboer"'),
        removeNotes: z
          .array(z.string().min(1).max(120))
          .max(20)
          .optional()
          .describe('Exact note texts to remove'),
      },
      annotations: WRITE,
    },
    async (args, ctx) => {
      if (!args.items?.length && !args.addNotes?.length && !args.removeNotes?.length)
        throw new AhError('INVALID_ARGUMENT', 'Nothing to change.');
      const basket = await rawBasket(ctx);
      if (orderActive(basket)) {
        throw new AhError(
          'NOT_ALLOWED',
          'A delivery is booked, so the list feeds a real order. Use prepare_basket_change and show the user the preview.',
        );
      }
      const changes = planChanges(quantities(basket.itemsInList), args.items ?? []);
      if (changes.length) await applyChanges(ctx, changes);
      const notes = [
        ...(args.addNotes ?? []).map((text) => ({ text, quantity: 1 })),
        ...(args.removeNotes ?? []).map((text) => ({ text, quantity: 0 })),
      ];
      if (notes.length) await setNotes(ctx, notes);
      const list = await shoppingList(ctx);
      return {
        changed: changes.map((c) => ({ productId: c.productId, from: c.from, to: c.to })),
        notesChanged: notes.length,
        list,
      };
    },
  );

  reg.tool(
    'get_favorite_lists',
    {
      title: 'Favourite lists',
      description:
        "The member's named product lists (Mijn lijstjes / favorieten) with their ids and sizes. Needs sign-in.",
      input: {},
      annotations: READ,
    },
    async (_args, ctx) => favoriteLists(ctx),
  );

  reg.tool(
    'get_favorite_list',
    {
      title: 'Favourite list contents',
      description: 'The products on one favourite list with current prices and bonus flags.',
      input: { listId: z.string().min(8).max(64) },
      annotations: READ,
    },
    async (args, ctx) => favoriteList(ctx, args.listId),
  );

  reg.tool(
    'update_favorite_list',
    {
      title: 'Change a favourite list',
      description:
        'Add products to, or remove products from, a favourite list. Favourite lists never touch an order.',
      input: {
        listId: z.string().min(8).max(64),
        add: z
          .array(z.object({ productId, quantity: z.number().int().min(1).max(99).default(1) }))
          .max(50)
          .optional(),
        remove: z.array(productId).max(50).optional(),
      },
      annotations: WRITE,
    },
    async (args, ctx) => {
      if (args.add?.length) await addToFavoriteList(ctx, args.listId, args.add);
      const removed = args.remove?.length
        ? (await removeFromFavoriteList(ctx, args.listId, args.remove)).removed
        : 0;
      return { added: args.add?.length ?? 0, removed, list: await favoriteList(ctx, args.listId) };
    },
  );
}
