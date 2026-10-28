import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { priceItems } from '../ah/bonus.js';
import { productUrl, round2 } from '../ah/format.js';
import { productsByIds, summarize, type ProductSummary } from '../ah/products.js';
import { getRecipe } from '../recipes/allerhande.js';
import { importRecipe } from '../recipes/import.js';
import { mapLimit } from '../util/pool.js';
import { choose, findCandidates, tokens, type Candidate, type Preference } from './match.js';
import { convert, formatAmount, parseIngredient, parseUnitSize, type Amount } from './quantity.js';

export interface PlanRecipeInput {
  allerhandeId?: number;
  url?: string;
  title?: string;
  /** Plain ingredient lines, e.g. "500 g kipfilet". */
  ingredients?: string[];
  /** Servings the given ingredient lines are written for. Defaults to the recipe's own servings, or to makeServings. */
  servings?: number;
  /** Servings to cook. */
  makeServings: number;
}

export interface PlanOptions {
  preference?: Preference;
  skipPantry?: boolean;
  /** Ingredient name to Albert Heijn search term, for English recipes or to steer a match. */
  searchTerms?: Record<string, string>;
  /** Ingredient names you already have. */
  exclude?: string[];
}

interface Need {
  key: string;
  name: string;
  amount?: Amount;
  from: string[];
  /** Albert Heijn's own product suggestion, from Allerhande. */
  suggestion?: { productId: number; quantity: number; scale: number };
  estimated: boolean;
}

export interface PlanLine {
  ingredient: string;
  needed?: string;
  usedIn: string[];
  product?: {
    id: number;
    title: string;
    unitSize?: string;
    price: number | null;
    deal?: string;
    url: string;
  };
  packs: number;
  lineCost?: number;
  leftover?: string;
  /** Pack count rests on a typical weight or a guess; check it. */
  estimated?: boolean;
  alternatives?: { id: number; title: string; unitSize?: string; price: number | null; deal?: string }[];
}

export interface MealPlan {
  recipes: { title: string; servings: number; source: string; url?: string }[];
  lines: PlanLine[];
  pantrySkipped: string[];
  excluded: string[];
  unmatched: string[];
  /** Ingredients whose product search failed (network or Albert Heijn errors); retry the plan. */
  lookupFailed: string[];
  totals: { beforeDiscount: number; discount: number; total: number; servings: number; perServing: number };
  /** Ready for prepare_basket_change or update_shopping_list. */
  basketItems: { productId: number; quantity: number }[];
  notes: string[];
}

function keyOf(name: string): string {
  return tokens(name)
    .map((t) => t.replace(/(en|s|'s)$/, ''))
    .sort()
    .join(' ');
}

function addAmount(need: Need, amount: Amount | undefined): void {
  if (!amount) return;
  if (!need.amount) {
    need.amount = { ...amount };
    return;
  }
  const converted = convert(amount, need.amount.dimension, need.name);
  if (converted) {
    need.amount.value += converted.value;
    if (converted.estimated) need.estimated = true;
  } else {
    need.estimated = true;
  }
}

function packsFor(
  need: Need,
  product: ProductSummary,
): { packs: number; leftover?: string; estimated: boolean } {
  const size = parseUnitSize(product.unitSize);
  // Albert Heijn's own pack count is only meaningful for the product it suggested.
  const suggested =
    need.suggestion && need.suggestion.productId === product.id
      ? Math.max(1, Math.round(need.suggestion.quantity * need.suggestion.scale))
      : undefined;
  if (!need.amount || !size)
    return { packs: suggested ?? 1, estimated: suggested === undefined || !need.amount };
  const converted = convert(need.amount, size.dimension, need.name);
  if (!converted) return { packs: suggested ?? 1, estimated: true };
  // Allow 3% slack so 505 g against a 500 g pack does not buy two.
  const packs = Math.max(1, Math.ceil(converted.value / size.value - 0.03));
  const rest = packs * size.value - converted.value;
  const result: { packs: number; leftover?: string; estimated: boolean } = {
    packs,
    estimated: converted.estimated || need.estimated,
  };
  if (rest > size.value * 0.05) result.leftover = formatAmount({ value: rest, dimension: size.dimension });
  return result;
}

/** Search once more after a failure; undefined means both attempts failed. */
async function searchWithRetry(
  ctx: AppContext,
  name: string,
  term?: string,
): Promise<Candidate[] | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await findCandidates(ctx, name, term);
    } catch {
      /* try again */
    }
  }
  return undefined;
}

