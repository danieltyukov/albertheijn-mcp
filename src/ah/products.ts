import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { parseUnitSize, type Amount } from '../planning/quantity.js';
import { pickImage, productUrl, round2, type RawImage } from './format.js';

const HOUR = 60 * 60_000;

export interface RawDiscountLabel {
  code?: string;
  defaultDescription?: string;
  count?: number;
  freeCount?: number;
  price?: number;
  percentage?: number;
}

/** A product as REST search, products-by-ids and the detail card return it. */
export interface RawProduct {
  webshopId: number;
  title: string;
  brand?: string;
  salesUnitSize?: string;
  unitPriceDescription?: string | null;
  priceBeforeBonus?: number | null;
  currentPrice?: number | null;
  isBonus?: boolean;
  bonusMechanism?: string | null;
  bonusStartDate?: string;
  bonusEndDate?: string;
  promotionType?: string;
  discountLabels?: RawDiscountLabel[];
  mainCategory?: string;
  subCategory?: string;
  nutriscore?: string | null;
  images?: RawImage[];
  availableOnline?: boolean;
  isOrderable?: boolean;
  orderAvailabilityStatus?: string;
  isPreviouslyBought?: boolean;
  propertyIcons?: string[];
  nix18?: boolean;
  isVirtualBundle?: boolean;
  virtualBundleItems?: { productId: number; quantity: number }[];
  isSponsored?: boolean;
}

export interface Bonus {
  mechanism?: string;
  startDate?: string;
  endDate?: string;
  /** NATIONAL for the weekly bonus, AHONLINE for online only, PERSONAL for Bonus Box offers. */
  type?: string;
  onlineOnly?: boolean;
}

export interface ProductSummary {
  id: number;
  title: string;
  brand?: string;
  unitSize?: string;
  /** What one unit costs right now: the bonus price when one applies to a single item, else the regular price. */
  price: number | null;
  regularPrice?: number | null;
  /** As Albert Heijn states it, e.g. "prijs per liter €1.19". */
  unitPrice?: string;
  /** Price per kg, per litre or per piece, computed from the unit size. */
  pricePer?: { amount: number; per: 'kg' | 'l' | 'piece' };
  bonus?: Bonus;
  nutriscore?: string;
  category?: string;
  orderable: boolean;
  previouslyBought?: boolean;
  ageCheck?: boolean;
  sponsored?: boolean;
  /** A multipack Albert Heijn assembles from single products, usually for a volume discount online. */
  bundle?: { items: number };
  image?: string;
  url: string;
}

export function pricePer(
  price: number | null | undefined,
  size: Amount | undefined,
): ProductSummary['pricePer'] {
  if (price == null || !size || size.value <= 0) return undefined;
  if (size.dimension === 'mass') return { amount: round2((price / size.value) * 1000), per: 'kg' };
  if (size.dimension === 'volume') return { amount: round2((price / size.value) * 1000), per: 'l' };
  return { amount: round2(price / size.value), per: 'piece' };
}

