import { z } from 'zod';
import type { AppContext } from '../context.js';
import { matchIngredients, planMealPrep } from '../planning/plan.js';
import { READ, type ToolRegistry } from './registry.js';

const preference = z
  .enum(['best_match', 'cheapest', 'bonus'])
  .default('best_match')
  .describe(
    "best_match follows Albert Heijn's own suggestion; cheapest picks the lowest price per kg or litre; bonus prefers products on bonus",
  );

export function registerPlanningTools(reg: ToolRegistry, _ctx: AppContext): void {
  reg.tool(
    'plan_meal_prep',
    {
      title: 'Plan meal prep and shopping',
      description:
        "Turn one or more recipes into a single priced Albert Heijn shopping plan. Each recipe is an Allerhande id, a recipe URL, or plain ingredient lines, with the servings to make. The server scales the recipes, merges the same ingredient across them, matches each to a product, works out how many packs to buy and what is left over, and prices the lot with this week's bonus. Returns basketItems ready for prepare_basket_change. Choosing recipes is up to you: use search_recipes, import_recipe or your own ideas first.",
      input: {
        recipes: z
          .array(
            z.object({
              allerhandeId: z.number().int().positive().optional(),
              url: z.string().url().max(2000).optional(),
              title: z.string().max(120).optional(),
              ingredients: z
                .array(z.string().min(1).max(200))
                .max(60)
                .optional()
                .describe('Lines like "500 g kipfilet" or "2 el olijfolie"'),
              servings: z
                .number()
                .min(1)
                .max(100)
                .optional()
                .describe('Servings the given lines are written for'),
              makeServings: z.number().int().min(1).max(100).describe('Servings to cook'),
            }),
          )
          .min(1)
          .max(12),
        preference,
        skipPantry: z
          .boolean()
          .default(true)
          .describe('Leave out salt, pepper, oil, sugar, flour, butter and optional ingredients'),
        searchTerms: z
          .record(z.string().max(80), z.string().max(80))
          .optional()
          .describe('Ingredient name to a Dutch search term, e.g. {"chicken breast": "kipfilet"}'),
        exclude: z.array(z.string().max(80)).max(40).optional().describe('Ingredients the user already has'),
      },
      annotations: READ,
    },
    async (args, ctx) => {
      const options: Parameters<typeof planMealPrep>[2] = {
        preference: args.preference,
        skipPantry: args.skipPantry,
      };
      if (args.searchTerms) options.searchTerms = args.searchTerms;
      if (args.exclude) options.exclude = args.exclude;
      return planMealPrep(
        ctx,
        args.recipes.map((r) => {
          const input: Parameters<typeof planMealPrep>[1][number] = { makeServings: r.makeServings };
          if (r.allerhandeId) input.allerhandeId = r.allerhandeId;
          if (r.url) input.url = r.url;
          if (r.title) input.title = r.title;
          if (r.ingredients) input.ingredients = r.ingredients;
          if (r.servings) input.servings = r.servings;
          return input;
        }),
        options,
      );
    },
  );

  reg.tool(
    'match_ingredients',
    {
      title: 'Find products for ingredients',
      description:
        'Match loose ingredient or shopping lines ("1 kg havermout", "2 avocado\'s", "greek yogurt") to Albert Heijn products with pack counts and two alternatives each. Dutch names match best.',
      input: { lines: z.array(z.string().min(1).max(200)).min(1).max(40), preference },
      annotations: READ,
    },
    async (args, ctx) => matchIngredients(ctx, args.lines, args.preference),
  );
}
