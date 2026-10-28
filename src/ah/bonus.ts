import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { addDays, mondayOf, pickImage, productUrl, round2, type RawImage } from './format.js';
import { summarize, type ProductSummary, type RawDiscountLabel, type RawProduct } from './products.js';

const HOUR = 60 * 60_000;

interface RawMetadata {
  periods?: {
    bonusStartDate: string;
    bonusEndDate: string;
    nextPeriodVisibleFrom?: string;
    tabs?: {
      description?: string;
      urlMetadataList?: { url: string; count?: number; bonusType?: string; description?: string }[];
    }[];
  }[];
}

interface RawBonusGroup {
  id?: string;
  segmentId?: number;
  segmentDescription?: string;
  discountDescription?: string;
  discountLabels?: RawDiscountLabel[];
  category?: string;
  promotionType?: string;
  bonusStartDate?: string;
  bonusEndDate?: string;
  images?: RawImage[];
  products?: RawProduct[];
  exampleFromPrice?: number | null;
  exampleForPrice?: number | null;
  extraDescriptions?: string[];
  exceptionRule?: string;
  storeOnlyPromotion?: boolean;
  isStapelBonus?: boolean;
  activationStatus?: string;
  offerId?: number;
}

interface RawSection {
  sectionDescription?: string;
  bonusGroupOrProducts?: { bonusGroup?: RawBonusGroup; product?: RawProduct }[];
}

export interface BonusPeriod {
  startDate: string;
  endDate: string;
  nextWeekVisibleFrom?: string;
  sections: { name: string; type?: string; count?: number }[];
}

export interface BonusOffer {
  /** Use with get_bonus_group to list every product in the offer. */
  groupId?: string;
  productId?: number;
  title: string;
  deal?: string;
  category?: string;
  type?: string;
  startDate?: string;
  endDate?: string;
  /** Example price before and after the deal, when Albert Heijn gives one. */
  examplePrice?: { from?: number; for?: number };
  conditions?: string[];
  storeOnly?: boolean;
  stacksWithOtherBonus?: boolean;
  activation?: string;
  image?: string;
  /** Present for single-product offers. */
  product?: ProductSummary;
}

async function metadata(ctx: AppContext): Promise<RawMetadata> {
  return ctx.cache.get('bonus:metadata', HOUR, () =>
    ctx.ah.request<RawMetadata>('/mobile-services/bonuspage/v3/metadata'),
  );
}

export async function bonusPeriods(ctx: AppContext): Promise<BonusPeriod[]> {
  const meta = await metadata(ctx);
  return (meta.periods ?? []).map((p) => {
    const period: BonusPeriod = {
      startDate: p.bonusStartDate,
      endDate: p.bonusEndDate,
      sections: [],
    };
    if (p.nextPeriodVisibleFrom) period.nextWeekVisibleFrom = p.nextPeriodVisibleFrom;
    const seen = new Set<string>();
    for (const tab of p.tabs ?? []) {
      for (const entry of tab.urlMetadataList ?? []) {
        const name = entry.description ?? tab.description ?? '';
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const section: BonusPeriod['sections'][number] = { name };
        if (entry.bonusType) section.type = entry.bonusType;
        if (entry.count !== undefined) section.count = entry.count;
        period.sections.push(section);
      }
    }
    return period;
  });
}

export function shapeGroup(group: RawBonusGroup): BonusOffer {
  const offer: BonusOffer = { title: group.segmentDescription ?? 'Bonus' };
  if (group.id) offer.groupId = group.id;
  else if (group.segmentId) offer.groupId = String(group.segmentId);
  const deal = group.discountDescription ?? group.discountLabels?.[0]?.defaultDescription;
  if (deal) offer.deal = deal;
  if (group.category) offer.category = group.category;
  if (group.promotionType) offer.type = group.promotionType;
  if (group.bonusStartDate) offer.startDate = group.bonusStartDate;
  if (group.bonusEndDate) offer.endDate = group.bonusEndDate;
  if (group.exampleFromPrice != null || group.exampleForPrice != null) {
    offer.examplePrice = {};
    if (group.exampleFromPrice != null) offer.examplePrice.from = group.exampleFromPrice;
    if (group.exampleForPrice != null) offer.examplePrice.for = group.exampleForPrice;
  }
  const conditions = [
    ...(group.extraDescriptions ?? []),
    ...(group.exceptionRule ? [group.exceptionRule] : []),
  ].filter(Boolean);
  if (conditions.length) offer.conditions = conditions;
  if (group.storeOnlyPromotion) offer.storeOnly = true;
  if (group.isStapelBonus) offer.stacksWithOtherBonus = true;
  if (group.activationStatus) offer.activation = group.activationStatus;
  const image = pickImage(group.images);
  if (image) offer.image = image;
  return offer;
}

