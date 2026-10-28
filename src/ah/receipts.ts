import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { amsterdam, productUrl, round2 } from './format.js';

interface RawReceiptRef {
  id: string;
  dateTime?: string;
  totalAmount?: { amount?: number };
}

export interface ReceiptSummary {
  id: string;
  date?: string;
  dateLocal?: string;
  total?: number;
}

export async function listReceipts(
  ctx: AppContext,
  offset = 0,
  limit = 20,
): Promise<{ receipts: ReceiptSummary[]; hasMore: boolean }> {
  const size = Math.min(Math.max(limit, 1), 100);
  const data = await ctx.ah.graphql<{ posReceiptsPage: { posReceipts?: RawReceiptRef[] | null } | null }>(
    `query FetchPosReceipts($offset: Int!, $limit: Int!) {
      posReceiptsPage(pagination: { offset: $offset, limit: $limit }) { posReceipts { id dateTime totalAmount { amount } } }
    }`,
    { offset: Math.max(offset, 0), limit: size },
    { auth: 'user' },
  );
  const receipts = (data.posReceiptsPage?.posReceipts ?? []).map((r) => {
    const receipt: ReceiptSummary = { id: r.id };
    if (r.dateTime) {
      receipt.date = r.dateTime;
      const local = amsterdam(r.dateTime);
      if (local) receipt.dateLocal = local;
    }
    if (r.totalAmount?.amount !== undefined) receipt.total = r.totalAmount.amount;
    return receipt;
  });
  return { receipts, hasMore: receipts.length === size };
}

interface RawReceipt {
  id?: string;
  products?: {
    id?: number;
    quantity?: number;
    name?: string;
    price?: { amount?: number } | null;
    amount?: { amount?: number } | null;
  }[];
  discounts?: { name?: string; amount?: { amount?: number } }[];
  payments?: { method?: string; amount?: { amount?: number } }[];
}

export interface Receipt {
  id: string;
  lines: {
    name: string;
    quantity: number;
    unitPrice?: number;
    amount?: number;
    productId?: number;
    url?: string;
  }[];
  discounts: { name: string; amount: number }[];
  payments: { method: string; amount: number }[];
  total: number;
  totalDiscount: number;
}

/** Map till (POS) product ids to webshop ids in one aliased query; -1 means no match. */
export async function convertPosIds(ctx: AppContext, ids: number[]): Promise<Map<number, number>> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 150);
  const map = new Map<number, number>();
  if (!unique.length) return map;
  const query = `query Convert { ${unique.map((id, i) => `p${i}: productConvertId(sourceId: ${id})`).join(' ')} }`;
  const data = await ctx.ah
    .graphql<Record<string, number | null>>(query, {}, { auth: 'user', allowPartial: true })
    .catch(() => ({}) as Record<string, number | null>);
  unique.forEach((id, i) => {
    const value = data[`p${i}`];
    if (typeof value === 'number' && value > 0) map.set(id, value);
  });
  return map;
}

export async function receiptDetails(ctx: AppContext, id: string, mapProducts = true): Promise<Receipt> {
  const data = await ctx.ah.graphql<{ posReceiptDetails: RawReceipt | null }>(
    `query FetchReceipt($id: String!) {
      posReceiptDetails(id: $id) {
        id
        products { id quantity name price { amount } amount { amount } }
        discounts { name amount { amount } }
        payments { method amount { amount } }
      }
    }`,
    { id },
    { auth: 'user', allowPartial: true },
  );
  const raw = data.posReceiptDetails;
  if (!raw) throw new AhError('NOT_FOUND', `No receipt ${id} on this account.`);
  const mapping = mapProducts
    ? await convertPosIds(
        ctx,
        (raw.products ?? []).map((p) => p.id ?? 0),
      )
    : new Map<number, number>();
  const lines = (raw.products ?? []).map((p) => {
    const line: Receipt['lines'][number] = { name: p.name ?? '', quantity: p.quantity ?? 1 };
    if (p.price?.amount !== undefined) line.unitPrice = p.price.amount;
    if (p.amount?.amount !== undefined) line.amount = p.amount.amount;
    const webshopId = p.id !== undefined ? mapping.get(p.id) : undefined;
    if (webshopId) {
      line.productId = webshopId;
      line.url = productUrl(webshopId);
    }
    return line;
  });
  const discounts = (raw.discounts ?? []).map((d) => ({ name: d.name ?? '', amount: d.amount?.amount ?? 0 }));
  const payments = (raw.payments ?? []).map((p) => ({
    method: p.method ?? '',
    amount: p.amount?.amount ?? 0,
  }));
  return {
    id: raw.id ?? id,
    lines,
    discounts,
    payments,
    total: round2(payments.reduce((sum, p) => sum + p.amount, 0)),
    totalDiscount: round2(discounts.reduce((sum, d) => sum + Math.abs(d.amount), 0)),
  };
}

export interface SpendingSummary {
  receiptsRead: number;
  from?: string;
  to?: string;
  total: number;
  byMonth: { month: string; total: number; visits: number }[];
  averagePerVisit: number;
  topProducts?: { name: string; times: number; spent: number }[];
  savedWithDiscounts?: number;
}

/** Spending per month from in-store receipts, and optionally the most bought products. */
export async function spending(ctx: AppContext, months = 3, withProducts = true): Promise<SpendingSummary> {
  const since = new Date();
  since.setMonth(since.getMonth() - Math.min(Math.max(months, 1), 24));
  const all: ReceiptSummary[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await listReceipts(ctx, offset, 50);
    all.push(...page.receipts);
    const last = page.receipts.at(-1)?.date;
    if (!page.hasMore || (last && new Date(last) < since)) break;
  }
  const inRange = all.filter((r) => r.date && new Date(r.date) >= since);
  const byMonth = new Map<string, { total: number; visits: number }>();
  for (const r of inRange) {
    const month = r.date!.slice(0, 7);
    const entry = byMonth.get(month) ?? { total: 0, visits: 0 };
    entry.total += r.total ?? 0;
    entry.visits += 1;
    byMonth.set(month, entry);
  }
  const total = round2(inRange.reduce((sum, r) => sum + (r.total ?? 0), 0));
  const summary: SpendingSummary = {
    receiptsRead: inRange.length,
    total,
    byMonth: [...byMonth]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, total: round2(v.total), visits: v.visits })),
    averagePerVisit: inRange.length ? round2(total / inRange.length) : 0,
  };
  const dates = inRange.map((r) => r.date!).sort();
  if (dates.length) {
    summary.from = dates[0]!.slice(0, 10);
    summary.to = dates.at(-1)!.slice(0, 10);
  }
  if (withProducts && inRange.length) {
    const products = new Map<string, { times: number; spent: number }>();
    let saved = 0;
    for (const r of inRange.slice(0, 40)) {
      const detail = await receiptDetails(ctx, r.id, false).catch(() => undefined);
      if (!detail) continue;
      saved += detail.totalDiscount;
      for (const line of detail.lines) {
        if (!line.name) continue;
        const entry = products.get(line.name) ?? { times: 0, spent: 0 };
        entry.times += 1;
        entry.spent += line.amount ?? 0;
        products.set(line.name, entry);
      }
    }
    summary.topProducts = [...products]
      .sort((a, b) => b[1].times - a[1].times || b[1].spent - a[1].spent)
      .slice(0, 15)
      .map(([name, v]) => ({ name, times: v.times, spent: round2(v.spent) }));
    summary.savedWithDiscounts = round2(saved);
  }
  return summary;
}
