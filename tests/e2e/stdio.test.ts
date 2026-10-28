import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockAh, type MockAh } from './mock-ah.js';

/**
 * Starts the built CLI exactly as an MCP client would (node dist/cli.js serve over stdio)
 * against a local stand-in for the Albert Heijn API, and drives it through the SDK client.
 */

const CLI = resolve('dist/cli.js');

async function start(home: string, mock: MockAh) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'serve'],
    env: {
      ...process.env,
      AH_MCP_HOME: home,
      AH_MCP_API_URL: mock.url,
      AH_MCP_MIN_INTERVAL_MS: '0',
    } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), data: result.structuredContent as Record<string, any> };
}

describe('albertheijn-mcp over stdio', () => {
  let mock: MockAh;
  let anonymous: Client;
  let signedIn: Client;

  beforeAll(async () => {
    mock = await startMockAh();
    anonymous = await start(await mkdtemp(join(tmpdir(), 'ah-e2e-anon-')), mock);
    const home = await mkdtemp(join(tmpdir(), 'ah-e2e-user-'));
    await mkdir(home, { recursive: true });
    const session = {
      version: 1,
      user: {
        accessToken: 'user',
        refreshToken: 'r',
        expiresAt: Date.now() + 3600_000,
        memberId: '42',
        savedAt: new Date().toISOString(),
      },
    };
    await writeFile(
      join(home, 'session.json'),
      JSON.stringify({ format: 'plain-v1', value: JSON.stringify(session) }),
      { mode: 0o600 },
    );
    signedIn = await start(home, mock);
  });

  afterAll(async () => {
    await anonymous?.close();
    await signedIn?.close();
    await mock?.close();
  });

  it('starts, reports its version and lists the tools', async () => {
    expect(anonymous.getServerVersion()?.name).toBe('albertheijn');
    const { tools } = await anonymous.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(35);
  });

  it('searches and reads products without an account', async () => {
    const search = await tool(anonymous, 'search_products', { query: 'kipfilet' });
    expect(search.isError).toBe(false);
    expect(search.data.products[0]).toMatchObject({
      id: 10,
      title: 'AH Scharrel kipfilet',
      pricePer: { amount: 13.3, per: 'kg' },
    });
    const detail = await tool(anonymous, 'get_product', { productId: 10 });
    expect(detail.data.nutrition).toMatchObject({ protein: 23, energyKcal: 110 });
    const compare = await tool(anonymous, 'compare_products', {
      productIds: [10, 20],
      sortBy: 'protein_per_euro',
    });
    expect(compare.data.products[0].id).toBe(10);
    expect(mock.requests.filter((r) => r.path.endsWith('/anonymous')).length).toBeGreaterThanOrEqual(1);
  });

  it('plans meal prep with bonus prices', async () => {
    const plan = await tool(anonymous, 'plan_meal_prep', {
      recipes: [
        {
          title: 'Kip met rijst en broccoli',
          ingredients: ['600 g kipfilet', '300 g rijst', '1 broccoli', 'zout'],
          servings: 4,
          makeServings: 4,
        },
      ],
    });
    expect(plan.isError).toBe(false);
    expect(plan.data.basketItems).toEqual(
      expect.arrayContaining([
        { productId: 10, quantity: 2 },
        { productId: 20, quantity: 1 },
        { productId: 30, quantity: 1 },
      ]),
    );
    expect(plan.data.totals.discount).toBe(0.5);
    expect(plan.data.pantrySkipped).toContain('zout');
  });

  it('asks for sign-in on account tools when signed out', async () => {
    const list = await tool(anonymous, 'get_shopping_list');
    expect(list.isError).toBe(true);
    expect(list.data.error.code).toBe('AUTH_REQUIRED');
  });

  it('edits the list directly, and a booked order only through preview and confirmation', async () => {
    const added = await tool(signedIn, 'update_shopping_list', { items: [{ productId: 20, quantity: 2 }] });
    expect(added.isError).toBe(false);
    expect(added.data.list.items).toEqual([expect.objectContaining({ productId: 20, quantity: 2 })]);
    expect(mock.requests.filter((r) => r.operation === 'basket').every((r) => r.auth === 'Bearer user')).toBe(
      true,
    );

    mock.orderBooked = true;
    const refused = await tool(signedIn, 'update_shopping_list', { items: [{ productId: 10, quantity: 1 }] });
    expect(refused.data.error.code).toBe('NOT_ALLOWED');

    const preview = await tool(signedIn, 'prepare_basket_change', {
      items: [{ productId: 10, quantity: 2 }],
    });
    expect(preview.data).toMatchObject({ target: 'booked order', totalBefore: 4.38, totalAfter: 12.36 });
    expect(mock.basket.get(10)).toBeUndefined();

    const confirmed = await tool(signedIn, 'confirm_basket_change', {
      confirmationToken: preview.data.confirmationToken,
      confirmed: true,
    });
    expect(confirmed.data).toMatchObject({ applied: true, target: 'booked order' });
    expect(mock.basket.get(10)).toBe(2);

    const order = await tool(signedIn, 'get_order');
    expect(order.data).toMatchObject({ active: true, orderId: 5, itemCount: 4 });
    expect(order.data.closesAt).toBe('2026-10-30T22:59:00Z');
  });
});
