import { z } from 'zod';
import type { AppContext } from '../context.js';
import { accountId } from '../context.js';
import { AhError } from '../errors.js';
import { priceItems } from '../ah/bonus.js';
import {
  activeOrder,
  applyChanges,
  lines,
  orderActive,
  planChanges,
  quantities,
  rawBasket,
  type PlannedChange,
} from '../ah/basket.js';
import { round2 } from '../ah/format.js';
import { memberAddress } from '../ah/member.js';
import { frequentProducts, listOrders, orderDetails } from '../ah/orders.js';
import { productsByIds, summarize } from '../ah/products.js';
import { deliverySlots, type SlotAddress } from '../ah/slots.js';
import { DESTRUCTIVE, READ, type ToolRegistry } from './registry.js';
import { changeItems } from './list.js';

export const confirmArgs = {
  confirmationToken: z.string().min(16).max(200),
  confirmed: z.literal(true).describe('Must be true. Confirms the user approved this exact preview.'),
};

interface BasketPreview {
  orderActive: boolean;
  orderId?: number;
  changes: PlannedChange[];
}

export function registerOrderTools(reg: ToolRegistry, _ctx: AppContext): void {
  reg.tool(
    'get_order',
    {
      title: 'Current order',
      description:
        'The booked online order the basket feeds into, if any: delivery date and window, closing time (no changes after it), items and totals. When nothing is booked it says so; booking a delivery slot happens in the Albert Heijn app. Needs sign-in.',
      input: {},
      annotations: READ,
    },
    async (_args, ctx) => activeOrder(ctx),
  );

  reg.tool(
    'prepare_basket_change',
    {
      title: 'Preview a basket change',
      description:
        'Prepare adding, changing or removing products in the basket. With a booked delivery the basket is a real order, so this returns a preview (each product with its quantity before and after, prices, the order total before and after with bonus applied, and the closing time) and a one-use token. Show the whole preview to the user and call confirm_basket_change only after they approve it. Nothing changes until then.',
      input: { items: changeItems },
      annotations: READ,
    },
    async (args, ctx) => {
      const basket = await rawBasket(ctx);
      const active = orderActive(basket);
      const current = quantities(active ? basket.itemsInOrder : basket.itemsInList);
      const changes = planChanges(current, args.items);
      if (!changes.length)
        throw new AhError(
          'INVALID_ARGUMENT',
          'These quantities are already in the basket. Nothing to change.',
        );
      const products = await productsByIds(
        ctx,
        changes.map((c) => c.productId),
      );
      const byId = new Map(products.map((p) => [p.webshopId, summarize(p)]));
      const missing = changes.filter((c) => !byId.has(c.productId)).map((c) => c.productId);
      if (missing.length) throw new AhError('NOT_FOUND', `Unknown product ids: ${missing.join(', ')}.`);
      const unavailable = changes
        .filter((c) => c.to > c.from && !byId.get(c.productId)!.orderable)
        .map((c) => byId.get(c.productId)!.title);
      if (unavailable.length)
        throw new AhError('NOT_ALLOWED', `Not orderable online right now: ${unavailable.join(', ')}.`);
      const planned: PlannedChange[] = changes.map((c) => {
        const p = byId.get(c.productId)!;
        const change: PlannedChange = { productId: c.productId, title: p.title, from: c.from, to: c.to };
        if (p.unitSize) change.unitSize = p.unitSize;
        if (p.price !== null) change.price = p.price;
        return change;
      });
      const before = [...current].map(([productId, quantity]) => ({ productId, quantity }));
      const afterMap = new Map(current);
      for (const c of changes) afterMap.set(c.productId, c.to);
      const after = [...afterMap].map(([productId, quantity]) => ({ productId, quantity }));
      const [priceBefore, priceAfter] = await Promise.all([
        priceItems(ctx, before).catch(() => undefined),
        priceItems(ctx, after).catch(() => undefined),
      ]);
      const payload: BasketPreview = { orderActive: active, changes: planned };
      let order: Awaited<ReturnType<typeof activeOrder>> | undefined;
      if (active) {
        order = await activeOrder(ctx).catch(() => undefined);
        if (order?.orderId) payload.orderId = order.orderId;
      }
      const preview = ctx.previews.create('basket', await accountId(ctx), payload);
      return {
        confirmationToken: preview.token,
        expiresInMinutes: 10,
        target: active ? 'booked order' : 'shopping list (no delivery booked)',
        ...(order?.delivery ? { delivery: order.delivery } : {}),
        ...(order?.closesAtLocal ? { orderClosesAt: order.closesAtLocal } : {}),
        changes: planned.map((c) => ({
          product: c.title,
          productId: c.productId,
          unitSize: c.unitSize,
          quantity: `${c.from} -> ${c.to}`,
          price: c.price,
          lineDelta: c.price !== undefined ? round2(c.price * (c.to - c.from)) : undefined,
        })),
        ...(priceBefore && priceAfter
          ? {
              totalBefore: priceBefore.total,
              totalAfter: priceAfter.total,
              difference: round2(priceAfter.total - priceBefore.total),
              bonusSavingAfter: priceAfter.discount,
            }
          : {}),
        instruction:
          'Show this preview to the user. Call confirm_basket_change with the token only after they approve it.',
      };
    },
  );

  reg.tool(
    'confirm_basket_change',
    {
      title: 'Apply a previewed basket change',
      description:
        'Apply exactly the change from prepare_basket_change after the user approved it. Refuses an expired or reused token, a token from another account, and a basket that changed since the preview.',
      input: confirmArgs,
      annotations: DESTRUCTIVE,
    },
    async (args, ctx) => {
      const preview = ctx.previews.consume<BasketPreview>(
        args.confirmationToken,
        'basket',
        await accountId(ctx),
        args.confirmed,
      );
      const basket = await rawBasket(ctx);
      const active = orderActive(basket);
      if (active !== preview.payload.orderActive)
        throw new AhError(
          'PREVIEW_CHANGED',
          'A delivery was booked or cancelled since the preview. Prepare the change again.',
        );
      const current = quantities(active ? basket.itemsInOrder : basket.itemsInList);
      const drifted = preview.payload.changes.filter((c) => (current.get(c.productId) ?? 0) !== c.from);
      if (drifted.length)
        throw new AhError(
          'PREVIEW_CHANGED',
          `The basket changed since the preview (${drifted.map((c) => c.title).join(', ')}). Prepare it again.`,
        );
      try {
        await applyChanges(
          ctx,
          preview.payload.changes.map((c) => ({ productId: c.productId, from: c.from, to: c.to })),
        );
      } catch (error) {
        if (error instanceof AhError && error.code !== 'UNAVAILABLE') throw error;
        throw new AhError(
          'OUTCOME_UNKNOWN',
          'The change may or may not have gone through. Check get_shopping_list or get_order before retrying.',
        );
      }
      const after = await rawBasket(ctx);
      const now = quantities(orderActive(after) ? after.itemsInOrder : after.itemsInList);
      const applied = preview.payload.changes.map((c) => ({
        product: c.title,
        wanted: c.to,
        now: now.get(c.productId) ?? 0,
      }));
      const view = lines(orderActive(after) ? after.itemsInOrder : after.itemsInList);
      return {
        applied: applied.every((a) => a.wanted === a.now),
        target: active ? 'booked order' : 'shopping list',
        changes: applied,
        itemCount: view.reduce((s, l) => s + l.quantity, 0),
      };
    },
  );

  reg.tool(
    'get_delivery_slots',
    {
      title: 'Delivery slots',
      description:
        "Available home delivery slots for the next days with the delivery charge of each, and the cheapest one. Uses the signed-in member's address unless an address is given (then it works without sign-in). Booking a slot happens in the Albert Heijn app.",
      input: {
        address: z
          .object({
            street: z.string().min(1).max(120),
            houseNumber: z.number().int().positive(),
            houseNumberExtra: z.string().max(10).optional(),
            postalCode: z.string().min(6).max(7),
            city: z.string().min(1).max(80),
          })
          .optional(),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('First date to show, YYYY-MM-DD'),
        days: z.number().int().min(1).max(14).default(7),
        includeFull: z.boolean().default(false).describe('Also list fully booked slots'),
      },
      annotations: READ,
    },
    async (args, ctx) => {
      const address: SlotAddress = args.address
        ? {
            ...args.address,
            ...(args.address.houseNumberExtra ? { houseNumberExtra: args.address.houseNumberExtra } : {}),
          }
        : await memberAddress(ctx);
      const query: Parameters<typeof deliverySlots>[1] = {
        address,
        days: args.days,
        onlyAvailable: !args.includeFull,
      };
      if (args.from) query.from = args.from;
      return {
        ...(await deliverySlots(ctx, query)),
        note: 'Times are Amsterdam local time. Prices are the delivery charge.',
      };
    },
  );

  reg.tool(
    'list_orders',
    {
      title: 'Online orders',
      description: 'Open and past online orders with date, status and total. Needs sign-in.',
      input: {
        which: z.enum(['open', 'past', 'all']).default('all'),
        limit: z.number().int().min(1).max(50).default(15),
      },
      annotations: READ,
    },
    async (args, ctx) => listOrders(ctx, args.which, args.limit),
  );

  reg.tool(
    'get_order_details',
    {
      title: 'Order contents',
      description:
        'Every product in one online order, grouped by category, with quantities, prices and deals. Order ids come from list_orders.',
      input: { orderId: z.number().int().positive() },
      annotations: READ,
    },
    async (args, ctx) => orderDetails(ctx, args.orderId),
  );

  reg.tool(
    'get_frequent_products',
    {
      title: 'Usual products',
      description:
        'The products the member orders most often online, from their recent orders, with how many orders they appeared in. Good for "my usual groceries" or checking which regulars are on bonus. Needs sign-in.',
      input: {
        orders: z.number().int().min(1).max(25).default(8),
        limit: z.number().int().min(1).max(80).default(30),
      },
      annotations: READ,
    },
    async (args, ctx) => frequentProducts(ctx, args.orders, args.limit),
  );
}
