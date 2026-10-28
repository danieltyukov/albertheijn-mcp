import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  categories,
  parseNutrition,
  productByBarcode,
  productDetail,
  searchProducts,
  summarize,
} from '../src/ah/products.js';
import { anonymousContext, fixture, mockApi } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

interface SearchFixture {
  products: Parameters<typeof summarize>[0][];
}

describe('products', () => {
  it('summarises a search product with unit price and bonus', async () => {
    const search = await fixture<SearchFixture>('search.json');
    const products = search.products.map(summarize);
    const milk = products.find((p) => p.id === 33693)!;
    expect(milk).toMatchObject({
      title: 'AH Halfvolle melk',
      price: 1.79,
      unitSize: '1,5 l',
      nutriscore: 'B',
      orderable: true,
    });
    expect(milk.pricePer).toEqual({ amount: 1.19, per: 'l' });
    expect(milk.url).toBe('https://www.ah.nl/producten/product/wi33693');
    const bonus = products.find((p) => p.bonus);
    if (bonus) {
      expect(bonus.bonus?.mechanism).toBeTruthy();
      expect(bonus.regularPrice).toBeGreaterThan(bonus.price ?? 0);
    }
  });

  it('uses REST search for plain queries and drops sponsored items', async () => {
    const ctx = await anonymousContext();
    const search = await fixture<SearchFixture & { page: unknown }>('search.json');
    search.products[0] = { ...search.products[0]!, isSponsored: true } as never;
    const calls = mockApi({ '/mobile-services/product/search/v2': search });
    const result = await searchProducts(ctx, { query: 'halfvolle melk', size: 3 });
    expect(result.products.every((p) => !p.sponsored)).toBe(true);
    const call = calls.find((c) => c.path.endsWith('/search/v2'))!;
    expect(call.query.get('query')).toBe('halfvolle melk');
    expect(call.query.get('sortOn')).toBe('RELEVANCE');
  });

  it('routes filtered searches through GraphQL facets and fills them in from REST', async () => {
    const ctx = await anonymousContext();
    const search = await fixture<SearchFixture>('search.json');
    const calls = mockApi({
      'gql:searchProducts': {
        searchProducts: {
          totalFound: 1,
          products: [{ id: 33693 }],
          facets: {
            facets: [
              {
                label: 'product.properties.dieet',
                name: 'dieet',
                options: [{ name: 'Vegetarisch', value: 'vegetarisch' }],
              },
            ],
          },
        },
      },
      '/search/v2/products': search.products.filter((p) => p.webshopId === 33693),
    });
    const result = await searchProducts(ctx, { query: 'melk', bonusOnly: true, diet: ['vegetarisch'] });
    expect(result.products.map((p) => p.id)).toEqual([33693]);
    expect(result.filters).toEqual([{ name: 'product.properties.dieet', options: ['vegetarisch'] }]);
    const gql = calls.find((c) => c.operation === 'searchProducts')!;
    const facets = (gql.body as { variables: { input: { searchInput: { facets: { label: string }[] } } } })
      .variables.input.searchInput.facets;
    expect(facets.map((f) => f.label)).toEqual(['bonus', 'product.properties.dieet']);
  });

  it('parses nutrition, allergens and diet labels from the detail endpoint', async () => {
    const ctx = await anonymousContext();
    const detail = await fixture<{ productCard: unknown }>('detail.json');
    const search = await fixture<SearchFixture>('search.json');
    mockApi({
      '/product/detail/v4/fir/33693': detail,
      '/search/v2/products': search.products.filter((p) => p.webshopId === 33693),
    });
    const product = await productDetail(ctx, 33693);
    expect(product.nutrition).toMatchObject({
      per: '100 ml',
      energyKcal: 48,
      protein: 3.6,
      fat: 1.6,
      salt: 0.13,
    });
    expect(product.allergens?.contains).toContain('Melk');
    expect(product.suitableFor).toContain('vegetarisch');
    expect(product.notSuitableFor).toContain('veganistisch');
    expect(product.gtin).toBe('08710400058519');
    expect(product.servingsPerPack).toBe(7.5);
    expect(product.description).toBe('Een koud glas halfvolle melk.');
  });

  it('reads the nutrition table without the optional fields', () => {
    expect(parseNutrition(undefined)).toBeUndefined();
    expect(parseNutrition({ nutritionalInformation: { nutrientHeaders: [{}] } })).toBeUndefined();
  });

  it('looks up a barcode and validates it', async () => {
    const ctx = await anonymousContext();
    const search = await fixture<SearchFixture>('search.json');
    mockApi({ '/product/search/v1/gtin/8710400058519': search.products.find((p) => p.webshopId === 33693) });
    await expect(productByBarcode(ctx, '87 10400 058519')).resolves.toMatchObject({ id: 33693 });
    await expect(productByBarcode(ctx, '123')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(productByBarcode(ctx, '0000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists categories and sub-categories', async () => {
    const ctx = await anonymousContext();
    mockApi({
      '/sub-categories': {
        parent: { id: 1730, name: 'Zuivel, eieren' },
        children: [{ id: 1319, name: 'Melk' }],
      },
      '/product-shelves/categories': [
        { id: 1730, name: 'Zuivel, eieren', nix18: false },
        { id: 6409, name: 'Bier, wijn', nix18: true },
      ],
    });
    expect((await categories(ctx)).categories).toEqual([
      { id: 1730, name: 'Zuivel, eieren' },
      { id: 6409, name: 'Bier, wijn', ageCheck: true },
    ]);
    expect(await categories(ctx, 1730)).toEqual({
      parent: { id: 1730, name: 'Zuivel, eieren' },
      categories: [{ id: 1319, name: 'Melk' }],
    });
  });
});