const shortProduct = (p: ProductSummary) => {
  const out: NonNullable<PlanLine['alternatives']>[number] = { id: p.id, title: p.title, price: p.price };
  if (p.unitSize) out.unitSize = p.unitSize;
  if (p.bonus?.mechanism) out.deal = p.bonus.mechanism;
  return out;
};

/**
 * Turn recipes into one priced shopping plan: scale, merge the same ingredient across
 * recipes, match each to an Albert Heijn product, and work out packs and leftovers.
 */
export async function planMealPrep(
  ctx: AppContext,
  recipes: PlanRecipeInput[],
  options: PlanOptions = {},
): Promise<MealPlan> {
  if (!recipes.length) throw new AhError('INVALID_ARGUMENT', 'Give at least one recipe.');
  if (recipes.length > 12) throw new AhError('INVALID_ARGUMENT', 'Plan at most 12 recipes at once.');
  const preference = options.preference ?? 'best_match';
  const searchTerms = new Map(Object.entries(options.searchTerms ?? {}).map(([k, v]) => [keyOf(k), v]));
  const exclude = new Set((options.exclude ?? []).map(keyOf));
  const needs = new Map<string, Need>();
  const pantrySkipped = new Set<string>();
  const excluded = new Set<string>();
  const notes: string[] = [];
  const planned: MealPlan['recipes'] = [];

  const take = (
    line: string,
    recipeTitle: string,
    factor: number,
    suggestion?: Need['suggestion'],
    optional?: boolean,
  ) => {
    const parsed = parseIngredient(line);
    if (!parsed.name) return;
    const key = keyOf(parsed.name) || parsed.name.toLowerCase();
    if (exclude.has(key)) {
      excluded.add(parsed.name);
      return;
    }
    if ((options.skipPantry ?? true) && (parsed.pantry || optional)) {
      pantrySkipped.add(parsed.name);
      return;
    }
    const need = needs.get(key) ?? { key, name: parsed.name, from: [], estimated: false };
    if (!need.from.includes(recipeTitle)) need.from.push(recipeTitle);
    addAmount(
      need,
      parsed.amount ? { value: parsed.amount.value * factor, dimension: parsed.amount.dimension } : undefined,
    );
    if (suggestion && !need.suggestion) need.suggestion = suggestion;
    needs.set(key, need);
  };

  for (const input of recipes) {
    const make = input.makeServings;
    if (!(make > 0) || make > 100)
      throw new AhError('INVALID_ARGUMENT', 'makeServings must be between 1 and 100.');
    if (input.allerhandeId) {
      const recipe = await getRecipe(ctx, input.allerhandeId, make, true);
      planned.push({
        title: recipe.title,
        servings: make,
        source: 'allerhande',
        ...(recipe.url ? { url: recipe.url } : {}),
      });
      const scale = make / recipe.servings;
      for (const ing of recipe.ingredients) {
        const line =
          ing.quantity !== undefined
            ? [ing.quantity, ing.unit, ing.name].filter(Boolean).join(' ')
            : ing.name;
        const suggestion = ing.product
          ? { productId: ing.product.id, quantity: ing.product.quantity, scale }
          : undefined;
        // getRecipe already scaled the quantities.
        take(line, recipe.title, 1, suggestion, ing.optional);
      }
    } else if (input.url) {
      const recipe = await importRecipe(ctx, input.url);
      const base = input.servings ?? recipe.servings;
      if (!base) notes.push(`"${recipe.name}" does not state its servings; assumed 4.`);
      const factor = make / (base ?? 4);
      planned.push({ title: input.title ?? recipe.name, servings: make, source: 'web', url: recipe.url });
      for (const line of recipe.ingredients) take(line, input.title ?? recipe.name, factor);
    } else if (input.ingredients?.length) {
      const title = input.title ?? 'Custom recipe';
      const factor = make / (input.servings ?? make);
      planned.push({ title, servings: make, source: 'list' });
      for (const line of input.ingredients) take(line, title, factor);
    } else {
      throw new AhError('INVALID_ARGUMENT', 'Each recipe needs an allerhandeId, a url, or ingredient lines.');
    }
  }

  const list = [...needs.values()];
  const suggested = await productsByIds(
    ctx,
    list.map((n) => n.suggestion?.productId).filter((id): id is number => id !== undefined),
  ).catch(() => []);
  const suggestedById = new Map(suggested.map((p) => [p.webshopId, summarize(p)]));

  const unmatched: string[] = [];
  const lookupFailed: string[] = [];
  const lines: PlanLine[] = await mapLimit(list, 4, async (need) => {
    const suggestion = need.suggestion ? suggestedById.get(need.suggestion.productId) : undefined;
    const term = searchTerms.get(need.key);
    let ranked: Candidate[];
    if (suggestion?.orderable && preference === 'best_match' && !term) {
      ranked = [{ product: suggestion, match: 1, score: 99 }];
    } else {
      const found = await searchWithRetry(ctx, need.name, term);
      if (!found) lookupFailed.push(need.name);
      ranked = found ?? [];
      if (suggestion?.orderable && !ranked.some((c) => c.product.id === suggestion.id)) {
        ranked.unshift({ product: suggestion, match: Math.max(1, ranked[0]?.match ?? 1), score: 99 });
      }
      ranked = choose(ranked, preference, (product) => {
        const packs = packsFor(need, product);
        return { total: (product.price ?? 99) * packs.packs, estimated: packs.estimated };
      });
    }
    const chosen = ranked[0]?.product;
    const line: PlanLine = { ingredient: need.name, usedIn: need.from, packs: 0 };
    if (need.amount) line.needed = formatAmount(need.amount);
    if (!chosen) return line;
    const packs = packsFor(need, chosen);
    line.product = { id: chosen.id, title: chosen.title, price: chosen.price, url: productUrl(chosen.id) };
    if (chosen.unitSize) line.product.unitSize = chosen.unitSize;
    if (chosen.bonus?.mechanism) line.product.deal = chosen.bonus.mechanism;
    line.packs = packs.packs;
    if (chosen.price !== null) line.lineCost = round2(chosen.price * packs.packs);
    if (packs.leftover) line.leftover = packs.leftover;
    if (packs.estimated) line.estimated = true;
    const alternatives = ranked.slice(1, 3).map((c) => c.product);
    if (alternatives.length) line.alternatives = alternatives.map(shortProduct);
    return line;
  });
  for (const line of lines)
    if (!line.product && !lookupFailed.includes(line.ingredient)) unmatched.push(line.ingredient);

  const basket = new Map<number, number>();
  for (const line of lines)
    if (line.product && line.packs > 0)
      basket.set(line.product.id, (basket.get(line.product.id) ?? 0) + line.packs);
  const basketItems = [...basket].map(([productId, quantity]) => ({ productId, quantity }));
  let totals: { beforeDiscount: number; discount: number; total: number };
  try {
    totals = await priceItems(ctx, basketItems);
  } catch {
    const sum = round2(lines.reduce((s, l) => s + (l.lineCost ?? 0), 0));
    totals = { beforeDiscount: sum, discount: 0, total: sum };
    notes.push('Bonus discounts could not be calculated; the total uses regular prices.');
  }
  const servings = planned.reduce((s, r) => s + r.servings, 0);
  if (lines.some((l) => l.estimated))
    notes.push('Lines marked estimated rest on typical weights or a guessed pack count. Check them.');
  if (unmatched.length)
    notes.push('Unmatched ingredients need a Dutch search term (searchTerms) or a manual product choice.');
  if (lookupFailed.length) notes.push('Some product searches failed; run the plan again to fill them in.');
  return {
    recipes: planned,
    lines,
    pantrySkipped: [...pantrySkipped],
    excluded: [...excluded],
    unmatched,
    lookupFailed,
    totals: { ...totals, servings, perServing: servings ? round2(totals.total / servings) : 0 },
    basketItems,
    notes,
  };
}

/** Match loose ingredient lines to products without building a full plan. */
export async function matchIngredients(
  ctx: AppContext,
  lines: string[],
  preference: Preference = 'best_match',
) {
  if (lines.length > 40) throw new AhError('INVALID_ARGUMENT', 'Match at most 40 lines at once.');
  const results = await mapLimit(lines, 4, async (line) => {
    const parsed = parseIngredient(line);
    const need: Need = { key: keyOf(parsed.name), name: parsed.name, from: [], estimated: false };
    if (parsed.amount) need.amount = parsed.amount;
    const found = await searchWithRetry(ctx, parsed.name);
    const ranked = choose(found ?? [], preference, (product) => {
      const packs = packsFor(need, product);
      return { total: (product.price ?? 99) * packs.packs, estimated: packs.estimated };
    });
    const best = ranked[0]?.product;
    return {
      line,
      ingredient: parsed.name,
      ...(parsed.amount ? { needed: formatAmount(parsed.amount) } : {}),
      ...(best ? { product: shortProduct(best), packs: packsFor(need, best).packs } : { product: null }),
      ...(found ? {} : { lookupFailed: true }),
      alternatives: ranked.slice(1, 3).map((c) => shortProduct(c.product)),
    };
  });
  return { results };
}
