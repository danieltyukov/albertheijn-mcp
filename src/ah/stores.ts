import type { AppContext } from '../context.js';
import { AhError } from '../errors.js';

const HOUR = 60 * 60_000;

const STORE_FIELDS = `id name storeType phone distance
  address { street houseNumber houseNumberExtra postalCode city countryCode }
  geoLocation { latitude longitude }
  openingDays { date openingHour { openFrom openUntil } }
  services { code }`;

interface RawStore {
  id: number;
  name: string;
  storeType?: string;
  phone?: string;
  distance?: number;
  address?: {
    street?: string;
    houseNumber?: string;
    houseNumberExtra?: string | null;
    postalCode?: string;
    city?: string;
  };
  geoLocation?: { latitude?: number; longitude?: number };
  openingDays?: unknown;
  services?: { code?: string }[];
}

export interface Store {
  id: number;
  name: string;
  type?: string;
  address?: string;
  phone?: string;
  distanceKm?: number;
  location?: { latitude: number; longitude: number };
  /** Opening hours for the coming days, local time. */
  hours?: { date: string; open?: string; close?: string; closed?: boolean }[];
  services?: string[];
  mapsUrl?: string;
}

type RawDay = { date?: string; openingHour?: { openFrom?: string; openUntil?: string } | null };

function flattenDays(value: unknown): RawDay[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    Array.isArray(item) ? flattenDays(item) : item && typeof item === 'object' ? [item as RawDay] : [],
  );
}

export function shapeStore(raw: RawStore): Store {
  const store: Store = { id: raw.id, name: raw.name };
  if (raw.storeType) store.type = raw.storeType;
  const a = raw.address;
  if (a) {
    const street = [a.street, [a.houseNumber, a.houseNumberExtra].filter(Boolean).join('')]
      .filter(Boolean)
      .join(' ');
    store.address = [street, [a.postalCode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }
  if (raw.phone) store.phone = raw.phone;
  if (typeof raw.distance === 'number') store.distanceKm = Math.round(raw.distance / 100) / 10;
  const lat = raw.geoLocation?.latitude;
  const lon = raw.geoLocation?.longitude;
  if (typeof lat === 'number' && typeof lon === 'number') {
    store.location = { latitude: lat, longitude: lon };
    store.mapsUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
  }
  const days = flattenDays(raw.openingDays)
    .filter((d) => d.date)
    .sort((x, y) => (x.date! < y.date! ? -1 : 1))
    .slice(0, 7);
  if (days.length) {
    store.hours = days.map((d) =>
      d.openingHour?.openFrom
        ? { date: d.date!, open: d.openingHour.openFrom, close: d.openingHour.openUntil ?? '' }
        : { date: d.date!, closed: true },
    );
  }
  const services = (raw.services ?? []).map((s) => s.code).filter((c): c is string => Boolean(c));
  if (services.length) store.services = services;
  return store;
}

export interface StoreQuery {
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  /** REGULAR, XL, TOGO and similar. */
  types?: string[];
  limit?: number;
}

export async function findStores(ctx: AppContext, query: StoreQuery): Promise<{ stores: Store[] }> {
  const filter: Record<string, unknown> = {};
  if (query.postalCode) filter.postalCode = query.postalCode.replace(/\s+/g, '').toUpperCase();
  else if (query.latitude !== undefined && query.longitude !== undefined)
    filter.location = { latitude: query.latitude, longitude: query.longitude };
  else throw new AhError('INVALID_ARGUMENT', 'Give a postal code, or a latitude and longitude.');
  if (query.types?.length) filter.storeTypes = query.types.map((t) => t.toUpperCase());
  const limit = Math.min(Math.max(query.limit ?? 5, 1), 20);
  const data = await ctx.cache.get(`stores:${JSON.stringify(filter)}:${limit}`, HOUR, () =>
    ctx.ah.graphql<{ storesSearch: { result: RawStore[] } }>(
      `query StoresSearch($filter: StoresFilterInput, $limit: Int) { storesSearch(filter: $filter, limit: $limit) { result { ${STORE_FIELDS} } } }`,
      { filter, limit },
    ),
  );
  return { stores: (data.storesSearch?.result ?? []).map(shapeStore) };
}

export async function storeInfo(ctx: AppContext, id: number): Promise<Store> {
  const data = await ctx.cache.get(`store:${id}`, HOUR, () =>
    ctx.ah.graphql<{ storesInformation: RawStore | null }>(
      `query FetchStore($storeId: Int!) { storesInformation(id: $storeId) { ${STORE_FIELDS} } }`,
      { storeId: id },
    ),
  );
  if (!data.storesInformation) throw new AhError('NOT_FOUND', `No store with id ${id}.`);
  return shapeStore(data.storesInformation);
}

interface RawBargain {
  product?: { id?: number; title?: string; brand?: string; salesUnitSize?: string };
  categoryTitle?: string;
  markdown?: { markdownType?: string; markdownExpirationDate?: string; markdownPercentage?: number };
  stock?: number;
  bargainPrice?: { priceWas?: string; priceNow?: string };
}

/** Marked-down items ("Koopjes") in one store, for a signed-in member. */
export async function lastChance(ctx: AppContext, storeId: number) {
  const data = await ctx.ah.graphql<{ bargainItems: RawBargain[] | null }>(
    `query BargainItems($storeId: String!) {
      bargainItems(storeId: $storeId) {
        product { id title brand salesUnitSize }
        categoryTitle
        markdown { markdownType markdownExpirationDate markdownPercentage }
        stock
        bargainPrice { priceWas priceNow }
      }
    }`,
    { storeId: String(storeId) },
    { auth: 'user' },
  );
  const items = (data.bargainItems ?? []).map((b) => ({
    productId: b.product?.id,
    title: b.product?.title,
    brand: b.product?.brand,
    unitSize: b.product?.salesUnitSize,
    category: b.categoryTitle,
    priceNow: b.bargainPrice?.priceNow ? Number(b.bargainPrice.priceNow) : undefined,
    priceWas: b.bargainPrice?.priceWas ? Number(b.bargainPrice.priceWas) : undefined,
    discountPercent: b.markdown?.markdownPercentage,
    expires: b.markdown?.markdownExpirationDate,
    stock: b.stock,
  }));
  return { storeId, count: items.length, items };
}
