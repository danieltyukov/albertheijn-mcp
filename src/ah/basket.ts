import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { amsterdam, productUrl, round2 } from './format.js';

/**
 * In the Albert Heijn app the shopping list and the online order share one "basket".
 * Without a booked delivery the basket is the list. Once a delivery or pick-up slot is
 * booked, products added to the basket go into that real order until its closing time.
 */

const PRODUCT = 'product { id title salesUnitSize priceV2 { now { amount } was { amount } } }';
const BASKET_FIELDS = `id canChangeDelivery
  itemsInList { id quantity originCode position isStrikethrough ${PRODUCT} }
  itemsInOrder { id quantity allocatedQuantity originCode position isClosed ${PRODUCT} }
  notes { description quantity searchTerm originCode position isStrikethrough }
  summary { quantity isCancellable shoppingType deliveryDate
            price { priceBeforeDiscount { amount } priceAfterDiscount { amount } totalPrice { amount } discount { amount } } }`;

interface RawProductRef {
  id: number;
  title: string;
  salesUnitSize?: string;
  priceV2?: { now?: { amount?: number }; was?: { amount?: number } };
}

interface RawItem {
  id?: number | string;
  quantity?: number;
  allocatedQuantity?: number;
  isStrikethrough?: boolean;
  isClosed?: boolean;
  product?: RawProductRef | null;
}

interface RawNote {
  description?: string;
  quantity?: number;
  isStrikethrough?: boolean;
}

export interface RawBasket {
  id?: string | number;
  canChangeDelivery?: boolean;
  itemsInList?: RawItem[] | null;
  itemsInOrder?: RawItem[] | null;
  notes?: RawNote[] | null;
  summary?: {
    quantity?: number;
    isCancellable?: boolean;
    shoppingType?: string | null;
    deliveryDate?: string | null;
    price?: {
      priceBeforeDiscount?: { amount?: number };
      priceAfterDiscount?: { amount?: number };
      totalPrice?: { amount?: number };
      discount?: { amount?: number };
    };
  } | null;
}

export interface BasketLine {
  productId: number;
  title: string;
  quantity: number;
  unitSize?: string;
  price?: number;
  lineTotal?: number;
  checked?: boolean;
  url: string;
}

export interface ShoppingList {
  /** True when a delivery or pick-up is booked: list changes then change that order. */
  orderActive: boolean;
  items: BasketLine[];
  notes: { text: string; quantity: number; checked?: boolean }[];
  itemCount: number;
  estimatedTotal: number;
}

export function lines(items: RawItem[] | null | undefined): BasketLine[] {
  return (items ?? [])
    .filter((item) => item.product?.id !== undefined)
    .map((item) => {
      const p = item.product!;
      const quantity = item.quantity ?? 1;
      const line: BasketLine = { productId: p.id, title: p.title, quantity, url: productUrl(p.id) };
      if (p.salesUnitSize) line.unitSize = p.salesUnitSize;
      const price = p.priceV2?.now?.amount;
      if (price !== undefined) {
        line.price = price;
        line.lineTotal = round2(price * quantity);
      }
      if (item.isStrikethrough) line.checked = true;
      return line;
    });
}

export function orderActive(basket: RawBasket): boolean {
  return Boolean(
    (basket.itemsInOrder && basket.itemsInOrder.length) ||
    basket.summary?.shoppingType ||
    basket.summary?.deliveryDate,
  );
}

export async function rawBasket(ctx: AppContext): Promise<RawBasket> {
  const data = await ctx.ah.graphql<{ basket: RawBasket | null }>(
    `query Basket { basket { ${BASKET_FIELDS} } }`,
    {},
    { auth: 'user' },
  );
  if (!data.basket) throw new AhError('FORMAT_CHANGED', 'Albert Heijn returned no basket.');
  return data.basket;
}

export async function shoppingList(ctx: AppContext): Promise<ShoppingList> {
  const basket = await rawBasket(ctx);
  const items = lines(basket.itemsInList);
  return {
    orderActive: orderActive(basket),
    items,
    notes: (basket.notes ?? []).map((n) => {
      const note: ShoppingList['notes'][number] = { text: n.description ?? '', quantity: n.quantity ?? 1 };
      if (n.isStrikethrough) note.checked = true;
      return note;
    }),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    estimatedTotal: round2(items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0)),
  };
}

interface MutationResult {
  status?: string;
  errorMessage?: string | null;
  result?: RawBasket | null;
}

