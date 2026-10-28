import { z } from 'zod';
import type { AppContext } from '../context.js';
import { findStores, lastChance, storeInfo } from '../ah/stores.js';
import { READ, type ToolRegistry } from './registry.js';

export function registerStoreTools(reg: ToolRegistry, _ctx: AppContext): void {
  reg.tool(
    'find_stores',
    {
      title: 'Find stores',
      description:
        'Albert Heijn stores nearest to a Dutch postal code or a location, with address, distance, opening hours for the coming days and services.',
      input: {
        postalCode: z.string().min(4).max(7).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        types: z
          .array(z.enum(['REGULAR', 'XL', 'TOGO']))
          .max(3)
          .optional(),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: READ,
    },
    async (args, ctx) => {
      const query: Parameters<typeof findStores>[1] = { limit: args.limit };
      if (args.postalCode) query.postalCode = args.postalCode;
      if (args.latitude !== undefined) query.latitude = args.latitude;
      if (args.longitude !== undefined) query.longitude = args.longitude;
      if (args.types) query.types = args.types;
      return findStores(ctx, query);
    },
  );

  reg.tool(
    'get_store',
    {
      title: 'Store details',
      description: 'Address, phone, opening hours and services of one store by id.',
      input: { storeId: z.number().int().positive() },
      annotations: READ,
    },
    async (args, ctx) => storeInfo(ctx, args.storeId),
  );

  reg.tool(
    'get_last_chance',
    {
      title: 'Marked-down items in a store',
      description:
        'Products a store has marked down because their date is close (koopjes / overblijvers), with the reduced price and stock. Needs sign-in.',
      input: { storeId: z.number().int().positive() },
      annotations: READ,
    },
    async (args, ctx) => lastChance(ctx, args.storeId),
  );
}
