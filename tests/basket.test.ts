import { afterEach, describe, expect, it, vi } from 'vitest';
import { orderActive, planChanges } from '../src/ah/basket.js';
import { signedInContext, mockApi, type Call } from './helpers.js';
import { call, connect } from './mcp.js';

afterEach(() => vi.restoreAllMocks());

const product = (id: number, title: string, price: number) => ({
  id,
  title,
  salesUnitSize: '500 g',
  priceV2: { now: { amount: price } },
});

function basketWith(list: [number, number][], order: [number, number][] | null = null) {
  return {
    id: 'b1',
    itemsInList: list.map(([id, quantity]) => ({ id, quantity, product: product(id, `Product ${id}`, 2) })),
    itemsInOrder:
      order?.map(([id, quantity]) => ({ id, quantity, product: product(id, `Product ${id}`, 2) })) ?? null,
    notes: [],
    summary: order
      ? { shoppingType: 'DELIVERY', deliveryDate: '2026-10-31' }
      : { shoppingType: null, deliveryDate: null },
  };
}

const restProduct = (id: number) => ({
  webshopId: id,
  title: `Product ${id}`,
  salesUnitSize: '500 g',
  priceBeforeBonus: 2,
  isOrderable: true,
});

/** A stateful basket: mutations change what the next basket query returns. */
function statefulApi(initial: { list: [number, number][]; order?: [number, number][] | null }) {
  const state = { list: new Map(initial.list), order: initial.order ? new Map(initial.order) : null };
  const target = () => state.order ?? state.list;
  const view = () => ({ basket: basketWith([...state.list], state.order ? [...state.order] : null) });
  const calls = mockApi({
    'gql:basket': view,
    'gql:basketItemsAdd': (c: Call) => {
      for (const item of (c.body as { variables: { items: { id: number; quantity: number }[] } }).variables
        .items)
        target().set(item.id, (target().get(item.id) ?? 0) + item.quantity);
      return { basketItemsAdd: { status: 'SUCCESS', result: view().basket } };
    },
    'gql:basketItemsUpdate': (c: Call) => {
      for (const item of (c.body as { variables: { items: { id: number; quantity: number }[] } }).variables
        .items) {
        if (item.quantity === 0) target().delete(item.id);
        else target().set(item.id, item.quantity);
      }
      return { basketItemsUpdate: { status: 'SUCCESS', result: view().basket } };
    },
    'gql:totalPrice': (c: Call) => {
      const products = (c.body as { variables: { products: { quantity: number }[] } }).variables.products;
      const sum = products.reduce((s, p) => s + p.quantity * 2, 0);
      return { totalPrice: { withoutDiscount: { amount: sum }, discount: { amount: 0 } } };
    },
    '/search/v2/products': (c: Call) => c.query.getAll('ids').map((id) => restProduct(Number(id))),
    '/order/v1/summaries/active': state.order
      ? { id: 77, state: 'REOPENED', shoppingType: 'DELIVERY' }
      : new Response('', { status: 404 }),
    '/order/v1/77/details-grouped-by-taxonomy': { orderId: 77, closingTime: '2026-10-30T22:59:00Z' },
  });
  return { state, calls };
}

describe('planChanges', () => {
  it('merges requests into absolute targets and drops no-ops', () => {
    const current = new Map([
      [1, 2],
      [2, 1],
    ]);
    expect(
      planChanges(current, [
        { productId: 1, add: 1 },
        { productId: 1, add: 1 },
        { productId: 2, quantity: 1 },
        { productId: 3, quantity: 2 },
      ]),
    ).toEqual([
      { productId: 1, from: 2, to: 4 },
      { productId: 3, from: 0, to: 2 },
    ]);
  });

  it('rejects quantities out of range', () => {
    expect(() => planChanges(new Map(), [{ productId: 1, add: -1 }])).toThrow(/whole number/);
    expect(() => planChanges(new Map(), [{ productId: 1 }])).toThrow(/quantity or add/);
  });

  it('detects a booked order', () => {
    expect(orderActive(basketWith([[1, 1]]))).toBe(false);
    expect(orderActive(basketWith([], [[1, 1]]))).toBe(true);
  });
});

