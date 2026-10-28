import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bonusGroupProducts, bonusOffers, priceItems } from '../src/ah/bonus.js';
import { anonymousContext, fixture, mockApi } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bonus', () => {
  it('collects offers from the national sections of the current week', async () => {
    const ctx = await anonymousContext();
    const calls = mockApi({
      '/bonuspage/v3/metadata': await fixture('bonus-metadata.json'),
      '/bonuspage/v2/section': await fixture('bonus-section.json'),
    });
    const result = await bonusOffers(ctx, {});
    expect(result.week).toEqual({ startDate: '2026-10-26', endDate: '2026-11-01' });
    expect(result.offers.length).toBeGreaterThan(0);
    const eru = result.offers.find((o) => o.groupId === '821906');
    expect(eru).toMatchObject({ title: 'Alle Eru', deal: '2 + 1 GRATIS', category: 'Kaas' });
    expect(result.sections).toContain('Kaas');
    const sectionCalls = calls.filter((c) => c.path.endsWith('/bonuspage/v2/section'));
    expect(sectionCalls.every((c) => c.query.get('promotionType') === 'NATIONAL')).toBe(true);
  });

  it('filters by section and search words', async () => {
    const ctx = await anonymousContext();
    mockApi({
      '/bonuspage/v3/metadata': await fixture('bonus-metadata.json'),
      '/bonuspage/v2/section': await fixture('bonus-section.json'),
    });
    const result = await bonusOffers(ctx, { section: 'kaas', search: 'eru' });
    expect(result.offers.map((o) => o.title)).toEqual(['Alle Eru']);
    await expect(bonusOffers(ctx, { section: 'nonexistent' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('says when next week is not published yet', async () => {
    const ctx = await anonymousContext();
    mockApi({ '/bonuspage/v3/metadata': await fixture('bonus-metadata.json') });
    await expect(bonusOffers(ctx, { week: 'next' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists the products of a bonus group for the bonus week', async () => {
    const ctx = await anonymousContext();
    const calls = mockApi({
      'gql:bonusPromotions': {
        bonusPromotions: [
          {
            id: '821906',
            title: 'Alle Eru',
            products: [
              {
                id: 113356,
                title: 'Eru Kids',
                salesUnitSize: '100 g',
                priceV2: {
                  now: { amount: 1.75 },
                  was: { amount: 1.75 },
                  promotionLabel: { tiers: [{ description: '2+1 gratis' }] },
                },
              },
            ],
          },
        ],
      },
    });
    const group = await bonusGroupProducts(ctx, '821906');
    expect(group.products[0]).toMatchObject({ id: 113356, price: 1.75, deal: '2+1 gratis' });
    expect((calls[1]!.body as { variables: unknown }).variables).toEqual({
      id: '821906',
      periodStart: '2026-10-26',
      periodEnd: '2026-11-01',
    });
  });

  it('prices items with the discount Albert Heijn applies and merges duplicates', async () => {
    const ctx = await anonymousContext();
    const calls = mockApi({
      'gql:totalPrice': { totalPrice: { withoutDiscount: { amount: 7.69 }, discount: { amount: 0.4 } } },
    });
    const price = await priceItems(ctx, [
      { productId: 2600, quantity: 1 },
      { productId: 2600, quantity: 1 },
      { productId: 33693, quantity: 1 },
    ]);
    expect(price).toEqual({ beforeDiscount: 7.69, discount: 0.4, total: 7.29 });
    expect((calls.at(-1)!.body as { variables: unknown }).variables).toEqual({
      products: [
        { id: 2600, quantity: 2 },
        { id: 33693, quantity: 1 },
      ],
    });
  });
});
