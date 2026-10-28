import { z } from 'zod';
import type { AppContext } from '../context.js';
import { bonusGroupProducts, bonusOffers, bonusPeriods, personalBonus, priceItems } from '../ah/bonus.js';
import { READ, type ToolRegistry } from './registry.js';
import { productId } from './products.js';

export const items = z
  .array(z.object({ productId, quantity: z.number().int().min(1).max(99) }))
  .min(1)
  .max(100);

export function registerBonusTools(reg: ToolRegistry, _ctx: AppContext): void {
  reg.tool(
    'get_bonus',
    {
      title: 'Bonus offers',
      description:
        'This week\'s (or next week\'s, once published) Albert Heijn bonus offers. Without a section it lists the offers from every product section plus the section names; with section it lists one section such as "Kaas" or "Vlees"; search keeps offers whose name or deal contains the words. Each offer has a groupId for get_bonus_group.',
      input: {
        week: z.enum(['current', 'next']).default('current'),
        section: z.string().max(80).optional(),
        search: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(200).default(40),
      },
      annotations: READ,
    },
    async (args, ctx) => {
      const query: Parameters<typeof bonusOffers>[1] = { week: args.week, limit: args.limit };
      if (args.section) query.section = args.section;
      if (args.search) query.search = args.search;
      return bonusOffers(ctx, query);
    },
  );

  reg.tool(
    'get_bonus_weeks',
    {
      title: 'Bonus weeks',
      description:
        'The bonus weeks Albert Heijn has published, their dates, when next week appears, and the sections with offer counts.',
      input: {},
      annotations: READ,
    },
    async (_args, ctx) => ({ periods: await bonusPeriods(ctx) }),
  );

  reg.tool(
    'get_bonus_group',
    {
      title: 'Products in a bonus offer',
      description:
        'Every product included in one bonus offer (for example "Alle Eru, 2 + 1 gratis"), with the price that week.',
      input: { groupId: z.string().min(1).max(40), week: z.enum(['current', 'next']).default('current') },
      annotations: READ,
    },
    async (args, ctx) => bonusGroupProducts(ctx, args.groupId, args.week),
  );

  reg.tool(
    'get_personal_bonus',
    {
      title: 'Personal bonus',
      description:
        "The signed-in member's personal Bonus Box offers for this or next week, with their activation state. Needs sign-in.",
      input: { week: z.enum(['current', 'next']).default('current') },
      annotations: READ,
    },
    async (args, ctx) => personalBonus(ctx, args.week),
  );

  reg.tool(
    'price_items',
    {
      title: 'Price a set of products',
      description:
        'What a set of products costs together with every bonus deal applied ("2 voor", "1 + 1 gratis", percentage off), calculated by Albert Heijn. Use it to check a plan or to see whether buying one more unlocks a deal.',
      input: { items },
      annotations: READ,
    },
    async (args, ctx) => priceItems(ctx, args.items),
  );
}