export function summarize(raw: RawProduct): ProductSummary {
  const regular = raw.priceBeforeBonus ?? null;
  const price = raw.currentPrice ?? regular;
  const summary: ProductSummary = {
    id: raw.webshopId,
    title: raw.title,
    price,
    orderable: raw.isOrderable ?? raw.availableOnline ?? raw.orderAvailabilityStatus === 'IN_ASSORTMENT',
    url: productUrl(raw.webshopId),
  };
  if (raw.brand) summary.brand = raw.brand;
  if (raw.salesUnitSize) summary.unitSize = raw.salesUnitSize;
  if (raw.currentPrice != null && regular != null && raw.currentPrice !== regular)
    summary.regularPrice = regular;
  if (raw.unitPriceDescription) summary.unitPrice = raw.unitPriceDescription;
  const per = pricePer(price, parseUnitSize(raw.salesUnitSize));
  if (per) summary.pricePer = per;
  if (raw.isBonus) {
    const bonus: Bonus = {};
    const mechanism = raw.bonusMechanism ?? raw.discountLabels?.[0]?.defaultDescription;
    if (mechanism) bonus.mechanism = mechanism;
    if (raw.bonusStartDate) bonus.startDate = raw.bonusStartDate;
    if (raw.bonusEndDate && !raw.bonusEndDate.startsWith('2999')) bonus.endDate = raw.bonusEndDate;
    if (raw.promotionType) {
      bonus.type = raw.promotionType;
      bonus.onlineOnly = raw.promotionType === 'AHONLINE';
    }
    summary.bonus = bonus;
  }
  if (raw.nutriscore) summary.nutriscore = raw.nutriscore;
  const category = [raw.mainCategory, raw.subCategory].filter(Boolean).join(' / ');
  if (category) summary.category = category;
  if (raw.isPreviouslyBought) summary.previouslyBought = true;
  if (raw.nix18) summary.ageCheck = true;
  if (raw.isSponsored) summary.sponsored = true;
  if (raw.isVirtualBundle)
    summary.bundle = {
      items: (raw.virtualBundleItems ?? []).reduce((sum, item) => sum + (item.quantity ?? 1), 0) || 2,
    };
  const image = pickImage(raw.images);
  if (image) summary.image = image;
  return summary;
}

export const SORTS = [
  'relevance',
  'price_low_high',
  'price_high_low',
  'nutriscore',
  'purchase_frequency',
  'purchase_date',
] as const;
export type Sort = (typeof SORTS)[number];

const REST_SORT: Record<Sort, string> = {
  relevance: 'RELEVANCE',
  price_low_high: 'PRICELOWHIGH',
  price_high_low: 'PRICEHIGHLOW',
  nutriscore: 'NUTRISCORE',
  purchase_frequency: 'PURCHASE_FREQUENCY',
  purchase_date: 'PURCHASE_DATE',
};

export interface SearchOptions {
  query?: string;
  categoryId?: number;
  page?: number;
  size?: number;
  sort?: Sort;
  bonusOnly?: boolean;
  brand?: string;
  /** Nutri-Score letters to keep, e.g. ["a", "b"]. */
  nutriscore?: string[];
  /** Slugs from the dieet facet, e.g. "vegetarisch", "veganistisch", "biologisch". */
  diet?: string[];
  /** Slugs from the allergie facet, e.g. "glutenvrij", "lactosevrij". */
  allergy?: string[];
  includeSponsored?: boolean;
}

export interface SearchResult {
  query?: string;
  total: number;
  page: number;
  totalPages?: number;
  products: ProductSummary[];
  /** Facet values Albert Heijn offers for this query, for follow-up filtering. */
  filters?: { name: string; options: string[] }[];
}

interface RestSearch {
  page?: { totalElements?: number; totalPages?: number; number?: number };
  products?: RawProduct[];
}

interface GqlSearch {
  searchProducts: {
    totalFound: number;
    products: { id: number }[];
    facets?: { facets?: { label: string; name: string; options?: { name: string; value: string }[] }[] };
  };
}

const GQL_SEARCH = `query SearchProducts($input: SearchProductsInput!) {
  searchProducts(input: $input) {
    totalFound
    products { id }
    facets { facets { label name options { name value } } }
  }
}`;

function facetFilters(options: SearchOptions): { label: string; values: { values: (string | boolean)[] } }[] {
  const facets: { label: string; values: { values: (string | boolean)[] } }[] = [];
  if (options.bonusOnly) facets.push({ label: 'bonus', values: { values: [true] } });
  if (options.brand)
    facets.push({ label: 'product.brand.name', values: { values: [options.brand.toLowerCase()] } });
  if (options.nutriscore?.length)
    facets.push({
      label: 'product.properties.nutri-score',
      values: { values: options.nutriscore.map((v) => v.toLowerCase()) },
    });
  if (options.diet?.length)
    facets.push({ label: 'product.properties.dieet', values: { values: options.diet } });
  if (options.allergy?.length)
    facets.push({ label: 'product.properties.allergie', values: { values: options.allergy } });
  if (options.categoryId)
    facets.push({ label: 'taxonomy.nodes', values: { values: [String(options.categoryId)] } });
  return facets;
}

