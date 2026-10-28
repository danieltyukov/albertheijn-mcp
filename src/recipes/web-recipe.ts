import { decodeEntities, jsonLdBlocks, pageTitle, stripTags } from '../web/html.js';

export interface WebRecipe {
  name: string;
  url: string;
  description?: string;
  /** Servings as stated by the site, parsed from recipeYield when possible. */
  servings?: number;
  yieldText?: string;
  ingredients: string[];
  instructions: string[];
  totalMinutes?: number;
  prepMinutes?: number;
  cookMinutes?: number;
  category?: string[];
  cuisine?: string[];
  keywords?: string[];
  nutrition?: Record<string, string>;
  image?: string;
  author?: string;
}

type Json = Record<string, unknown>;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

const text = (value: unknown): string | undefined => {
  if (typeof value === 'string') return stripTags(decodeEntities(value)) || undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
};

function isType(node: Json, type: string): boolean {
  return asArray(node['@type']).some((t) => typeof t === 'string' && t.toLowerCase() === type.toLowerCase());
}

/** Depth-first search for the first object of a schema.org type. */
function findNode(value: unknown, type: string, depth = 0): Json | undefined {
  if (depth > 8 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNode(item, type, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const node = value as Json;
  if (isType(node, type)) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const found = findNode(node[key], type, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** ISO 8601 duration (PT1H30M, P0DT45M) to minutes. */
export function isoMinutes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const [, d, h, m, s] = match;
  const minutes = Number(d ?? 0) * 1440 + Number(h ?? 0) * 60 + Number(m ?? 0) + Number(s ?? 0) / 60;
  return minutes > 0 ? Math.round(minutes) : undefined;
}

function instructions(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5) return out;
  for (const item of asArray(value)) {
    if (typeof item === 'string') {
      for (const line of stripTags(decodeEntities(item)).split(/\n+/)) if (line.trim()) out.push(line.trim());
    } else if (item && typeof item === 'object') {
      const node = item as Json;
      if (isType(node, 'HowToSection')) {
        const name = text(node.name);
        if (name) out.push(`${name}:`);
        instructions(node.itemListElement, out, depth + 1);
      } else {
        const step = text(node.text) ?? text(node.name);
        if (step) out.push(step);
      }
    }
  }
  return out;
}

export function parseServings(value: unknown): { servings?: number; yieldText?: string } {
  const values = asArray(value);
  for (const item of values) {
    if (typeof item === 'number' && item > 0) return { servings: item, yieldText: String(item) };
  }
  const yieldText = values.map((item) => text(item)).find(Boolean);
  if (!yieldText) return {};
  const match = /(\d+(?:[.,]\d+)?)/.exec(yieldText);
  const servings = match?.[1] ? Number(match[1].replace(',', '.')) : undefined;
  return servings && servings > 0 && servings < 200 ? { servings, yieldText } : { yieldText };
}

function names(value: unknown): string[] | undefined {
  const list = asArray(value)
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
    .map((item) => decodeEntities(item).trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function nutrition(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Json)) {
    if (key.startsWith('@')) continue;
    const v = text(raw);
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function image(value: unknown): string | undefined {
  for (const item of asArray(value)) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && typeof (item as Json).url === 'string')
      return (item as Json).url as string;
  }
  return undefined;
}

function author(value: unknown): string | undefined {
  const list = asArray(value)
    .map((item) =>
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? text((item as Json).name)
          : undefined,
    )
    .filter((item): item is string => Boolean(item));
  return list.length ? list.join(', ') : undefined;
}

/** Extract a schema.org Recipe from a page. Returns undefined when the page has none. */
export function extractRecipe(html: string, url: string): WebRecipe | undefined {
  const node = findNode(jsonLdBlocks(html), 'Recipe');
  if (!node) return undefined;
  const ingredients = asArray(node.recipeIngredient ?? node.ingredients)
    .map((item) => text(item))
    .filter((item): item is string => Boolean(item));
  const recipe: WebRecipe = {
    name: text(node.name) ?? pageTitle(html) ?? 'Recipe',
    url,
    ingredients,
    instructions: instructions(node.recipeInstructions),
    ...parseServings(node.recipeYield),
  };
  const description = text(node.description);
  if (description) recipe.description = description.slice(0, 600);
  const total = isoMinutes(node.totalTime);
  const prep = isoMinutes(node.prepTime);
  const cook = isoMinutes(node.cookTime);
  if (total) recipe.totalMinutes = total;
  else if (prep || cook) recipe.totalMinutes = (prep ?? 0) + (cook ?? 0);
  if (prep) recipe.prepMinutes = prep;
  if (cook) recipe.cookMinutes = cook;
  const category = names(node.recipeCategory);
  const cuisine = names(node.recipeCuisine);
  const keywords = names(node.keywords);
  if (category) recipe.category = category;
  if (cuisine) recipe.cuisine = cuisine;
  if (keywords) recipe.keywords = keywords.slice(0, 20);
  const facts = nutrition(node.nutrition);
  if (facts) recipe.nutrition = facts;
  const picture = image(node.image);
  if (picture) recipe.image = picture;
  const by = author(node.author);
  if (by) recipe.author = by;
  return recipe;
}
