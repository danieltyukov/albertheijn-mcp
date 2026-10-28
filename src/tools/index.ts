import type { AppContext } from '../context.js';
import { registerAccountTools } from './account.js';
import { registerBonusTools } from './bonus.js';
import { registerListTools } from './list.js';
import { registerOrderTools } from './order.js';
import { registerPlanningTools } from './planning.js';
import { registerProductTools } from './products.js';
import { registerPromptsAndResources } from './prompts.js';
import { registerReceiptTools } from './receipts.js';
import { registerRecipeTools } from './recipes.js';
import type { ToolRegistry } from './registry.js';
import { registerStoreTools } from './stores.js';

export function registerAllTools(reg: ToolRegistry, ctx: AppContext): void {
  registerAccountTools(reg, ctx);
  registerProductTools(reg, ctx);
  registerBonusTools(reg, ctx);
  registerRecipeTools(reg, ctx);
  registerPlanningTools(reg, ctx);
  registerListTools(reg, ctx);
  registerOrderTools(reg, ctx);
  registerReceiptTools(reg, ctx);
  registerStoreTools(reg, ctx);
  registerPromptsAndResources(reg, ctx);
}