function checkMutation(name: string, result: MutationResult | null | undefined): RawBasket | undefined {
  if (!result)
    throw new AhError('OUTCOME_UNKNOWN', `${name} returned nothing. Check the basket before trying again.`);
  if (result.status && result.status !== 'SUCCESS') {
    throw new AhError(
      'UNAVAILABLE',
      `Albert Heijn refused the change: ${(result.errorMessage ?? result.status).slice(0, 200)}`,
    );
  }
  return result.result ?? undefined;
}

/** Add quantities to the basket (adds to what is already there). */
export async function basketAdd(
  ctx: AppContext,
  items: { productId: number; quantity: number }[],
): Promise<RawBasket | undefined> {
  if (!items.length) return undefined;
  const data = await ctx.ah.graphql<{ basketItemsAdd: MutationResult }>(
    `mutation BasketItemsAdd($items: [BasketMutation!]!) { basketItemsAdd(items: $items) { status errorMessage result { ${BASKET_FIELDS} } } }`,
    { items: items.map((i) => ({ id: i.productId, quantity: i.quantity })) },
    { auth: 'user', allowPartial: true },
  );
  return checkMutation('Adding to the basket', data.basketItemsAdd);
}

/** Set absolute quantities in the basket; 0 removes the product. */
export async function basketSet(
  ctx: AppContext,
  items: { productId: number; quantity: number }[],
): Promise<RawBasket | undefined> {
  if (!items.length) return undefined;
  const data = await ctx.ah.graphql<{ basketItemsUpdate: MutationResult }>(
    `mutation BasketItemsUpdate($items: [BasketMutation!]!) { basketItemsUpdate(items: $items) { status errorMessage result { ${BASKET_FIELDS} } } }`,
    { items: items.map((i) => ({ id: i.productId, quantity: i.quantity })) },
    { auth: 'user', allowPartial: true },
  );
  return checkMutation('Changing the basket', data.basketItemsUpdate);
}

/** Add or remove free-text notes on the list ("quantity: 0" removes). Rejected while an order is active. */
export async function setNotes(ctx: AppContext, notes: { text: string; quantity: number }[]): Promise<void> {
  if (!notes.length) return;
  await ctx.ah.request('/mobile-services/shoppinglist/v2/items', {
    method: 'PATCH',
    query: { orderBy: 'userInput', orderByParam: 0 },
    body: {
      items: notes.map((n) => ({
        description: n.text,
        quantity: n.quantity,
        type: 'SHOPPABLE',
        originCode: 'PRD',
        strikeThrough: false,
      })),
    },
    auth: 'user',
  });
}

export interface ChangeRequest {
  productId: number;
  /** Set the quantity to this value; 0 removes. */
  quantity?: number;
  /** Or add this many to whatever is there. */
  add?: number;
}

export interface PlannedChange {
  productId: number;
  title: string;
  unitSize?: string;
  price?: number;
  from: number;
  to: number;
}

/** Merge requests per product and turn them into absolute target quantities. */
export function planChanges(
  current: Map<number, number>,
  requests: ChangeRequest[],
): { productId: number; from: number; to: number }[] {
  const targets = new Map<number, number>();
  for (const request of requests) {
    if (!Number.isInteger(request.productId) || request.productId <= 0)
      throw new AhError('INVALID_ARGUMENT', `Invalid product id ${request.productId}.`);
    const base = targets.get(request.productId) ?? current.get(request.productId) ?? 0;
    let next: number;
    if (request.quantity !== undefined) next = request.quantity;
    else if (request.add !== undefined) next = base + request.add;
    else throw new AhError('INVALID_ARGUMENT', `Give quantity or add for product ${request.productId}.`);
    if (!Number.isInteger(next) || next < 0 || next > 99)
      throw new AhError(
        'INVALID_ARGUMENT',
        `Quantity for product ${request.productId} must be a whole number from 0 to 99.`,
      );
    targets.set(request.productId, next);
  }
  return [...targets]
    .map(([productId, to]) => ({ productId, from: current.get(productId) ?? 0, to }))
    .filter((c) => c.from !== c.to);
}

/** Apply target quantities: products not in the basket yet are added, the rest are set. */
export async function applyChanges(
  ctx: AppContext,
  changes: { productId: number; from: number; to: number }[],
): Promise<RawBasket | undefined> {
  const additions = changes
    .filter((c) => c.from === 0 && c.to > 0)
    .map((c) => ({ productId: c.productId, quantity: c.to }));
  const updates = changes.filter((c) => c.from > 0).map((c) => ({ productId: c.productId, quantity: c.to }));
  let basket: RawBasket | undefined;
  if (updates.length) basket = await basketSet(ctx, updates);
  if (additions.length) basket = (await basketAdd(ctx, additions)) ?? basket;
  return basket;
}

