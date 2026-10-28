import { z } from 'zod';
import type { AppContext } from '../context.js';
import { INSTRUCTIONS } from '../server.js';
import type { ToolRegistry } from './registry.js';

export function registerPromptsAndResources(reg: ToolRegistry, _ctx: AppContext): void {
  reg.prompt(
    'meal_prep',
    'Plan a batch of meals for a goal, budget and diet, then fill the basket after approval.',
    {
      goal: z.string().describe('For example "5 high-protein lunches" or "dinners for 2 for the week"'),
      budget: z.string().optional().describe('Budget in euros'),
      diet: z.string().optional().describe('For example vegetarian, no pork, lactose-free'),
    },
    (v) =>
      `Plan meal prep for: ${v.goal}.${v.budget ? ` Budget: EUR ${v.budget}.` : ''}${v.diet ? ` Diet: ${v.diet}.` : ''}
1. Call get_bonus to see what is on offer this week, and search_recipes with fitting filters (for example speciale-wensen eiwitrijk or vegetarisch, menugang lunch). Prefer recipes that share ingredients and keep well in the fridge.
2. Pick the recipes, then call plan_meal_prep with them and the servings, preference "bonus" when budget matters.
3. Show the plan: recipes, products with pack counts, leftovers, total and cost per serving. Mention estimated lines and swap anything unmatched.
4. Ask whether to put it in the basket. If yes, call prepare_basket_change with basketItems, show the preview, and call confirm_basket_change only after I approve.`,
  );

  reg.prompt(
    'weekly_shop',
    "Build this week's shopping from my usual products, the bonus and my list.",
    {},
    () =>
      `Help me with this week's Albert Heijn shop. Call get_shopping_list, get_frequent_products and get_bonus. Show which of my usual products are on bonus, which are on my list already, and suggest swaps that save money. Then propose one basket, priced with price_items, and only change anything through prepare_basket_change after I approve the preview.`,
  );

  reg.prompt(
    'cook_from_bonus',
    'Recipe ideas built around what is on bonus this week.',
    { people: z.string().optional().describe('Number of people') },
    (v) =>
      `Find three dinners${v.people ? ` for ${v.people} people` : ''} built around this week's bonus. Call get_bonus (sections Vlees, Vis, Groente and Vegetarisch), search_recipes for dishes using those products, and plan_meal_prep with preference "bonus" for the three together. Show what each dinner costs per person and which bonus deals it uses.`,
  );

  reg.prompt(
    'recipe_to_basket',
    'Shop for a recipe from any website.',
    { url: z.string().describe('Recipe URL'), servings: z.string().optional() },
    (v) =>
      `Import the recipe at ${v.url} with import_recipe, then run plan_meal_prep for ${v.servings ?? 'its own number of'} servings. If it is in English, pass Dutch search terms for the ingredients. Show the products and total, then offer to add them through prepare_basket_change.`,
  );

  reg.resource('usage', 'albertheijn://usage', 'How to use this server and its tools.', () =>
    JSON.stringify({ instructions: INSTRUCTIONS }),
  );
}
