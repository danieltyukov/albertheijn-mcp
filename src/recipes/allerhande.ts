import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { AH_WEB, productUrl } from '../ah/format.js';

const HOUR = 60 * 60_000;

export interface RecipeSummary {
  id: number;
  title: string;
  minutes?: number;
  flags?: string[];
  tags?: string[];
  nutriScore?: string;
  image?: string;
}

export interface RecipeSearchResult {
  total: number;
  hasMore: boolean;
  correctedSearch?: string;
  recipes: RecipeSummary[];
  /** Filter groups and values Albert Heijn offers for this search, usable in the next call. */
  filters?: { group: string; label: string; values: { value: string; label: string; count?: number }[] }[];
}

interface RawRecipeSearch {
  recipeSearchV2: {
    correctedSearchTerm?: string | null;
    page?: { total?: number; hasNextPage?: boolean };
    filters?: {
      label?: string;
      name?: string;
      filters?: { name?: string; label?: string; group?: string; count?: number }[];
    }[];
    result?: {
      id: number;
      title: string;
      time?: { cook?: number };
      images?: { url?: string }[];
      flags?: string[];
      nutriScore?: string | null;
      tags?: { key?: string; value?: string }[];
    }[];
  };
}

const SEARCH = `query FetchRecipes($searchText: String, $start: Int, $size: PageSize, $sortBy: RecipeSearchSortOption,
                   $filters: [RecipeSearchQueryFilter!], $recipeIds: [Int!]!, $ingredients: [String!]) {
  recipeSearchV2(searchText: $searchText, start: $start, size: $size, sortBy: $sortBy,
                 filters: $filters, recipeIds: $recipeIds, ingredients: $ingredients) {
    correctedSearchTerm
    page { total hasNextPage }
    filters { label name filters { name label group count } }
    result { id title time { cook } images(renditions: [D445X297]) { url } flags nutriScore tags { key value } }
  }
}`;

export interface RecipeQuery {
  search?: string;
  /** Ingredients the recipe should use, e.g. ["kip", "spinazie"]. */
  ingredients?: string[];
  /** Filters as group and values, e.g. { group: "speciale-wensen", values: ["vegetarisch"] }. */
  filters?: { group: string; values: string[] }[];
  start?: number;
  size?: number;
  includeFilters?: boolean;
}

export async function searchRecipes(ctx: AppContext, query: RecipeQuery): Promise<RecipeSearchResult> {
  const size = Math.min(Math.max(query.size ?? 10, 1), 36);
  const variables: Record<string, unknown> = {
    searchText: query.search ?? '',
    start: Math.max(query.start ?? 0, 0),
    size,
    sortBy: 'MOST_RELEVANT',
    recipeIds: [],
  };
  if (query.filters?.length) variables.filters = query.filters;
  if (query.ingredients?.length) variables.ingredients = query.ingredients;
  const data = await ctx.cache.get(`recipes:${JSON.stringify(variables)}`, HOUR, () =>
    ctx.ah.graphql<RawRecipeSearch>(SEARCH, variables),
  );
  const raw = data.recipeSearchV2;
  const result: RecipeSearchResult = {
    total: raw.page?.total ?? 0,
    hasMore: Boolean(raw.page?.hasNextPage),
    recipes: (raw.result ?? []).map((r) => {
      const recipe: RecipeSummary = { id: r.id, title: r.title };
      if (r.time?.cook) recipe.minutes = r.time.cook;
      if (r.flags?.length) recipe.flags = r.flags;
      const tags = (r.tags ?? []).map((t) => t.value).filter((v): v is string => Boolean(v));
      if (tags.length) recipe.tags = tags;
      if (r.nutriScore) recipe.nutriScore = r.nutriScore;
      if (r.images?.[0]?.url) recipe.image = r.images[0].url;
      return recipe;
    }),
  };
  if (raw.correctedSearchTerm) result.correctedSearch = raw.correctedSearchTerm;
  if (query.includeFilters) {
    result.filters = (raw.filters ?? []).map((group) => ({
      group: group.name ?? '',
      label: group.label ?? '',
      values: (group.filters ?? []).slice(0, 30).map((f) => {
        const value: { value: string; label: string; count?: number } = {
          value: f.name ?? '',
          label: f.label ?? '',
        };
        if (f.count !== undefined) value.count = f.count;
        return value;
      }),
    }));
  }
  return result;
}