/** Product objects in the order of the ids, from the REST products endpoint. */
export async function productsByIds(ctx: AppContext, ids: number[]): Promise<RawProduct[]> {
  if (!ids.length) return [];
  const unique = [...new Set(ids)].slice(0, 100);
  const result = await ctx.ah.request<RawProduct[]>('/mobile-services/product/search/v2/products', {
    query: { ids: unique, sortOn: 'INPUT_PRODUCT_IDS' },
  });
  return Array.isArray(result) ? result : [];
}

/**
 * Search the assortment. Plain searches use the REST search, which carries unit prices
 * and bonus text; filtered searches go through GraphQL facets (REST ignores filters) and
 * are then filled in from the REST products endpoint.
 */
export async function searchProducts(ctx: AppContext, options: SearchOptions): Promise<SearchResult> {
  const size = Math.min(Math.max(options.size ?? 10, 1), 50);
  const page = Math.max(options.page ?? 0, 0);
  const sort = options.sort ?? 'relevance';
  const facets = facetFilters(options);
  const needsFacets = facets.some((f) => f.label !== 'taxonomy.nodes');
  if (!needsFacets) {
    if (!options.query && !options.categoryId)
      throw new AhError('INVALID_ARGUMENT', 'Give a search query, a category id, or a filter.');
    const raw = await ctx.ah.request<RestSearch>('/mobile-services/product/search/v2', {
      query: {
        query: options.query,
        taxonomyId: options.categoryId,
        page,
        size,
        sortOn: REST_SORT[sort],
      },
    });
    let products = (raw?.products ?? []).map(summarize);
    if (!options.includeSponsored) products = products.filter((p) => !p.sponsored);
    const result: SearchResult = {
      total: raw?.page?.totalElements ?? products.length,
      page: raw?.page?.number ?? page,
      products: products.slice(0, size),
    };
    if (options.query) result.query = options.query;
    if (raw?.page?.totalPages !== undefined) result.totalPages = raw.page.totalPages;
    return result;
  }
  const sortType =
    sort === 'price_low_high' ? 'PRICE_LOW_HIGH' : sort === 'price_high_low' ? 'PRICE_HIGH_LOW' : 'RELEVANCE';
  const data = await ctx.ah.graphql<GqlSearch>(GQL_SEARCH, {
    input: {
      query: options.query ?? '',
      sortType,
      searchInput: { facets, page: { number: page, size } },
    },
  });
  const ids = data.searchProducts.products.map((p) => p.id);
  const raw = await productsByIds(ctx, ids);
  const byId = new Map(raw.map((p) => [p.webshopId, p]));
  const products = ids
    .map((id) => byId.get(id))
    .filter((p): p is RawProduct => Boolean(p))
    .map(summarize);
  const result: SearchResult = {
    total: data.searchProducts.totalFound,
    page,
    totalPages: Math.ceil(data.searchProducts.totalFound / size),
    products,
  };
  if (options.query) result.query = options.query;
  const filters = data.searchProducts.facets?.facets
    ?.filter((f) =>
      [
        'product.brand.name',
        'product.properties.dieet',
        'product.properties.allergie',
        'product.properties.nutri-score',
      ].includes(f.label),
    )
    .map((f) => ({ name: f.label, options: (f.options ?? []).slice(0, 25).map((o) => o.value) }));
  if (filters?.length) result.filters = filters;
  return result;
}

export interface Nutrition {
  /** "100 g" or "100 ml". */
  per: string;
  energyKcal?: number;
  energyKj?: number;
  fat?: number;
  saturatedFat?: number;
  carbohydrates?: number;
  sugars?: number;
  fibre?: number;
  protein?: number;
  salt?: number;
  /** Everything else on the label, by its Dutch name. */
  other?: Record<string, string>;
}

export interface ProductDetail extends ProductSummary {
  gtin?: string;
  description?: string;
  ingredients?: string;
  allergens?: { contains: string[]; mayContain: string[] };
  nutrition?: Nutrition;
  /** Diet and intolerance labels Albert Heijn assigns, e.g. vegetarisch, geen lactose. */
  suitableFor?: string[];
  notSuitableFor?: string[];
  netContent?: string;
  storage?: string;
  preparation?: string;
  servingsPerPack?: number;
}

