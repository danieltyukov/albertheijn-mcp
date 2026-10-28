import type { AppContext } from '../context.js';
import { searchProducts, type ProductSummary } from '../ah/products.js';
import { parseUnitSize } from './quantity.js';

export type Preference = 'best_match' | 'cheapest' | 'bonus';

const STOP = new Set([
  'de',
  'het',
  'een',
  'en',
  'of',
  'met',
  'van',
  'voor',
  'in',
  'op',
  'the',
  'a',
  'an',
  'and',
  'or',
  'with',
  'for',
  'vers',
  'verse',
  'fresh',
  'gesneden',
  'fijngesneden',
  'gehakt',
  'chopped',
  'sliced',
  'diced',
  'grof',
  'fijn',
  'klein',
  'groot',
  'large',
  'small',
  'medium',
  'ah',
  'biologisch',
  'organic',
  'blik',
  'pot',
]);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Rough Dutch singular/plural folding so "uien" matches "ui" and "tomaten" matches "tomaat". */
function stem(token: string): string {
  return token
    .replace(/(en|s|'s)$/, '')
    .replace(/aa/g, 'a')
    .replace(/ee/g, 'e')
    .replace(/oo/g, 'o')
    .replace(/(.)\1$/, '$1');
}

const similar = (a: string, b: string): boolean =>
  a === b || (a.includes(b) && b.length > 3) || (b.includes(a) && a.length > 3);

/**
 * How well a product title fits an ingredient, 0 to 1. Mostly the share of ingredient
 * words found in the title, partly the share of title words that belong to the
 * ingredient, so "AH Citroen" beats "Amstel Radler citroen 12-pack" for "citroen".
 */
export function nameScore(ingredient: string, title: string): number {
  const want = tokens(ingredient).map(stem);
  const have = tokens(title)
    .filter((t) => !/^\d/.test(t) && t !== 'pack' && t !== 'stuks')
    .map(stem);
  if (!want.length || !have.length) return 0;
  const recall = want.filter((w) => have.some((h) => similar(w, h))).length / want.length;
  if (recall === 0) return 0;
  const precision = have.filter((h) => want.some((w) => similar(w, h))).length / have.length;
  return 0.75 * recall + 0.25 * precision;
}

export interface Candidate {
  product: ProductSummary;
  /** Name fit, 0 to 1. */
  match: number;
  /** Overall relevance used for best_match ordering. */
  score: number;
}

/** A real price cut on a single item, not an online volume discount on a multipack. */
export function onRealBonus(product: ProductSummary): boolean {
  if (!product.bonus || product.bundle) return false;
  const deal = (product.bonus.mechanism ?? '').toLowerCase();
  return !deal.includes('volume voordeel') && !deal.includes('pakketkorting');
}

/** Rank search results by relevance to an ingredient, best first. */
export function rank(ingredient: string, products: ProductSummary[]): Candidate[] {
  return products
    .filter((p) => p.orderable && p.price !== null)
    .map((p, index) => {
      const match = nameScore(ingredient, p.title);
      // Search order is Albert Heijn's own relevance; keep a little of it.
      let score = match * 10 + Math.max(0, 3 - index * 0.25);
      if (onRealBonus(p)) score += 0.5;
      if (p.sponsored) score -= 2;
      // Online multipacks are bought for stock, not for a recipe.
      if (p.bundle) score -= 6;
      // A product with a known size makes the pack maths exact.
      if (parseUnitSize(p.unitSize)) score += 1;
      return { product: p, match, score };
    })
    .filter((c) => c.match > 0)
    .sort((a, b) => b.score - a.score);
}

/** Search Albert Heijn for an ingredient and rank the results by relevance. */
export async function findCandidates(
  ctx: AppContext,
  ingredient: string,
  search?: string,
): Promise<Candidate[]> {
  const query = (search ?? ingredient).trim();
  if (!query) return [];
  const result = await ctx.cache.get(`match:${query.toLowerCase()}`, 30 * 60_000, () =>
    searchProducts(ctx, { query, size: 24 }),
  );
  return rank(search ?? ingredient, result.products);
}

/**
 * Pick a candidate for a preference. `cost` gives what covering the need with that
 * product would cost (packs times price), so cheapest compares like with like.
 */
export function choose(
  candidates: Candidate[],
  preference: Preference,
  cost: (product: ProductSummary) => { total: number; estimated: boolean },
): Candidate[] {
  if (!candidates.length) return [];
  const top = candidates[0]!.match;
  let pool = candidates.filter((c) => c.match >= top - 0.1);
  const singles = pool.filter((c) => !c.product.bundle);
  if (singles.length) pool = singles;
  if (preference === 'best_match') return [...pool, ...candidates.filter((c) => !pool.includes(c))];
  const priced = pool.map((c) => ({ c, ...cost(c.product) }));
  const byCost = (a: (typeof priced)[number], b: (typeof priced)[number]) =>
    Number(a.estimated) - Number(b.estimated) || a.total - b.total || b.c.score - a.c.score;
  if (preference === 'bonus') {
    const onBonus = priced.filter((p) => onRealBonus(p.c.product)).sort(byCost);
    if (onBonus.length) {
      const rest = candidates.filter((c) => !onBonus.some((b) => b.c === c));
      return [...onBonus.map((p) => p.c), ...rest];
    }
    return candidates;
  }
  const sorted = priced.sort(byCost).map((p) => p.c);
  return [...sorted, ...candidates.filter((c) => !sorted.includes(c))];
}