describe('shopping list and basket tools', () => {
  it('changes the list directly while no delivery is booked', async () => {
    const { state } = statefulApi({ list: [[1, 1]] });
    const { client } = await connect(await signedInContext());
    const result = await call(client, 'update_shopping_list', {
      items: [
        { productId: 2, quantity: 3 },
        { productId: 1, quantity: 0 },
      ],
    });
    expect(result.isError).toBe(false);
    expect([...state.list]).toEqual([[2, 3]]);
  });

  it('refuses direct list changes once an order is booked', async () => {
    const { state } = statefulApi({ list: [], order: [[5, 1]] });
    const { client } = await connect(await signedInContext());
    const result = await call(client, 'update_shopping_list', { items: [{ productId: 2, quantity: 1 }] });
    expect(result.data.error?.code).toBe('NOT_ALLOWED');
    expect([...state.order!]).toEqual([[5, 1]]);
  });

  it('previews an order change, applies it only on confirmation, and refuses token reuse', async () => {
    const { state, calls } = statefulApi({ list: [], order: [[5, 1]] });
    const { client } = await connect(await signedInContext());
    const preview = await call(client, 'prepare_basket_change', {
      items: [
        { productId: 5, add: 1 },
        { productId: 6, quantity: 2 },
      ],
    });
    expect(preview.isError).toBe(false);
    expect(preview.data).toMatchObject({
      target: 'booked order',
      totalBefore: 2,
      totalAfter: 8,
      difference: 6,
      orderClosesAt: expect.any(String),
    });
    expect(calls.some((c) => c.operation?.startsWith('basketItems'))).toBe(false);
    expect([...state.order!]).toEqual([[5, 1]]);

    const token = preview.data.confirmationToken as string;
    const refused = await call(client, 'confirm_basket_change', {
      confirmationToken: token,
      confirmed: false,
    });
    expect(refused.isError).toBe(true);

    const preview2 = await call(client, 'prepare_basket_change', {
      items: [
        { productId: 5, add: 1 },
        { productId: 6, quantity: 2 },
      ],
    });
    const token2 = preview2.data.confirmationToken as string;
    const applied = await call(client, 'confirm_basket_change', {
      confirmationToken: token2,
      confirmed: true,
    });
    expect(applied.data).toMatchObject({ applied: true, target: 'booked order' });
    expect(new Map(state.order!)).toEqual(
      new Map([
        [5, 2],
        [6, 2],
      ]),
    );

    const replay = await call(client, 'confirm_basket_change', {
      confirmationToken: token2,
      confirmed: true,
    });
    expect(replay.data.error?.code).toBe('PREVIEW_EXPIRED');
  });

  it('refuses a confirmation when the basket changed after the preview', async () => {
    const { state } = statefulApi({ list: [[1, 1]] });
    const { client } = await connect(await signedInContext());
    const preview = await call(client, 'prepare_basket_change', { items: [{ productId: 1, quantity: 4 }] });
    state.list.set(1, 2);
    const result = await call(client, 'confirm_basket_change', {
      confirmationToken: preview.data.confirmationToken,
      confirmed: true,
    });
    expect(result.data.error?.code).toBe('PREVIEW_CHANGED');
    expect(state.list.get(1)).toBe(2);
  });

  it('refuses a token issued to another account', async () => {
    statefulApi({ list: [] });
    const ctx = await signedInContext('1001');
    const { client } = await connect(ctx);
    const preview = await call(client, 'prepare_basket_change', { items: [{ productId: 1, quantity: 1 }] });
    await ctx.session.update((d) => {
      d.user!.memberId = '2002';
    });
    const result = await call(client, 'confirm_basket_change', {
      confirmationToken: preview.data.confirmationToken,
      confirmed: true,
    });
    expect(result.data.error?.code).toBe('ACCOUNT_CHANGED');
  });
});