export function quantities(items: RawItem[] | null | undefined): Map<number, number> {
  const map = new Map<number, number>();
  for (const item of items ?? [])
    if (item.product?.id !== undefined)
      map.set(item.product.id, (map.get(item.product.id) ?? 0) + (item.quantity ?? 0));
  return map;
}

interface RawActiveOrder {
  id?: number;
  state?: string;
  shoppingType?: string;
  totalPrice?: {
    priceBeforeDiscount?: number;
    priceAfterDiscount?: number;
    priceDiscount?: number;
    priceTotalPayable?: number;
  };
  deliveryInformation?: {
    deliveryDate?: string;
    deliveryStartTime?: string;
    deliveryEndTime?: string;
    address?: { street?: string; houseNumber?: number | string; zipCode?: string; city?: string };
  };
}

interface RawOrderDetails {
  orderId?: number;
  orderState?: string;
  closingTime?: string;
  deliveryType?: string;
  deliveryTimePeriod?: { startDateTime?: string; endDateTime?: string };
  cancellable?: boolean;
  reopenable?: boolean;
}

export interface ActiveOrder {
  active: boolean;
  orderId?: number;
  state?: string;
  type?: string;
  delivery?: { date?: string; from?: string; until?: string; window?: string; address?: string };
  /** After this moment Albert Heijn no longer accepts changes. */
  closesAt?: string;
  closesAtLocal?: string;
  items: BasketLine[];
  itemCount: number;
  totals?: { beforeDiscount?: number; discount?: number; payable?: number };
  note?: string;
}

/** The booked order that list changes would go into, if there is one. */
export async function activeOrder(ctx: AppContext): Promise<ActiveOrder> {
  const [basket, summary] = await Promise.all([
    rawBasket(ctx),
    ctx.ah
      .requestMaybe<RawActiveOrder>('/mobile-services/order/v1/summaries/active', {
        query: { sortBy: 'DEFAULT' },
        auth: 'user',
        allow404: true,
      })
      .catch(() => undefined),
  ]);
  const active = orderActive(basket) || Boolean(summary?.id);
  const items = lines(basket.itemsInOrder);
  const order: ActiveOrder = {
    active,
    items,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
  };
  if (!active) {
    order.note =
      'No delivery or pick-up is booked. Book a slot in the Albert Heijn app first; until then changes only touch your list.';
    return order;
  }
  if (summary?.id) {
    order.orderId = summary.id;
    if (summary.state) order.state = summary.state;
    if (summary.shoppingType) order.type = summary.shoppingType;
    const d = summary.deliveryInformation;
    if (d) {
      const delivery: NonNullable<ActiveOrder['delivery']> = {};
      if (d.deliveryDate) delivery.date = d.deliveryDate;
      if (d.deliveryStartTime) delivery.from = d.deliveryStartTime;
      if (d.deliveryEndTime) delivery.until = d.deliveryEndTime;
      if (d.address?.street)
        delivery.address =
          `${d.address.street} ${d.address.houseNumber ?? ''}, ${d.address.zipCode ?? ''} ${d.address.city ?? ''}`
            .replace(/\s+/g, ' ')
            .trim();
      order.delivery = delivery;
    }
    const t = summary.totalPrice;
    if (t) {
      order.totals = {};
      if (t.priceBeforeDiscount !== undefined) order.totals.beforeDiscount = t.priceBeforeDiscount;
      if (t.priceDiscount !== undefined) order.totals.discount = t.priceDiscount;
      if (t.priceTotalPayable !== undefined) order.totals.payable = t.priceTotalPayable;
    }
    const details = await ctx.ah
      .requestMaybe<RawOrderDetails>(`/mobile-services/order/v1/${summary.id}/details-grouped-by-taxonomy`, {
        auth: 'user',
        allow404: true,
      })
      .catch(() => undefined);
    if (details?.closingTime) {
      order.closesAt = details.closingTime;
      const local = amsterdam(details.closingTime);
      if (local) order.closesAtLocal = local;
    }
    if (details?.deliveryTimePeriod?.startDateTime) {
      order.delivery ??= {};
      order.delivery.window = `${amsterdam(details.deliveryTimePeriod.startDateTime)} - ${amsterdam(details.deliveryTimePeriod.endDateTime)?.split(' ').pop() ?? ''}`;
    }
  } else if (basket.summary?.deliveryDate) {
    order.delivery = { date: basket.summary.deliveryDate };
  }
  return order;
}
