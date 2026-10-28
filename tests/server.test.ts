import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, connect } from './mcp.js';

afterEach(() => vi.restoreAllMocks());

describe('MCP server', () => {
  it('lists every tool once, with annotations and instructions', async () => {
    const { client, registry } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(tools.length).toBe(registry.tools.length);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_products',
        'plan_meal_prep',
        'prepare_basket_change',
        'confirm_basket_change',
      ]),
    );
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.description!.length, tool.name).toBeGreaterThan(30);
    }
    expect(tools.find((t) => t.name === 'confirm_basket_change')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'search_products')?.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain('prepare_basket_change');
  });

  it('pairs every confirm tool with a prepare tool', async () => {
    const { registry } = await connect();
    const names = registry.tools.map((t) => t.name);
    for (const name of names.filter((n) => n.startsWith('confirm_')))
      expect(names).toContain(name.replace('confirm_', 'prepare_'));
  });

  it('returns structured AUTH_REQUIRED errors for account tools when signed out', async () => {
    const { client } = await connect();
    for (const name of ['get_shopping_list', 'get_order', 'list_receipts', 'get_profile']) {
      const result = await call(client, name);
      expect(result.isError, name).toBe(true);
      expect(result.data.error?.code, name).toBe('AUTH_REQUIRED');
    }
  });

  it('reports a signed-out status without touching the network', async () => {
    const { client } = await connect();
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = await call(client, 'auth_status');
    expect(result.data).toMatchObject({ signedIn: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('exposes prompts and the usage resource', async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(['meal_prep', 'weekly_shop', 'cook_from_bonus', 'recipe_to_basket']),
    );
    const prompt = await client.getPrompt({ name: 'meal_prep', arguments: { goal: '5 lunches' } });
    expect(JSON.stringify(prompt.messages)).toContain('plan_meal_prep');
    const resource = await client.readResource({ uri: 'albertheijn://usage' });
    expect(JSON.stringify(resource.contents)).toContain('albertheijn-mcp');
  });
});
