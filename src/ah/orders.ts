import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { amsterdam, productUrl, round2 } from './format.js';

interface RawFulfillment {
  orderId?: number;
  statusCode?: string;
  statusDescription?: string;
  shoppingType?: string;
  transactionCompleted?: boolean;
  modifiable?: boolean;
  totalPrice?: { totalPrice?: { amount?: number }; discount?: { amount?: number } };
  delivery?: {
    status?: string;
    method?: string;
    slot?: {
      date?: string;
      dateDisplay?: string;
      timeDisplay?: string;
      startTime?: string;
      endTime?: string;
    };
  };
}

export interface OrderSummary {
  orderId: number;
  status?: string;
  type?: string;
  date?: string;
  time?: string;
  total?: number;
  discount?: number;
  modifiable?: boolean;
}

const FULFILLMENTS = (
  status: 'OPEN' | 'CLOSED',
) => `query Orders { orderFulfillments(status: ${status}) { result {
  orderId statusCode statusDescription shoppingType transactionCompleted modifiable
  totalPrice { totalPrice { amount } discount { amount } }
  delivery { status method slot { date dateDisplay timeDisplay startTime endTime } }
} } }`;

function shape(raw: RawFulfillment): OrderSummary | undefined {
  if (raw.orderId === undefined) return undefined;
  const order: OrderSummary = { orderId: raw.orderId };
  const status = raw.statusDescription ?? raw.delivery?.status ?? raw.statusCode;
  if (status) order.status = status;
  const type = raw.shoppingType ?? raw.delivery?.method;
  if (type) order.type = type;
  const slot = raw.delivery?.slot;
  if (slot?.date) order.date = slot.date;
  if (slot?.timeDisplay) order.time = slot.timeDisplay;
  const total = raw.totalPrice?.totalPrice?.amount;
  if (total !== undefined) order.total = total;
  const discount = raw.totalPrice?.discount?.amount;
  if (discount) order.discount = discount;
  if (raw.modifiable !== undefined) order.modifiable = raw.modifiable;
  return order;
}

export async function listOrders(
  ctx: AppContext,
  which: 'open' | 'past' | 'all' = 'all',
  limit = 20,
): Promise<{ open?: OrderSummary[]; past?: OrderSummary[] }> {
  const get = async (status: 'OPEN' | 'CLOSED') => {
    const data = await ctx.ah.graphql<{ orderFulfillments: { result?: RawFulfillment[] | null } | null }>(
      FULFILLMENTS(status),
      {},
      { auth: 'user', allowPartial: true },
    );
    return (data.orderFulfillments?.result ?? [])
      .map(shape)
      .filter((o): o is OrderSummary => Boolean(o))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .slice(0, limit);
  };
  const result: { open?: OrderSummary[]; past?: OrderSummary[] } = {};
  if (which !== 'past') result.open = await get('OPEN');
  if (which !== 'open') result.past = await get('CLOSED');
  return result;
}

interface RawDetailProduct {
  amount?: number;
  quantity?: number;
  allocatedQuantity?: number;
  product?: {
    webshopId?: number;
    title?: string;
    brand?: string;
    salesUnitSize?: string;
    priceBeforeBonus?: number;
    currentPrice?: number | null;
    isBonus?: boolean;
    bonusMechanism?: string | null;
  };
}

interface RawOrderDetails {
  orderId?: number;
  orderState?: string;
  deliveryDate?: string;
  closingTime?: string;
  deliveryType?: string;
  deliveryTimePeriod?: { startDateTime?: string; endDateTime?: string };
  groupedProductsInTaxonomy?: { taxonomyName?: string; orderedProducts?: RawDetailProduct[] }[];
  cancellable?: boolean;
  reopenable?: boolean;
}