interface RawRecipe {
  id: number;
  title: string;
  description?: string;
  href?: string;
  cookTime?: number;
  ovenTime?: number;
  waitTime?: number;
  servings?: { number?: number; type?: string; isChangeable?: boolean };
  ingredients?: {
    id?: number;
    text?: string;
    quantity?: number;
    quantityUnit?: { singular?: string; plural?: string };
    name?: { singular?: string; plural?: string | null };
    servingsScale?: number;
  }[];
  preparation?: { steps?: string[] };
  nutritions?: Record<string, { value?: number; unit?: string } | null>;
  tags?: { key?: string; value?: string }[];
  images?: { url?: string }[];
}

interface RawSuggestion {
  optional?: boolean;
  ingredient?: {
    id?: number;
    name?: string;
    quantityFloat?: number;
    quantityUnit?: string;
    completeText?: string;
  };
  productSuggestion?: {
    quantity?: number;
    product?: {
      id: number;
      title: string;
      salesUnitSize?: string;
      priceV2?: { now?: { amount?: number }; was?: { amount?: number } };
    };
  } | null;
  alternativeSections?: {
    title?: string;
    productSuggestions?: { quantity?: number; product?: { id: number; title: string } }[];
  }[];
}

export interface RecipeIngredient {
  text: string;
  quantity?: number;
  unit?: string;
  name: string;
  optional?: boolean;
  /** The product Albert Heijn suggests for this ingredient at the recipe's own servings. */
  product?: { id: number; title: string; unitSize?: string; price?: number; quantity: number; url: string };
  alternatives?: { id: number; title: string }[];
}

export interface Recipe {
  id: number;
  title: string;
  url?: string;
  description?: string;
  servings: number;
  /** Servings the ingredient quantities below are for. Differs from servings when scaled. */
  scaledTo: number;
  minutes?: { cooking?: number; oven?: number; waiting?: number };
  ingredients: RecipeIngredient[];
  steps: string[];
  nutritionPerServing?: Record<string, string>;
  tags?: string[];
  image?: string;
  source: 'allerhande';
}

const RECIPE = `query Recipe($id: Int!) { recipe(id: $id) {
  id title description href cookTime ovenTime waitTime
  servings { number type isChangeable }
  ingredients { id text quantity quantityUnit { singular plural } name { singular plural } servingsScale }
  preparation { steps }
  nutritions { energy { value unit } protein { value unit } fat { value unit } carbohydrates { value unit } }
  tags { key value }
  images(renditions: [D445X297]) { url }
} }`;

const SUGGESTIONS = `query Suggestions($id: Int!) { recipeProductSuggestionsV2(options: { recipeId: $id }) {
  optional
  ingredient { id name quantityFloat quantityUnit completeText }
  productSuggestion { quantity product { id title salesUnitSize priceV2 { now { amount } was { amount } } } }
  alternativeSections { title productSuggestions { quantity product { id title } } }
} }`;

function round(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}