interface Measure {
  value?: number;
  measurementUnitCode?: { value?: string };
}

interface RawDetail {
  productId: number;
  productCard: RawProduct & { descriptionHighlights?: string; isFavorite?: boolean };
  properties?: Record<string, string[]>;
  tradeItem?: {
    gtin?: string;
    foodAndBeverageIngredientStatement?: string;
    allergenInformation?: {
      items?: { typeCode?: { label?: string }; levelOfContainmentCode?: { value?: string } }[];
    }[];
    nutritionalInformation?: {
      nutrientHeaders?: {
        nutrientBasisQuantity?: Measure;
        nutrientDetail?: {
          nutrientTypeCode?: { value?: string; label?: string };
          quantityContained?: Measure[];
        }[];
      }[];
    };
    measurements?: { netContent?: Measure[] };
    consumerInstructions?: { storageInstructions?: string[]; usageInstructions?: string[] };
    foodAndBeveragePreparationServing?: {
      preparationServing?: { preparationInstructions?: string[] }[];
      servingQuantityInformation?: { numberOfServingsPerPackage?: number };
    };
  };
}

const NUTRIENT_KEYS: Record<string, keyof Omit<Nutrition, 'per' | 'other' | 'energyKcal' | 'energyKj'>> = {
  FAT: 'fat',
  FASAT: 'saturatedFat',
  CHOAVL: 'carbohydrates',
  'SUGAR-': 'sugars',
  SUGAR: 'sugars',
  FIBTG: 'fibre',
  'PRO-': 'protein',
  PRO: 'protein',
  SALTEQ: 'salt',
};

export function parseNutrition(raw: RawDetail['tradeItem']): Nutrition | undefined {
  const header = raw?.nutritionalInformation?.nutrientHeaders?.[0];
  if (!header?.nutrientDetail?.length) return undefined;
  const basis = header.nutrientBasisQuantity;
  const nutrition: Nutrition = {
    per: `${basis?.value ?? 100} ${basis?.measurementUnitCode?.value ?? 'g'}`,
  };
  const other: Record<string, string> = {};
  for (const detail of header.nutrientDetail) {
    const code = detail.nutrientTypeCode?.value ?? '';
    for (const quantity of detail.quantityContained ?? []) {
      if (quantity.value === undefined) continue;
      const unit = quantity.measurementUnitCode?.value ?? '';
      if (code === 'ENER-' || code === 'ENER') {
        if (unit.toLowerCase() === 'kcal') nutrition.energyKcal = quantity.value;
        else if (unit.toLowerCase() === 'kj') nutrition.energyKj = quantity.value;
        continue;
      }
      const key = NUTRIENT_KEYS[code];
      if (key) nutrition[key] = quantity.value;
      else if (detail.nutrientTypeCode?.label)
        other[detail.nutrientTypeCode.label] = `${quantity.value} ${unit}`.trim();
    }
  }
  if (Object.keys(other).length) nutrition.other = other;
  return nutrition;
}

function labels(properties: Record<string, string[]> | undefined, prefix: string): string[] {
  if (!properties) return [];
  return Object.entries(properties)
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([, values]) => values)
    .map((v) => v.toLowerCase());
}

