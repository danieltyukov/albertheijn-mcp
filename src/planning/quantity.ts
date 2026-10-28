/**
 * Parsing of ingredient lines ("2 el olijfolie", "500 g kipfilet", "1 1/2 cups rice")
 * and product unit sizes ("500 g", "6 stuks", "ca. 1 kg") into comparable amounts.
 */

export type Dimension = 'mass' | 'volume' | 'count';

export interface Amount {
  /** Grams for mass, millilitres for volume, pieces for count. */
  value: number;
  dimension: Dimension;
}

export interface ParsedIngredient {
  raw: string;
  /** The quantity as written, after fractions and ranges are resolved. */
  quantity?: number;
  /** The unit as written, lower-cased. */
  unit?: string;
  amount?: Amount;
  /** The ingredient itself, without quantity, unit or preparation notes. */
  name: string;
  note?: string;
  /** Salt, pepper, oil and other things most kitchens already have. */
  pantry: boolean;
}

interface UnitDef {
  dimension: Dimension;
  factor: number;
}

const UNITS: Record<string, UnitDef> = {};
function unit(names: string[], dimension: Dimension, factor: number): void {
  for (const name of names) UNITS[name] = { dimension, factor };
}

unit(['mg', 'milligram', 'milligrams'], 'mass', 0.001);
unit(['g', 'gr', 'gram', 'grams', 'gramm', 'grammes'], 'mass', 1);
unit(['kg', 'kilo', 'kilogram', 'kilograms', 'kilos'], 'mass', 1000);
unit(['ons'], 'mass', 100);
unit(['pond'], 'mass', 500);
unit(['oz', 'ounce', 'ounces'], 'mass', 28.35);
unit(['lb', 'lbs', 'pound', 'pounds'], 'mass', 453.6);
unit(['ml', 'milliliter', 'millilitre', 'milliliters', 'millilitres'], 'volume', 1);
unit(['cl', 'centiliter', 'centilitre'], 'volume', 10);
unit(['dl', 'deciliter', 'decilitre'], 'volume', 100);
unit(['l', 'lt', 'liter', 'litre', 'liters', 'litres'], 'volume', 1000);
unit(['el', 'eetlepel', 'eetlepels', 'tbsp', 'tbs', 'tablespoon', 'tablespoons'], 'volume', 15);
unit(['tl', 'theelepel', 'theelepels', 'tsp', 'teaspoon', 'teaspoons'], 'volume', 5);
unit(['cup', 'cups'], 'volume', 240);
unit(['kopje', 'kopjes'], 'volume', 150);
unit(['fl oz', 'floz'], 'volume', 29.6);
unit(['snufje', 'snufjes', 'pinch', 'pinches', 'mespunt', 'mespuntje'], 'volume', 0.5);
unit(['scheutje', 'scheut', 'dash', 'splash'], 'volume', 10);
unit(
  [
    'stuk',
    'stuks',
    'st',
    'piece',
    'pieces',
    'pc',
    'pcs',
    'teen',
    'tenen',
    'teentje',
    'teentjes',
    'clove',
    'cloves',
    'blik',
    'blikken',
    'blikje',
    'can',
    'cans',
    'tin',
    'tins',
    'pak',
    'pakken',
    'pakje',
    'pack',
    'packs',
    'zak',
    'zakje',
    'zakjes',
    'bag',
    'bos',
    'bosje',
    'bunch',
    'bunches',
    'handvol',
    'handful',
    'handfuls',
    'plak',
    'plakken',
    'plakje',
    'plakjes',
    'slice',
    'slices',
    'takje',
    'takjes',
    'sprig',
    'sprigs',
    'blaadje',
    'blaadjes',
    'leaf',
    'leaves',
    'potje',
    'pot',
    'jar',
    'fles',
    'bottle',
    'krop',
    'head',
    'bol',
    'bollen',
    'stengel',
    'stengels',
    'stalk',
    'stalks',
    'filet',
    'filets',
    'fillet',
    'fillets',
    'portie',
    'porties',
    'serving',
    'servings',
    'x',
  ],
  'count',
  1,
);

const MULTI_WORD_UNITS = ['fl oz'];

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 0.5,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 0.25,
  '¾': 0.75,
  '⅕': 0.2,
  '⅛': 0.125,
  '⅜': 0.375,
  '⅝': 0.625,
  '⅞': 0.875,
};

const NUMBER_WORDS: Record<string, number> = {
  een: 1,
  één: 1,
  a: 1,
  an: 1,
  one: 1,
  twee: 2,
  two: 2,
  drie: 3,
  three: 3,
  vier: 4,
  four: 4,
  vijf: 5,
  five: 5,
  zes: 6,
  six: 6,
  half: 0.5,
  halve: 0.5,
};

const PANTRY = [
  'zout',
  'peper',
  'zwarte peper',
  'zeezout',
  'salt',
  'pepper',
  'black pepper',
  'sea salt',
  'water',
  'olie',
  'olijfolie',
  'zonnebloemolie',
  'oil',
  'olive oil',
  'vegetable oil',
  'sunflower oil',
  'cooking spray',
  'suiker',
  'sugar',
  'bloem',
  'flour',
  'boter',
  'butter',
  'azijn',
  'vinegar',
  'ijsblokjes',
  'ice',
];