function shapeEntry(entry: { bonusGroup?: RawBonusGroup; product?: RawProduct }): BonusOffer | undefined {
  if (entry.bonusGroup) return shapeGroup(entry.bonusGroup);
  if (entry.product) {
    const product = summarize(entry.product);
    const offer: BonusOffer = { productId: product.id, title: product.title, product };
    if (product.bonus?.mechanism) offer.deal = product.bonus.mechanism;
    if (product.bonus?.type) offer.type = product.bonus.type;
    if (product.bonus?.startDate) offer.startDate = product.bonus.startDate;
    if (product.bonus?.endDate) offer.endDate = product.bonus.endDate;
    return offer;
  }
  return undefined;
}

export interface BonusQuery {
  week?: 'current' | 'next';
  /** A section name from bonus periods, e.g. "Kaas" or "Groente, aardappelen". */
  section?: string;
  /** Keep offers whose title, deal or category contains this text. */
  search?: string;
  limit?: number;
}

export interface BonusResult {
  week: { startDate: string; endDate: string };
  sections?: string[];
  total: number;
  offers: BonusOffer[];
}

function matches(offer: BonusOffer, needle: string): boolean {
  const hay =
    `${offer.title} ${offer.deal ?? ''} ${offer.category ?? ''} ${offer.product?.brand ?? ''}`.toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** This week's or next week's bonus offers, optionally for one section or matching a search. */
export async function bonusOffers(ctx: AppContext, query: BonusQuery): Promise<BonusResult> {
  const meta = await metadata(ctx);
  const periods = meta.periods ?? [];
  if (!periods.length) throw new AhError('FORMAT_CHANGED', 'Albert Heijn returned no bonus periods.');
  const thisMonday = mondayOf();
  const current =
    periods.find((p) => p.bonusStartDate <= thisMonday && p.bonusEndDate >= thisMonday) ?? periods[0]!;
  let period = current;
  if (query.week === 'next') {
    const next = periods.find((p) => p.bonusStartDate > current.bonusStartDate);
    if (!next) {
      throw new AhError(
        'NOT_FOUND',
        `Next week's bonus is not published yet${current.nextPeriodVisibleFrom ? `; it appears on ${current.nextPeriodVisibleFrom}` : ''}.`,
      );
    }
    period = next;
  }
  const entries = (period.tabs ?? []).flatMap((t) => t.urlMetadataList ?? []);
  const nationals = entries.filter(
    (e) => e.bonusType === 'NATIONAL' || e.bonusType === 'SPOTLIGHT' || e.bonusType === 'AHONLINE',
  );
  let chosen = nationals.filter((e) => e.bonusType === 'NATIONAL');
  if (query.section) {
    const needle = query.section.toLowerCase();
    chosen = entries.filter((e) => (e.description ?? '').toLowerCase().includes(needle));
    if (!chosen.length) {
      throw new AhError('NOT_FOUND', `No bonus section matches "${query.section}".`, {
        sections: [...new Set(entries.map((e) => e.description).filter(Boolean))],
      });
    }
  }
  const sections = await Promise.all(
    chosen.map((entry) =>
      ctx.cache.get(`bonus:${entry.url}`, HOUR, () =>
        ctx.ah.request<RawSection>(`/mobile-services/${entry.url.replace(/^\/+/, '')}`),
      ),
    ),
  );
  const seen = new Set<string>();
  let offers: BonusOffer[] = [];
  for (const section of sections) {
    for (const entry of section?.bonusGroupOrProducts ?? []) {
      const offer = shapeEntry(entry);
      if (!offer) continue;
      if (!offer.category && section?.sectionDescription) offer.category = section.sectionDescription;
      const key = offer.groupId ?? `p${offer.productId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      offers.push(offer);
    }
  }
  if (query.search) offers = offers.filter((o) => matches(o, query.search!));
  const limit = Math.min(Math.max(query.limit ?? 40, 1), 200);
  const result: BonusResult = {
    week: { startDate: period.bonusStartDate, endDate: period.bonusEndDate },
    total: offers.length,
    offers: offers.slice(0, limit),
  };
  if (!query.section)
    result.sections = [...new Set(entries.map((e) => e.description).filter((d): d is string => Boolean(d)))];
  return result;
}

interface GqlPromotion {
  bonusPromotions: {
    id: string;
    title: string;
    productCount?: number;
    products: {
      id: number;
      title: string;
      brand?: string;
      salesUnitSize?: string;
      availability?: { isOrderable?: boolean };
      priceV2?: {
        now?: { amount?: number };
        was?: { amount?: number };
        promotionLabel?: { tiers?: { mechanism?: string; description?: string }[] };
      };
    }[];
  }[];
}

const GQL_PROMOTION = `query FetchBonusPromotionWithProducts($id: String, $periodStart: String, $periodEnd: String) {
  bonusPromotions(input: { id: $id, periodStart: $periodStart, periodEnd: $periodEnd,
      filterUnavailableProducts: true, forcePromotionVisibility: true, showAllPromotionSegments: true }) {
    id title productCount
    products {
      id title brand salesUnitSize availability { isOrderable }
      priceV2(periodStart: $periodStart, periodEnd: $periodEnd, filterUnavailableProducts: true, forcePromotionVisibility: true) {
        now { amount } was { amount } promotionLabel { tiers { mechanism description } }
      }
    }
  }
}`;

export interface BonusGroupProducts {
  groupId: string;
  title: string;
  week: { startDate: string; endDate: string };
  products: (Pick<ProductSummary, 'id' | 'title' | 'brand' | 'unitSize' | 'orderable' | 'url'> & {
    price?: number;
    regularPrice?: number;
    deal?: string;
  })[];
}

/** Every product in one bonus group, with the price during the bonus week. */
export async function bonusGroupProducts(
  ctx: AppContext,
  groupId: string,
  week: 'current' | 'next' = 'current',
): Promise<BonusGroupProducts> {
  const start = week === 'next' ? addDays(mondayOf(), 7) : mondayOf();
  const end = addDays(start, 6);
  const data = await ctx.cache.get(`bonusgroup:${groupId}:${start}`, HOUR, () =>
    ctx.ah.graphql<GqlPromotion>(GQL_PROMOTION, { id: groupId, periodStart: start, periodEnd: end }),
  );
  const promotion = data.bonusPromotions?.[0];
  if (!promotion) throw new AhError('NOT_FOUND', `No bonus group ${groupId} in the week of ${start}.`);
  return {
    groupId: promotion.id,
    title: promotion.title,
    week: { startDate: start, endDate: end },
    products: promotion.products.map((p) => {
      const item: BonusGroupProducts['products'][number] = {
        id: p.id,
        title: p.title,
        orderable: p.availability?.isOrderable ?? true,
        url: productUrl(p.id),
      };
      if (p.brand) item.brand = p.brand;
      if (p.salesUnitSize) item.unitSize = p.salesUnitSize;
      const now = p.priceV2?.now?.amount;
      const was = p.priceV2?.was?.amount;
      if (now !== undefined) item.price = now;
      if (was !== undefined && was !== now) item.regularPrice = was;
      const deal = p.priceV2?.promotionLabel?.tiers
        ?.map((t) => t.description)
        .filter(Boolean)
        .join(', ');
      if (deal) item.deal = deal;
      return item;
    }),
  };
}

/** Personal Bonus Box offers for the signed-in member. */
export async function personalBonus(
  ctx: AppContext,
  week: 'current' | 'next' = 'current',
): Promise<BonusResult> {
  const start = week === 'next' ? addDays(mondayOf(), 7) : mondayOf();
  const raw = await ctx.ah.request<RawSection | RawSection[]>('/mobile-services/bonuspage/v1/personal', {
    query: { bonusStartDate: start },
    auth: 'user',
  });
  const sections = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const offers = sections
    .flatMap((s) => s.bonusGroupOrProducts ?? [])
    .map(shapeEntry)
    .filter((o): o is BonusOffer => Boolean(o));
  return { week: { startDate: start, endDate: addDays(start, 6) }, total: offers.length, offers };
}

interface GqlTotalPrice {
  totalPrice: { withoutDiscount?: { amount?: number }; discount?: { amount?: number } };
}

/** What a set of products costs together with every bonus deal applied, as Albert Heijn calculates it. */
export async function priceItems(
  ctx: AppContext,
  items: { productId: number; quantity: number }[],
): Promise<{ beforeDiscount: number; discount: number; total: number }> {
  const merged = new Map<number, number>();
  for (const item of items)
    if (item.quantity > 0) merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  if (!merged.size) return { beforeDiscount: 0, discount: 0, total: 0 };
  const data = await ctx.ah.graphql<GqlTotalPrice>(
    'query FetchTotalPrice($products: [PriceLineItem!]!) { totalPrice(products: $products) { withoutDiscount { amount } discount { amount } } }',
    { products: [...merged].map(([id, quantity]) => ({ id, quantity })) },
  );
  const before = data.totalPrice.withoutDiscount?.amount ?? 0;
  const discount = data.totalPrice.discount?.amount ?? 0;
  return { beforeDiscount: round2(before), discount: round2(discount), total: round2(before - discount) };
}