/** An Allerhande recipe with its ingredients, optionally scaled, and Albert Heijn's product per ingredient. */
export async function getRecipe(
  ctx: AppContext,
  id: number,
  servings?: number,
  withProducts = true,
): Promise<Recipe> {
  let data: { recipe: RawRecipe | null };
  try {
    data = await ctx.cache.get(`recipe:${id}`, 6 * HOUR, () =>
      ctx.ah.graphql<{ recipe: RawRecipe | null }>(RECIPE, { id }),
    );
  } catch (error) {
    // Some recipes lack optional nutrition blocks; retry with energy only.
    if (!(error instanceof AhError) || error.code !== 'UNAVAILABLE') throw error;
    data = await ctx.ah.graphql<{ recipe: RawRecipe | null }>(
      RECIPE.replace(/protein \{ value unit \} fat \{ value unit \} carbohydrates \{ value unit \} /, ''),
      { id },
    );
  }
  const raw = data.recipe;
  if (!raw) throw new AhError('NOT_FOUND', `No Allerhande recipe with id ${id}.`);
  const base = raw.servings?.number && raw.servings.number > 0 ? raw.servings.number : 4;
  const target = servings && servings > 0 ? servings : base;
  const factor = target / base;
  let suggestions: RawSuggestion[] = [];
  if (withProducts) {
    suggestions = await ctx.cache
      .get(`recipe-products:${id}`, 6 * HOUR, () =>
        ctx.ah
          .graphql<{ recipeProductSuggestionsV2: RawSuggestion[] | null }>(SUGGESTIONS, { id })
          .then((d) => d.recipeProductSuggestionsV2 ?? []),
      )
      .catch(() => []);
  }
  const byIngredient = new Map<number, RawSuggestion>();
  for (const s of suggestions) if (s.ingredient?.id !== undefined) byIngredient.set(s.ingredient.id, s);
  const ingredients: RecipeIngredient[] = (raw.ingredients ?? []).map((ing) => {
    const qty = ing.quantity && ing.quantity > 0 ? ing.quantity * factor : undefined;
    const unit = qty !== undefined && qty > 1 ? ing.quantityUnit?.plural : ing.quantityUnit?.singular;
    const name =
      (qty !== undefined && qty > 1 ? ing.name?.plural : undefined) ?? ing.name?.singular ?? ing.text ?? '';
    const text = qty !== undefined ? [round(qty), unit, name].filter(Boolean).join(' ') : (ing.text ?? name);
    const item: RecipeIngredient = { text, name };
    if (qty !== undefined) item.quantity = round(qty);
    if (unit) item.unit = unit;
    const s = ing.id !== undefined ? byIngredient.get(ing.id) : undefined;
    if (s?.optional) item.optional = true;
    const p = s?.productSuggestion?.product;
    if (p) {
      const product: NonNullable<RecipeIngredient['product']> = {
        id: p.id,
        title: p.title,
        quantity: s?.productSuggestion?.quantity ?? 1,
        url: productUrl(p.id),
      };
      if (p.salesUnitSize) product.unitSize = p.salesUnitSize;
      const price = p.priceV2?.now?.amount;
      if (price !== undefined) product.price = price;
      item.product = product;
    }
    const alternatives = (s?.alternativeSections ?? [])
      .flatMap((a) => a.productSuggestions ?? [])
      .map((a) => a.product)
      .filter((a): a is { id: number; title: string } => Boolean(a))
      .slice(0, 3);
    if (alternatives.length) item.alternatives = alternatives;
    return item;
  });
  const recipe: Recipe = {
    id: raw.id,
    title: raw.title,
    servings: base,
    scaledTo: target,
    ingredients,
    steps: (raw.preparation?.steps ?? []).map((s) => s.trim()).filter(Boolean),
    source: 'allerhande',
  };
  if (raw.href) recipe.url = `${AH_WEB}${raw.href}`;
  if (raw.description) recipe.description = raw.description;
  const minutes: NonNullable<Recipe['minutes']> = {};
  if (raw.cookTime) minutes.cooking = raw.cookTime;
  if (raw.ovenTime) minutes.oven = raw.ovenTime;
  if (raw.waitTime) minutes.waiting = raw.waitTime;
  if (Object.keys(minutes).length) recipe.minutes = minutes;
  const nutrition: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.nutritions ?? {})) {
    if (value?.value !== undefined) nutrition[key] = `${value.value} ${value.unit ?? ''}`.trim();
  }
  if (Object.keys(nutrition).length) recipe.nutritionPerServing = nutrition;
  const tags = (raw.tags ?? []).map((t) => t.value).filter((v): v is string => Boolean(v));
  if (tags.length) recipe.tags = tags;
  if (raw.images?.[0]?.url) recipe.image = raw.images[0].url;
  return recipe;
}