export interface OrderDetails {
  orderId: number;
  state?: string;
  deliveryDate?: string;
  deliveryWindow?: string;
  closesAt?: string;
  type?: string;
  groups: {
    category: string;
    items: {
      productId: number;
      title: string;
      quantity: number;
      delivered?: number;
      unitSize?: string;
      price?: number;
      deal?: string;
      url: string;
    }[];
  }[];
  itemCount: number;
  estimatedTotal: number;
}

export async function orderDetails(ctx: AppContext, orderId: number): Promise<OrderDetails> {
  const raw = await ctx.ah.requestMaybe<RawOrderDetails>(
    `/mobile-services/order/v1/${orderId}/details-grouped-by-taxonomy`,
    {
      auth: 'user',
      allow404: true,
    },
  );
  if (!raw) throw new AhError('NOT_FOUND', `No order ${orderId} on this account.`);
  let count = 0;
  let total = 0;
  const groups = (raw.groupedProductsInTaxonomy ?? []).map((group) => ({
    category: group.taxonomyName ?? 'Other',
    items: (group.orderedProducts ?? [])
      .filter((p) => p.product?.webshopId !== undefined)
      .map((p) => {
        const product = p.product!;
        const quantity = p.quantity ?? 0;
        const price = product.currentPrice ?? product.priceBeforeBonus;
        count += quantity;
        if (price !== undefined && price !== null) total += price * quantity;
        const item: OrderDetails['groups'][number]['items'][number] = {
          productId: product.webshopId!,
          title: product.title ?? '',
          quantity,
          url: productUrl(product.webshopId!),
        };
        if (p.allocatedQuantity !== undefined && p.allocatedQuantity !== quantity)
          item.delivered = p.allocatedQuantity;
        if (product.salesUnitSize) item.unitSize = product.salesUnitSize;
        if (price !== undefined && price !== null) item.price = price;
        if (product.isBonus && product.bonusMechanism) item.deal = product.bonusMechanism;
        return item;
      }),
  }));
  const details: OrderDetails = {
    orderId: raw.orderId ?? orderId,
    groups,
    itemCount: count,
    estimatedTotal: round2(total),
  };
  if (raw.orderState) details.state = raw.orderState;
  if (raw.deliveryDate) details.deliveryDate = raw.deliveryDate;
  if (raw.deliveryTimePeriod?.startDateTime) {
    details.deliveryWindow = `${amsterdam(raw.deliveryTimePeriod.startDateTime)} - ${amsterdam(raw.deliveryTimePeriod.endDateTime)?.split(' ').pop() ?? ''}`;
  }
  if (raw.closingTime) details.closesAt = amsterdam(raw.closingTime) ?? raw.closingTime;
  if (raw.deliveryType) details.type = raw.deliveryType;
  return details;
}

/** Products bought most often across recent online orders. */
export async function frequentProducts(ctx: AppContext, ordersToRead = 8, limit = 30) {
  const { past = [] } = await listOrders(ctx, 'past', Math.min(Math.max(ordersToRead, 1), 25));
  const counts = new Map<number, { title: string; orders: number; units: number; lastPrice?: number }>();
  let read = 0;
  for (const order of past) {
    const details = await orderDetails(ctx, order.orderId).catch(() => undefined);
    if (!details) continue;
    read += 1;
    for (const group of details.groups) {
      for (const item of group.items) {
        const entry = counts.get(item.productId) ?? { title: item.title, orders: 0, units: 0 };
        entry.orders += 1;
        entry.units += item.quantity;
        if (item.price !== undefined) entry.lastPrice ??= item.price;
        counts.set(item.productId, entry);
      }
    }
  }
  return {
    ordersRead: read,
    products: [...counts]
      .sort((a, b) => b[1].orders - a[1].orders || b[1].units - a[1].units)
      .slice(0, limit)
      .map(([productId, v]) => ({
        productId,
        title: v.title,
        inOrders: v.orders,
        averageQuantity: Math.round((v.units / v.orders) * 10) / 10,
        ...(v.lastPrice !== undefined ? { lastPrice: v.lastPrice } : {}),
        url: productUrl(productId),
      })),
  };
}