export async function productDetail(ctx: AppContext, id: number): Promise<ProductDetail> {
  const raw = await ctx.cache.get(`product:${id}`, HOUR, () =>
    ctx.ah.request<RawDetail>(`/mobile-services/product/detail/v4/fir/${id}`),
  );
  if (!raw?.productCard) throw new AhError('NOT_FOUND', `No product with id ${id}.`);
  // The detail card has no bonus price; take price and bonus from the products endpoint.
  const [live] = await productsByIds(ctx, [id]).catch(() => [] as RawProduct[]);
  const detail: ProductDetail = summarize({ ...raw.productCard, ...(live ?? {}) });
  const t = raw.tradeItem;
  if (t?.gtin) detail.gtin = t.gtin;
  const description = raw.productCard.descriptionHighlights
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (description) detail.description = description;
  if (t?.foodAndBeverageIngredientStatement) detail.ingredients = t.foodAndBeverageIngredientStatement;
  const allergenItems = t?.allergenInformation?.flatMap((a) => a.items ?? []) ?? [];
  if (allergenItems.length) {
    detail.allergens = {
      contains: allergenItems
        .filter((a) => a.levelOfContainmentCode?.value === 'CONTAINS')
        .map((a) => a.typeCode?.label ?? '?'),
      mayContain: allergenItems
        .filter((a) => a.levelOfContainmentCode?.value === 'MAY_CONTAIN')
        .map((a) => a.typeCode?.label ?? '?'),
    };
  }
  const nutrition = parseNutrition(t);
  if (nutrition) detail.nutrition = nutrition;
  const nutriscore = raw.properties?.nutriscore?.[0];
  if (nutriscore && !detail.nutriscore) detail.nutriscore = nutriscore;
  const suitable = [
    ...labels(raw.properties, 'sp_include_dieet'),
    ...labels(raw.properties, 'sp_include_intolerance'),
  ];
  const unsuitable = [
    ...labels(raw.properties, 'sp_exclude_dieet'),
    ...labels(raw.properties, 'sp_exclude_intolerance'),
  ];
  if (suitable.length) detail.suitableFor = suitable;
  if (unsuitable.length) detail.notSuitableFor = unsuitable;
  const net = t?.measurements?.netContent?.[0];
  if (net?.value !== undefined)
    detail.netContent = `${net.value} ${net.measurementUnitCode?.value ?? ''}`.trim();
  const storage = Array.isArray(t?.consumerInstructions?.storageInstructions)
    ? t.consumerInstructions.storageInstructions.join(' ')
    : undefined;
  if (storage) detail.storage = storage;
  const prep = t?.foodAndBeveragePreparationServing;
  const preparation = Array.isArray(prep?.preparationServing)
    ? prep.preparationServing.flatMap((p) => p.preparationInstructions ?? []).join(' ')
    : '';
  if (preparation) detail.preparation = preparation;
  const servings = prep?.servingQuantityInformation?.numberOfServingsPerPackage;
  if (typeof servings === 'number') detail.servingsPerPack = servings;
  return detail;
}

export async function productByBarcode(ctx: AppContext, barcode: string): Promise<ProductSummary> {
  const digits = barcode.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14)
    throw new AhError('INVALID_ARGUMENT', 'A barcode has 8 to 14 digits.');
  const raw = await ctx.ah.requestMaybe<RawProduct>(`/mobile-services/product/search/v1/gtin/${digits}`, {
    allow404: true,
  });
  if (!raw?.webshopId) throw new AhError('NOT_FOUND', `Albert Heijn has no product with barcode ${digits}.`);
  return summarize(raw);
}

export interface Category {
  id: number;
  name: string;
  ageCheck?: boolean;
}

interface RawCategory {
  id: number;
  name: string;
  nix18?: boolean;
}

export async function categories(
  ctx: AppContext,
  parentId?: number,
): Promise<{ parent?: Category; categories: Category[] }> {
  const shape = (c: RawCategory): Category =>
    c.nix18 ? { id: c.id, name: c.name, ageCheck: true } : { id: c.id, name: c.name };
  if (parentId === undefined) {
    const raw = await ctx.cache.get('categories', 6 * HOUR, () =>
      ctx.ah.request<RawCategory[]>('/mobile-services/v1/product-shelves/categories'),
    );
    return { categories: (raw ?? []).map(shape) };
  }
  const raw = await ctx.cache.get(`categories:${parentId}`, 6 * HOUR, () =>
    ctx.ah.request<{ parent?: RawCategory; children?: RawCategory[] }>(
      `/mobile-services/v1/product-shelves/categories/${parentId}/sub-categories`,
    ),
  );
  const result: { parent?: Category; categories: Category[] } = {
    categories: (raw?.children ?? []).map(shape),
  };
  if (raw?.parent) result.parent = shape(raw.parent);
  return result;
}
