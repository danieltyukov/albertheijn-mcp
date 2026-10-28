import { afterEach, describe, expect, it, vi } from 'vitest';
import { choose, nameScore, rank } from '../src/planning/match.js';
import { planMealPrep } from '../src/planning/plan.js';
import type { ProductSummary } from '../src/ah/products.js';
import { anonymousContext, mockApi, type Call } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

const p = (
  id: number,
  title: string,
  unitSize: string,
  price: number,
  extra: Partial<ProductSummary> = {},
): ProductSummary => ({
  id,
  title,
  unitSize,
  price,
  orderable: true,
  url: `https://www.ah.nl/producten/product/wi${id}`,
  ...extra,
});

describe('matching', () => {
  it('prefers titles that are mostly the ingredient', () => {
    expect(nameScore('citroen', 'AH Citroen')).toBeGreaterThan(
      nameScore('citroen', 'Amstel Radler citroen 0.0% 12-pack'),
    );
    expect(nameScore('uien', 'AH Gele uien')).toBeGreaterThan(0.7);
    expect(nameScore('kipfilet', 'AH Volkoren pasta')).toBe(0);
  });

  it('pushes online multipacks down', () => {
    const ranked = rank('kikkererwten', [
      p(1, 'Bonduelle Kikkererwten 3-pack', '3 stuks', 2.99, { bundle: { items: 3 } }),
      p(2, 'AH Kikkererwten', '400 g', 0.93),
    ]);
    expect(ranked[0]!.product.id).toBe(2);
  });

  it('picks the cheapest way to cover the need, not the lowest unit price', () => {
    const candidates = rank('havermout', [
      p(1, 'AH Havermout', '500 g', 1.19),
      p(2, 'AH Havermout', '1 kg', 1.45),
    ]);
    // 250 g needed: one 500 g bag is cheaper than one 1 kg bag.
    const cost = (product: ProductSummary) => ({ total: product.price ?? 0, estimated: false });
    expect(choose(candidates, 'cheapest', cost)[0]!.product.id).toBe(1);
  });

  it('prefers a real bonus deal over a volume discount in bonus mode', () => {
    const candidates = rank('griekse yoghurt', [
      p(1, 'AH Griekse yoghurt', '1 kg', 2.99, {
        bonus: { mechanism: '5% volume voordeel', type: 'AHONLINE', onlineOnly: true },
      }),
      p(2, 'Merk Griekse yoghurt', '1 kg', 3.49, { bonus: { mechanism: '2 voor 5.00', type: 'NATIONAL' } }),
    ]);
    const cost = (product: ProductSummary) => ({ total: product.price ?? 0, estimated: false });
    expect(choose(candidates, 'bonus', cost)[0]!.product.id).toBe(2);
  });
});

describe('planMealPrep', () => {
  it('scales, merges, skips pantry items, counts packs and prices the basket', async () => {
    const ctx = await anonymousContext();
    const catalogue: Record<string, ProductSummary[]> = {};
    const raw = (x: ProductSummary) => ({
      webshopId: x.id,
      title: x.title,
      salesUnitSize: x.unitSize,
      priceBeforeBonus: x.price,
      isOrderable: true,
    });
    const products = {
      kipfilet: [p(10, 'AH Kipfilet', '300 g', 3.99)],
      rijst: [p(20, 'AH Zilvervliesrijst', '1 kg', 2.19)],
      broccoli: [p(30, 'AH Broccoli', '500 g', 1.49)],
    };
    Object.assign(catalogue, products);
    const calls = mockApi({
      '/mobile-services/product/search/v2': (c: Call) => {
        const q = (c.query.get('query') ?? '').toLowerCase();
        const hits = Object.entries(catalogue).find(([k]) => q.includes(k))?.[1] ?? [];
        return { page: { totalElements: hits.length, totalPages: 1, number: 0 }, products: hits.map(raw) };
      },
      'gql:totalPrice': (c: Call) => {
        const items = (c.body as { variables: { products: { id: number; quantity: number }[] } }).variables
          .products;
        const prices = new Map(
          Object.values(catalogue)
            .flat()
            .map((x) => [x.id, x.price ?? 0]),
        );
        const sum = items.reduce((s, i) => s + (prices.get(i.id) ?? 0) * i.quantity, 0);
        return { totalPrice: { withoutDiscount: { amount: sum }, discount: { amount: 1 } } };
      },
    });
    const plan = await planMealPrep(
      ctx,
      [
        {
          title: 'Kip rijst',
          ingredients: ['150 g kipfilet', '75 g rijst', '1 el olijfolie', 'zout en peper'],
          servings: 1,
          makeServings: 4,
        },
        {
          title: 'Kip broccoli',
          ingredients: ['500 g kipfilet', '1 broccoli'],
          servings: 4,
          makeServings: 4,
        },
      ],
      { preference: 'best_match' },
    );
    const kip = plan.lines.find((l) => l.ingredient === 'kipfilet')!;
    expect(kip.needed).toBe('1.1 kg');
    expect(kip.usedIn).toEqual(['Kip rijst', 'Kip broccoli']);
    expect(kip.packs).toBe(4);
    expect(kip.leftover).toBe('100 g');
    const rice = plan.lines.find((l) => l.ingredient === 'rijst')!;
    expect(rice).toMatchObject({ needed: '300 g', packs: 1, leftover: '700 g' });
    const broccoli = plan.lines.find((l) => l.ingredient === 'broccoli')!;
    expect(broccoli).toMatchObject({ packs: 1, estimated: true });
    expect(plan.pantrySkipped).toEqual(expect.arrayContaining(['olijfolie', 'zout en peper']));
    expect(plan.basketItems).toEqual(
      expect.arrayContaining([
        { productId: 10, quantity: 4 },
        { productId: 20, quantity: 1 },
      ]),
    );
    expect(plan.totals).toMatchObject({ servings: 8, discount: 1 });
    expect(plan.totals.total).toBeCloseTo(4 * 3.99 + 2.19 + 1.49 - 1);
    expect(plan.unmatched).toEqual([]);
    // Each ingredient is searched once, even when it appears in two recipes.
    expect(
      calls.filter((c) => c.path.endsWith('/search/v2') && c.query.get('query') === 'kipfilet'),
    ).toHaveLength(1);
  });

  it('reports ingredients it could not match and searches that failed', async () => {
    const ctx = await anonymousContext();
    mockApi({
      '/mobile-services/product/search/v2': (c: Call) =>
        c.query.get('query') === 'drakenfruit'
          ? { page: { totalElements: 0 }, products: [] }
          : new Response('', { status: 400 }),
      'gql:totalPrice': { totalPrice: { withoutDiscount: { amount: 0 }, discount: { amount: 0 } } },
    });
    const plan = await planMealPrep(ctx, [
      { ingredients: ['1 drakenfruit', '1 kg quinoa'], makeServings: 2 },
    ]);
    expect(plan.unmatched).toEqual(['drakenfruit']);
    expect(plan.lookupFailed).toEqual(['quinoa']);
    expect(plan.notes.join(' ')).toMatch(/failed/);
  });

  it('validates its input', async () => {
    const ctx = await anonymousContext();
    await expect(planMealPrep(ctx, [])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(planMealPrep(ctx, [{ makeServings: 2 }])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