/** Typical piece weights, used to turn "2 uien" into grams when a product is sold by weight. */
const PIECE_GRAMS: [RegExp, number][] = [
  [/\b(ui|uien|onions?|sjalot\w*|shallots?)\b/, 120],
  [/\b(rode ui|red onions?)\b/, 120],
  [/\b(knoflook|garlic)\b/, 5],
  [/\b(paprika'?s?|bell peppers?)\b/, 160],
  [/\b(tomaat|tomaten|tomato(es)?)\b/, 100],
  [/\b(wortel|wortels|winterpeen|carrots?)\b/, 80],
  [/\b(aardappel|aardappels|aardappelen|potato(es)?)\b/, 150],
  [/\b(courgette|courgettes|zucchini)\b/, 250],
  [/\b(komkommer|cucumbers?)\b/, 350],
  [/\b(aubergine|aubergines|eggplants?)\b/, 300],
  [/\b(avocado|avocado's|avocados)\b/, 170],
  [/\b(banaan|bananen|bananas?)\b/, 120],
  [/\b(appel|appels|apples?)\b/, 180],
  [/\b(citroen|citroenen|lemons?)\b/, 100],
  [/\b(limoen|limoenen|limes?)\b/, 70],
  [/\b(ei|eieren|eggs?)\b/, 55],
  [/\b(kipfilet|kipfilets|chicken breasts?)\b/, 150],
  [/\b(prei|leeks?)\b/, 200],
  [/\b(broccoli)\b/, 400],
  [/\b(bloemkool|cauliflower)\b/, 600],
  [/\b(champignon|champignons|mushrooms?)\b/, 15],
  [/\b(zoete aardappel|sweet potato(es)?)\b/, 250],
  [/\b(gember|ginger)\b/, 20],
  [/\b(peper|chili|chilli|rode peper)\b/, 10],
  [/\b(ijsbergsla|kropsla|iceberg)\b/, 500],
  [/\b(bosui|bosuien|spring onions?|scallions?)\b/, 15],
  [/\b(spitskool|witte kool|rode kool|savooiekool|cabbage)\b/, 800],
  [/\b(knolselderij|celeriac)\b/, 700],
  [/\b(pompoen|butternut|squash)\b/, 1000],
  [/\b(mango|mango's)\b/, 300],
  [/\b(sinaasappel|sinaasappels|oranges?)\b/, 200],
  [/\b(peer|peren|pears?)\b/, 180],
  [/\b(kiwi|kiwi's)\b/, 80],
  [/\b(venkel|fennel)\b/, 250],
  [/\b(bleekselderij|celery)\b/, 400],
  [/\b(rode biet|bieten|beetroots?)\b/, 150],
  [/\b(mozzarella)\b/, 125],
  [/\b(tortilla|wraps?)\b/, 60],
  [/\b(pitabroodjes?|pitta)\b/, 70],
];

export function pieceGrams(name: string): number | undefined {
  const lower = name.toLowerCase();
  let best: number | undefined;
  for (const [pattern, grams] of PIECE_GRAMS) if (pattern.test(lower)) best = grams;
  return best;
}

export function isPantry(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return PANTRY.some(
    (item) => lower === item || lower === `${item}s` || new RegExp(`^(${item})( en | and |,|$)`).test(lower),
  );
}

function parseNumber(token: string): number | undefined {
  const t = token.trim().toLowerCase();
  if (!t) return undefined;
  if (t in UNICODE_FRACTIONS) return UNICODE_FRACTIONS[t];
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t];
  const mixedUnicode = /^(\d+)([½⅓⅔¼¾⅕⅛⅜⅝⅞])$/.exec(t);
  if (mixedUnicode) return Number(mixedUnicode[1]) + (UNICODE_FRACTIONS[mixedUnicode[2]!] ?? 0);
  const fraction = /^(\d+)\/(\d+)$/.exec(t);
  if (fraction) return Number(fraction[2]) ? Number(fraction[1]) / Number(fraction[2]) : undefined;
  const decimal = /^\d+(?:[.,]\d+)?$/.exec(t);
  if (decimal) return Number(t.replace(',', '.'));
  return undefined;
}

/**
 * Read a leading quantity: "2", "1/2", "1 1/2", "1½", "2-3", "2 tot 3", "ca. 400".
 * Ranges resolve to their upper bound so a shopping list never comes up short.
 */
function leadingQuantity(text: string): { quantity: number; rest: string } | undefined {
  let rest = text.replace(/^(ca\.?|circa|ongeveer|about|approx\.?|around|±|~)\s*/i, '');
  const tokens =
    /^((?:\d+\/\d+|\d*[½⅓⅔¼¾⅕⅛⅜⅝⅞]|\d+(?:[.,]\d+)?|[a-zéë]+))(?:\s+(\d+\/\d+|[½⅓⅔¼¾⅕⅛⅜⅝⅞]))?\s*(?:(?:-|–|tot|to|à|a)\s*(\d+(?:[.,]\d+)?|\d+\/\d+))?/i.exec(
      rest,
    );
  if (!tokens) return undefined;
  const first = parseNumber(tokens[1]!);
  if (first === undefined) return undefined;
  let quantity = first + (tokens[2] ? (parseNumber(tokens[2]) ?? 0) : 0);
  if (tokens[3]) {
    const upper = parseNumber(tokens[3]);
    if (upper !== undefined && upper > quantity) quantity = upper;
  }
  rest = rest.slice(tokens[0].length).trim();
  return { quantity, rest };
}

function leadingUnit(text: string): { unit: string; def: UnitDef; rest: string } | undefined {
  const lower = text.toLowerCase();
  for (const name of MULTI_WORD_UNITS) {
    if (lower.startsWith(`${name} `) || lower === name) {
      return { unit: name, def: UNITS[name]!, rest: text.slice(name.length).trim() };
    }
  }
  const match = /^([a-zé]+\.?)(?=\s|$|\b)/i.exec(text);
  if (!match) {
    // "500g" style, already split by caller, or "x" multipliers.
    return undefined;
  }
  const word = match[1]!.toLowerCase().replace(/\.$/, '');
  const def = UNITS[word] ?? UNITS[match[1]!.toLowerCase()];
  if (!def) return undefined;
  return { unit: word, def, rest: text.slice(match[0].length).trim() };
}

function splitNote(name: string): { name: string; note?: string } {
  let note: string | undefined;
  let clean = name.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    note = note ? `${note}; ${inner.trim()}` : inner.trim();
    return ' ';
  });
  const comma = clean.indexOf(',');
  if (comma > 0) {
    const tail = clean.slice(comma + 1).trim();
    if (tail) note = note ? `${tail}; ${note}` : tail;
    clean = clean.slice(0, comma);
  }
  clean = clean
    .replace(/^(of|van|of|of the|of)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return note ? { name: clean, note } : { name: clean };
}

export function parseIngredient(raw: string): ParsedIngredient {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .trim();
  const result: ParsedIngredient = { raw, name: cleaned, pantry: false };
  let rest = cleaned;
  const q = leadingQuantity(rest);
  if (q) {
    result.quantity = q.quantity;
    rest = q.rest;
    const u = leadingUnit(rest);
    if (u) {
      result.unit = u.unit;
      rest = u.rest.replace(/^(of|van)\s+/i, '');
      result.amount = { value: q.quantity * u.def.factor, dimension: u.def.dimension };
    } else {
      result.amount = { value: q.quantity, dimension: 'count' };
    }
  }
  const split = splitNote(rest);
  result.name = split.name || cleaned;
  if (split.note) result.note = split.note;
  result.pantry = isPantry(result.name);
  return result;
}

/** Parse a product unit size such as "500 g", "1,5 l", "6 stuks", "4 x 125 g", "per stuk", "ca. 450 g". */
export function parseUnitSize(text: string | undefined): Amount | undefined {
  if (!text) return undefined;
  const t = text
    .toLowerCase()
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/^(ca\.?|circa|ong\.?)\s*/, '')
    .trim();
  const multi = /^(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*([a-z]+)/.exec(t);
  if (multi) {
    const def = UNITS[multi[3]!];
    if (def)
      return {
        value: Number(multi[1]) * Number(multi[2]!.replace(',', '.')) * def.factor,
        dimension: def.dimension,
      };
  }
  if (/^per stuk|^stuk$|^los$/.test(t)) return { value: 1, dimension: 'count' };
  const simple = /^(\d+(?:[.,]\d+)?)\s*([a-z]+)/.exec(t);
  if (simple) {
    const def = UNITS[simple[2]!];
    if (def) return { value: Number(simple[1]!.replace(',', '.')) * def.factor, dimension: def.dimension };
  }
  return undefined;
}

/** Convert an amount to another dimension when a sensible bridge exists. */
export function convert(
  amount: Amount,
  to: Dimension,
  name: string,
): { value: number; estimated: boolean } | undefined {
  if (amount.dimension === to) return { value: amount.value, estimated: false };
  // Treat 1 ml as about 1 g for liquids and similar foods.
  if ((amount.dimension === 'volume' && to === 'mass') || (amount.dimension === 'mass' && to === 'volume'))
    return { value: amount.value, estimated: true };
  const grams = pieceGrams(name);
  if (grams) {
    if (amount.dimension === 'count' && to === 'mass')
      return { value: amount.value * grams, estimated: true };
    if (amount.dimension === 'mass' && to === 'count')
      return { value: amount.value / grams, estimated: true };
  }
  return undefined;
}

export function formatAmount(amount: Amount): string {
  const round = (value: number) => (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10);
  if (amount.dimension === 'mass')
    return amount.value >= 1000 ? `${round(amount.value / 1000)} kg` : `${round(amount.value)} g`;
  if (amount.dimension === 'volume')
    return amount.value >= 1000 ? `${round(amount.value / 1000)} l` : `${round(amount.value)} ml`;
  return `${round(amount.value)} st`;
}
