import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { round2 } from '../ah/format.js';
import {
  categories,
  productByBarcode,
  productDetail,
  searchProducts,
  SORTS,
  type ProductDetail,
} from '../ah/products.js';
import { parseUnitSize } from '../planning/quantity.js';
import { READ, type ToolRegistry } from './registry.js';

export const productId = z
  .number()
  .int()
  .positive()
  .describe('Albert Heijn product id (webshopId), as returned by search');

export function registerProductTools(reg: ToolRegistry, _ctx: AppContext): void {
  reg.tool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Search the Albert Heijn assortment. Returns id, title, size, current price, price per kg or litre, bonus deal, Nutri-Score and a link. Filters (bonusOnly, brand, nutriscore, diet, allergy) use Albert Heijn facets; the response lists valid filter values. Prices are online prices. Works without sign-in; when signed in, previouslyBought marks products you bought before.',
      input: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe('Search words, Dutch works best: "kipfilet", "havermout", "griekse yoghurt"'),
        categoryId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Restrict to a category from list_categories'),
        bonusOnly: z.boolean().default(false).describe('Only products on bonus this week'),
        brand: z.string().max(80).optional().describe('Brand slug, e.g. "ah", "ah-biologisch", "alpro"'),
        nutriscore: z
          .array(z.enum(['a', 'b', 'c', 'd', 'e']))
          .max(5)
          .optional(),
        diet: z
          .array(z.string().max(40))
          .max(5)
          .optional()
          .describe('Diet slugs such as "vegetarisch", "veganistisch", "biologisch", "laag-suiker"'),
        allergy: z
          .array(z.string().max(40))
          .max(5)
          .optional()
          .describe('Allergy slugs such as "zonder-gluten", "zonder-lactose", "zonder-noten"'),
        sort: z.enum(SORTS).default('relevance'),
        page: z.number().int().min(0).max(50).default(0),
        size: z.number().int().min(1).max(50).default(10),
      },
      annotations: READ,
    },
    async (args, ctx) => {
      const options: Parameters<typeof searchProducts>[1] = {
        page: args.page,
        size: args.size,
        sort: args.sort,
        bonusOnly: args.bonusOnly,
      };
      if (args.query) options.query = args.query;
      if (args.categoryId) options.categoryId = args.categoryId;
      if (args.brand) options.brand = args.brand;
      if (args.nutriscore) options.nutriscore = args.nutriscore;
      if (args.diet) options.diet = args.diet;
      if (args.allergy) options.allergy = args.allergy;
      return searchProducts(ctx, options);
    },
  );

  reg.tool(
    'get_product',
    {
      title: 'Product details',
      description:
        'Everything about one product: price and bonus, nutrition per 100 g or ml, ingredients, allergens, diet labels (vegetarian, vegan, lactose-free and so on), Nutri-Score, barcode, storage and servings per pack.',
      input: { productId },
      annotations: READ,
    },
    async (args, ctx) => productDetail(ctx, args.productId),
  );

  reg.tool(
    'lookup_barcode',
    {
      title: 'Find a product by barcode',
      description:
        'Find the Albert Heijn product for an EAN or GTIN barcode (8 to 14 digits), for example one read from a package.',
      input: { barcode: z.string().min(8).max(20) },
      annotations: READ,
    },
    async (args, ctx) => productByBarcode(ctx, args.barcode),
  );

  reg.tool(
    'list_categories',
    {
      title: 'Product categories',
      description:
        'The top-level shelves of the Albert Heijn assortment, or the sub-categories of one. Use the id with search_products.',
      input: {
        parentId: z.number().int().positive().optional().describe('Show the sub-categories of this category'),
      },
      annotations: READ,
    },
    async (args, ctx) => categories(ctx, args.parentId),
  );

  reg.tool(
    'compare_products',
    {
      title: 'Compare products',
      description:
        'Compare up to 12 products on price per kg or litre, protein per euro, protein and calories per 100 g, Nutri-Score and diet labels, sorted by the metric you pick. Give product ids, or a search query to compare its top results. Useful for "cheapest protein", "best value rice" or "lowest calorie yoghurt".',
      input: {
        productIds: z.array(z.number().int().positive()).max(12).optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(2).max(12).default(8),
        sortBy: z
          .enum(['price_per_unit', 'protein_per_euro', 'protein_per_100', 'kcal_per_100', 'kcal_per_euro'])
          .default('price_per_unit'),
      },
      annotations: READ,
    },
    async (args, ctx) => {
      let ids = args.productIds ?? [];
      if (!ids.length) {
        if (!args.query) throw new AhError('INVALID_ARGUMENT', 'Give productIds or a query.');
        const found = await searchProducts(ctx, { query: args.query, size: args.limit });
        ids = found.products.map((p) => p.id);
      }
      const details = (
        await Promise.all(ids.slice(0, 12).map((id) => productDetail(ctx, id).catch(() => undefined)))
      ).filter((d): d is ProductDetail => Boolean(d));
      const rows = details.map((d) => {
        const size = parseUnitSize(d.unitSize);
        const grams = size && size.dimension !== 'count' ? size.value : undefined;
        const protein = d.nutrition?.protein;
        const kcal = d.nutrition?.energyKcal;
        const row = {
          id: d.id,
          title: d.title,
          unitSize: d.unitSize,
          price: d.price,
          deal: d.bonus?.mechanism,
          pricePer: d.pricePer ? `EUR ${d.pricePer.amount.toFixed(2)} per ${d.pricePer.per}` : undefined,
          proteinPer100: protein,
          kcalPer100: kcal,
          proteinPerEuro:
            grams && protein !== undefined && d.price ? round2((protein * grams) / 100 / d.price) : undefined,
          kcalPerEuro:
            grams && kcal !== undefined && d.price ? Math.round((kcal * grams) / 100 / d.price) : undefined,
          nutriscore: d.nutriscore,
          suitableFor: d.suitableFor?.filter((s) => !s.startsWith('geen ')).slice(0, 6),
          url: d.url,
          sortValue: undefined as number | undefined,
        };
        row.sortValue =
          args.sortBy === 'price_per_unit'
            ? d.pricePer?.amount
            : args.sortBy === 'protein_per_euro'
              ? row.proteinPerEuro
              : args.sortBy === 'protein_per_100'
                ? protein
                : args.sortBy === 'kcal_per_100'
                  ? kcal
                  : row.kcalPerEuro;
        return row;
      });
      const ascending = args.sortBy === 'price_per_unit' || args.sortBy === 'kcal_per_100';
      rows.sort((a, b) => {
        if (a.sortValue === undefined) return 1;
        if (b.sortValue === undefined) return -1;
        return ascending ? a.sortValue - b.sortValue : b.sortValue - a.sortValue;
      });
      return {
        sortedBy: args.sortBy,
        products: rows.map(({ sortValue: _s, ...rest }) => rest),
        note: 'Per-euro figures use the single-item price; multi-buy deals lower them further.',
      };
    },
  );
}
