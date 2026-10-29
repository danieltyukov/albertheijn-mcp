import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';
import { productUrl } from './format.js';
import { productsByIds } from './products.js';

interface RawFavoriteList {
  id: string;
  description?: string;
  totalSize?: number;
  items?: { id: string; productId: number; quantity?: number }[];
}

/** favoriteListV2 with an empty id list returns every list; the old REST listing now answers 404. */
export async function favoriteLists(
  ctx: AppContext,
): Promise<{ lists: { id: string; name: string; items: number }[] }> {
  const data = await ctx.ah.graphql<{ favoriteListV2: RawFavoriteList[] | null }>(
    'query FavoriteLists($ids: [String!]!) { favoriteListV2(ids: $ids) { id description totalSize } }',
    { ids: [] },
    { auth: 'user' },
  );
  return {
    lists: (data.favoriteListV2 ?? []).map((l) => ({
      id: l.id,
      name: l.description ?? '',
      items: l.totalSize ?? 0,
    })),
  };
}

async function rawList(ctx: AppContext, listId: string): Promise<RawFavoriteList> {
  const data = await ctx.ah.graphql<{ favoriteListV2: RawFavoriteList[] | null }>(
    'query FavoriteList($ids: [String!]!) { favoriteListV2(ids: $ids) { id description totalSize items { id productId quantity } } }',
    { ids: [listId.toUpperCase()] },
    { auth: 'user' },
  );
  const list = data.favoriteListV2?.[0];
  if (!list) throw new AhError('NOT_FOUND', `No favourite list ${listId}.`);
  return list;
}

export async function favoriteList(ctx: AppContext, listId: string) {
  const list = await rawList(ctx, listId);
  const products = await productsByIds(
    ctx,
    (list.items ?? []).map((i) => i.productId),
  );
  const byId = new Map(products.map((p) => [p.webshopId, p]));
  return {
    id: list.id,
    name: list.description ?? '',
    items: (list.items ?? []).map((item) => {
      const p = byId.get(item.productId);
      return {
        itemId: item.id,
        productId: item.productId,
        title: p?.title ?? `Product ${item.productId}`,
        quantity: item.quantity ?? 1,
        price: p?.currentPrice ?? p?.priceBeforeBonus ?? undefined,
        onBonus: p?.isBonus || undefined,
        url: productUrl(item.productId),
      };
    }),
  };
}

interface MutationStatus {
  status?: string;
  errorMessage?: string | null;
}

function check(result: MutationStatus | null | undefined): void {
  if (result?.status && result.status !== 'SUCCESS')
    throw new AhError(
      'UNAVAILABLE',
      `Albert Heijn refused the change: ${(result.errorMessage ?? result.status).slice(0, 200)}`,
    );
}

export async function addToFavoriteList(
  ctx: AppContext,
  listId: string,
  products: { productId: number; quantity: number }[],
) {
  const data = await ctx.ah.graphql<{ favoriteListProductsAddV2: MutationStatus }>(
    `mutation AddProductsToFavoriteList($favoriteListId: String!, $products: [FavoriteListProductMutation!]!) {
      favoriteListProductsAddV2(id: $favoriteListId, products: $products) { status errorMessage }
    }`,
    { favoriteListId: listId.toUpperCase(), products },
    { auth: 'user', allowPartial: true },
  );
  check(data.favoriteListProductsAddV2);
}

/** Remove products from a favourite list by product id. */
export async function removeFromFavoriteList(ctx: AppContext, listId: string, productIds: number[]) {
  const list = await rawList(ctx, listId);
  const wanted = new Set(productIds);
  const itemIds = (list.items ?? []).filter((i) => wanted.has(i.productId)).map((i) => i.id);
  if (!itemIds.length) return { removed: 0 };
  const data = await ctx.ah.graphql<{ favoriteListProductsDeleteV2: MutationStatus }>(
    `mutation DeleteProductsFromFavoriteList($favoriteListId: String!, $itemIds: [String!]!) {
      favoriteListProductsDeleteV2(id: $favoriteListId, itemIds: $itemIds) { status errorMessage }
    }`,
    { favoriteListId: listId.toUpperCase(), itemIds },
    { auth: 'user', allowPartial: true },
  );
  check(data.favoriteListProductsDeleteV2);
  return { removed: itemIds.length };
}
