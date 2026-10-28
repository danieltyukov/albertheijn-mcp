import { z } from 'zod';
import type { AppContext } from '../context.js';
import { listReceipts, receiptDetails, spending } from '../ah/receipts.js';
import { READ, type ToolRegistry } from './registry.js';

export function registerReceiptTools(reg: ToolRegistry, _ctx: AppContext): void {
  reg.tool(
    'list_receipts',
    {
      title: 'Store receipts',
      description:
        'In-store receipts (kassabonnen) of the signed-in member, newest first, with date and total. Needs sign-in.',
      input: {
        offset: z.number().int().min(0).max(1000).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ,
    },
    async (args, ctx) => listReceipts(ctx, args.offset, args.limit),
  );

  reg.tool(
    'get_receipt',
    {
      title: 'Receipt contents',
      description:
        'The lines, discounts and payments of one store receipt, with webshop product ids where Albert Heijn can map them.',
      input: { receiptId: z.string().min(1).max(120) },
      annotations: READ,
    },
    async (args, ctx) => receiptDetails(ctx, args.receiptId, true),
  );

  reg.tool(
    'get_spending',
    {
      title: 'Spending summary',
      description:
        'In-store spending per month over the last months, average per visit, what discounts saved, and the most bought products, from receipts. Online orders are in list_orders.',
      input: {
        months: z.number().int().min(1).max(24).default(3),
        withProducts: z.boolean().default(true).describe('Also read receipt lines for top products (slower)'),
      },
      annotations: READ,
    },
    async (args, ctx) => spending(ctx, args.months, args.withProducts),
  );
}
